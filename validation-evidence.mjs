import { createHash } from "node:crypto";
import { equityCloseMinute } from "./public/us-equity-session.js";
import { isDashboardSnapshot } from "./public/dashboard-state.js";
import { computeScores, INDICATOR_WEIGHTS, MIN_SCORE_COVERAGE, SCORING_VERSION } from "./public/risk-model.js";

const DAY_MS = 86_400_000;
const CAPTURE_POLICY = "nyse-post-close-v1";
const nyClock = new Intl.DateTimeFormat("en-CA", { timeZone: "America/New_York", year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", hourCycle: "h23" });
export function captureWindow(at) {
  const parts = Object.fromEntries(nyClock.formatToParts(new Date(at)).map(({ type, value }) => [type, value]));
  const date = `${parts.year}-${parts.month}-${parts.day}`;
  const close = equityCloseMinute(date);
  const minute = Number(parts.hour) * 60 + Number(parts.minute);
  return { date, state: close === null ? "unverified-calendar" : close === 0 ? "closed-session" : minute < close ? "before-session-close" : "post-close" };
}
const validDate = (value) => typeof value === "string" && /^\d{4}-\d{2}-\d{2}$/.test(value)
  && Number.isFinite(Date.parse(value)) && new Date(value).toISOString().slice(0, 10) === value;
const validTime = (value) => typeof value === "string" && Number.isFinite(Date.parse(value));
const digest = (value) => createHash("sha256").update(JSON.stringify(value)).digest("hex");

export function createEvidence(data, { capturedAt = new Date().toISOString(), source } = {}) {
  if (!isDashboardSnapshot(data) || !validTime(capturedAt)) throw new Error("Invalid dashboard or capture time");
  const now = Date.parse(capturedAt);
  const generated = Date.parse(data.generatedAt);
  const observation = captureWindow(now);
  if (observation.state !== "post-close") throw new Error(`Invalid session for new forward capture: ${observation.state}`);
  const generation = captureWindow(generated);
  if (generation.state !== "post-close" || generation.date !== observation.date) throw new Error("Snapshot must be generated after the same session close");
  if (generated > now + 60_000 || now - generated >= DAY_MS || data.cacheExpired || data.refreshing) throw new Error("Snapshot is expired, future-dated, or still refreshing");
  if (!/^\d+\.\d+\.\d+$/.test(data.scoringVersion || "")) throw new Error("Missing scoring version");
  if (data.indicators.some((row) => row.overridden || (row.available && row.confidence === "manual"))) throw new Error("Browser manual overrides cannot enter the automatic model sample");
  const reference = data.validationReference;
  if (!Object.hasOwn(data, "validationReference") || (reference !== null && (!reference || reference.series !== "SP500" || !validDate(reference.date) || !Number.isFinite(reference.close) || reference.close <= 0
    || equityCloseMinute(reference.date) === 0 || reference.date > observation.date))) throw new Error("Missing or invalid numeric market reference");
  if (data.scoringVersion !== SCORING_VERSION) throw new Error("Unsupported live scoring version; update the evidence recorder");
  const scoringContext = Object.fromEntries(["drawdownPercent", "breadthRiskPercent"].map(key => [key,
    Number.isFinite(data.scoringContext?.[key]) ? data.scoringContext[key] : null]));
  const calculated = computeScores(data.indicators, scoringContext);
  if (data.score !== calculated.score || data.coverage !== calculated.coverage) throw new Error("Inconsistent dashboard score or coverage; refusing to persist");
  const sourceUrl = new URL(source);
  if (!new Set(["https:", "http:"]).has(sourceUrl.protocol) || sourceUrl.username || sourceUrl.password) throw new Error("Invalid evidence source URL");
  if (data.indicators.some(row => row.available && (!validDate(row.date) || row.date > observation.date))) throw new Error("Undated or future observation cannot enter evidence");
  const record = {
    version: 1,
    observationDate: observation.date,
    capturePolicy: CAPTURE_POLICY,
    capturedAt: new Date(now).toISOString(),
    generatedAt: new Date(generated).toISOString(),
    scoringVersion: data.scoringVersion,
    producer: { productVersion: data.productVersion || null, buildCommit: data.buildCommit || null, dataQualityVersion: data.dataQualityVersion || null },
    source: sourceUrl.href,
    scoringContext,
    score: calculated.score,
    coverage: data.coverage,
    indicators: data.indicators.map(({ id, weight, available, risk, date }) => ({ id, weight, available, risk, date: date || null })),
    marketReference: reference === null ? null : { ...reference },
    publicationSchedule: data.publicationSchedule || null,
    sourceRevisions: data.sourceRevisions || [],
    errors: [...(data.errors || []), ...(data.publicationErrors || []), ...(data.earningsErrors || [])],
  };
  const result = { ...record, sha256: digest(record) };
  if (!isEvidence(result)) throw new Error("Inconsistent dashboard evidence; refusing to persist");
  return result;
}

export function isEvidence(record) {
  if (!record || record.version !== 1 || !validDate(record.observationDate) || !validTime(record.capturedAt) || !validTime(record.generatedAt)
    || captureWindow(record.capturedAt).date !== record.observationDate || !/^\d+\.\d+\.\d+$/.test(record.scoringVersion || "")
    || !(record.score === null || (Number.isFinite(record.score) && record.score >= 0 && record.score <= 100))
    || !Number.isFinite(record.coverage) || record.coverage < 0 || record.coverage > 100
    || Date.parse(record.generatedAt) > Date.parse(record.capturedAt) + 60_000
    || Date.parse(record.capturedAt) - Date.parse(record.generatedAt) >= DAY_MS
    || (record.coverage < MIN_SCORE_COVERAGE && record.score !== null)
    || !Array.isArray(record.indicators) || record.indicators.length !== 12
    || new Set(record.indicators.map((row) => row?.id)).size !== 12
    || record.indicators.some(row => !row || !Object.hasOwn(INDICATOR_WEIGHTS, row.id) || row.weight !== INDICATOR_WEIGHTS[row.id]
      || typeof row.available !== "boolean" || (row.available ? !Number.isFinite(row.risk) || row.risk < 0 || row.risk > 100 : row.risk !== null)
      || (row.date !== null && !validDate(row.date)) || (row.available && row.date && row.date > record.observationDate))
    || record.indicators.reduce((sum, row) => sum + (row.available ? row.weight : 0), 0) !== record.coverage
    || (record.marketReference !== null && (record.marketReference?.series !== "SP500" || !validDate(record.marketReference.date)
      || record.marketReference.date > record.observationDate || !(record.marketReference.close > 0) || !Number.isFinite(record.marketReference.close)))
    || !Array.isArray(record.errors)) return false;
  // Records written under the earlier sampling cadence retain their original timestamp and digest.
  if (Object.hasOwn(record, "capturePolicy")) {
    const generated = captureWindow(record.generatedAt);
    if (record.capturePolicy !== CAPTURE_POLICY || captureWindow(record.capturedAt).state !== "post-close"
      || generated.state !== "post-close" || generated.date !== record.observationDate
      || record.indicators.some(row => row.available && !validDate(row.date))
      || (record.marketReference && equityCloseMinute(record.marketReference.date) === 0)) return false;
  }
  // Legacy observations did not retain the two inputs for the synergy adjustment.
  // Keep them readable and immutable; verify the arithmetic for new records.
  if (Object.hasOwn(record, "scoringContext") && record.scoringVersion === SCORING_VERSION) {
    const context = record.scoringContext;
    if (!context || !["drawdownPercent", "breadthRiskPercent"].every(k => Object.hasOwn(context, k)
      && (context[k] === null || Number.isFinite(context[k]))) || computeScores(record.indicators, context).score !== record.score) return false;
  }
  const { sha256, ...contents } = record;
  return typeof sha256 === "string" && sha256 === digest(contents);
}

function summarize(rows) {
  if (!rows.length) return { samples: 0, meanReturnPercent: null, meanDrawdownPercent: null, worstDrawdownPercent: null };
  return {
    samples: rows.length,
    meanReturnPercent: rows.reduce((sum, row) => sum + row.returnPercent, 0) / rows.length,
    meanDrawdownPercent: rows.reduce((sum, row) => sum + row.drawdownPercent, 0) / rows.length,
    worstDrawdownPercent: Math.max(...rows.map((row) => row.drawdownPercent)),
  };
}

export function evaluateEvidence(records, marketPrices, { horizons = [21, 63], scoringVersion, asOf = new Date().toISOString() } = {}) {
  if (!Array.isArray(records) || records.some((row) => !isEvidence(row))) throw new Error("Corrupt forward evidence");
  if (!validTime(asOf) || records.some(row => Date.parse(row.capturedAt) > Date.parse(asOf))) throw new Error("Future evidence cannot have an observed outcome");
  if (!horizons.length || horizons.some((value) => !Number.isInteger(value) || value < 1)) throw new Error("Invalid trading-day horizon");
  const cutoff = captureWindow(asOf);
  const byDate = new Map();
  for (const point of marketPrices) {
    if (!validDate(point?.date) || !Number.isFinite(point.value) || point.value <= 0) throw new Error("Invalid benchmark price");
    if (point.date > cutoff.date || (point.date === cutoff.date && cutoff.state !== "post-close")) throw new Error("Future benchmark close cannot be an observed outcome");
    if (equityCloseMinute(point.date) === 0) throw new Error("Benchmark close on a closed NYSE session");
    if (byDate.has(point.date) && byDate.get(point.date).value !== point.value) throw new Error("Conflicting benchmark close");
    byDate.set(point.date, point);
  }
  const unique = new Map();
  for (const record of [...records].sort((a, b) => Date.parse(a.capturedAt) - Date.parse(b.capturedAt))) {
    const key = `${record.scoringVersion}:${record.observationDate}`;
    if (!unique.has(key)) unique.set(key, record); // One first observation per NY date and model version.
  }
  const selected = [...unique.values()].filter((row) => !scoringVersion || row.scoringVersion === scoringVersion);
  const versions = [...new Set(selected.map((row) => row.scoringVersion))];
  if (versions.length > 1) throw new Error("Select one scoring version before evaluating evidence");
  const outcomes = horizons.map((tradingDays) => {
    let immature = 0;
    let unavailableScore = 0;
    let incompleteBenchmark = 0;
    const rows = [];
    for (const record of selected) {
      if (record.score === null) { unavailableScore += 1; continue; }
      // Count scheduled US equity sessions, not arbitrary consecutive rows in a CSV.
      // A missing entry, exit or intervening close makes the entire outcome unknown.
      const days = [];
      const cursor = new Date(record.observationDate + "T00:00:00Z");
      let incompleteCalendar = false;
      while (days.length <= tradingDays) {
        cursor.setUTCDate(cursor.getUTCDate() + 1);
        const date = cursor.toISOString().slice(0, 10);
        if (date > cutoff.date || (date === cutoff.date && cutoff.state !== "post-close")) break;
        const close = equityCloseMinute(date);
        if (close === null) { incompleteCalendar = true; break; }
        if (close > 0) days.push(date);
      }
      if (incompleteCalendar) { incompleteBenchmark += 1; continue; }
      if (days.length < tradingDays + 1) { immature += 1; continue; }
      const window = days.map(date => byDate.get(date));
      if (window.some(point => !point)) { incompleteBenchmark += 1; continue; }
      let peak = window[0].value;
      let drawdownPercent = 0;
      for (const point of window) {
        peak = Math.max(peak, point.value);
        drawdownPercent = Math.max(drawdownPercent, (1 - point.value / peak) * 100);
      }
      rows.push({ observationDate: record.observationDate, scoringVersion: record.scoringVersion, score: record.score, coverage: record.coverage,
        entryDate: window[0].date, exitDate: window.at(-1).date,
        returnPercent: (window.at(-1).value / window[0].value - 1) * 100, drawdownPercent });
    }
    const bands = [[0, 20], [20, 40], [40, 60], [60, 75], [75, 100]].map(([lower, upper], index) => ({
      lower, upper, lowerInclusive: index === 0,
      ...summarize(rows.filter((row) => (index === 0 ? row.score >= lower : row.score > lower) && row.score <= upper)),
    }));
    return { tradingDays, immatureSamples: immature, unavailableScoreSamples: unavailableScore, incompleteBenchmarkSamples: incompleteBenchmark, ...summarize(rows), bands, outcomes: rows };
  });
  return {
    version: 1,
    evaluatedAt: new Date(asOf).toISOString(),
    status: outcomes.some((row) => row.samples > 0) ? "descriptive-only" : "awaiting-outcomes",
    scoringVersions: versions,
    observedSamples: selected.length,
    firstObservationDate: selected[0]?.observationDate || null,
    lastObservationDate: selected.at(-1)?.observationDate || null,
    outcomes,
    limitations: ["前瞻样本从实际抓取日开始，不补造过去判断。", "新版只在纽约已核对的交易日收盘后采集，较早的留存记录保留原采集时间。", "从观察日之后首个交易日收盘起算，按已核对的交易日历计数；缺少任一应有收盘或日历未经核对时不计算结果。", "每日窗口互相重叠，样本并不独立；统计为描述结果，未校准概率或交易收益。", "价格指数不含分红、交易成本或仓位策略。"],
  };
}
