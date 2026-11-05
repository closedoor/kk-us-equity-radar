import { createHash } from "node:crypto";
import { isDashboardSnapshot } from "./public/dashboard-state.js";
import { INDICATOR_WEIGHTS, MIN_SCORE_COVERAGE } from "./public/risk-model.js";

const DAY_MS = 86_400_000;
const nyDate = (value) => new Intl.DateTimeFormat("en-CA", { timeZone: "America/New_York", year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date(value));
const validDate = (value) => typeof value === "string" && /^\d{4}-\d{2}-\d{2}$/.test(value)
  && Number.isFinite(Date.parse(value)) && new Date(value).toISOString().slice(0, 10) === value;
const validTime = (value) => typeof value === "string" && Number.isFinite(Date.parse(value));
const digest = (value) => createHash("sha256").update(JSON.stringify(value)).digest("hex");

export function createEvidence(data, { capturedAt = new Date().toISOString(), source } = {}) {
  if (!isDashboardSnapshot(data) || !validTime(capturedAt)) throw new Error("Invalid dashboard or capture time");
  const now = Date.parse(capturedAt);
  const generated = Date.parse(data.generatedAt);
  if (generated > now + 60_000 || now - generated >= DAY_MS || data.cacheExpired || data.refreshing) throw new Error("Snapshot is expired, future-dated, or still refreshing");
  if (!/^\d+\.\d+\.\d+$/.test(data.scoringVersion || "")) throw new Error("Missing scoring version");
  if (data.indicators.some((row) => row.overridden || (row.available && row.confidence === "manual"))) throw new Error("Browser manual overrides cannot enter the automatic model sample");
  const reference = data.validationReference;
  if (!Object.hasOwn(data, "validationReference") || (reference !== null && (!reference || reference.series !== "SP500" || !validDate(reference.date) || !Number.isFinite(reference.close) || reference.close <= 0
    || reference.date > nyDate(capturedAt)))) throw new Error("Missing or invalid numeric market reference");
  const sourceUrl = new URL(source);
  if (!new Set(["https:", "http:"]).has(sourceUrl.protocol) || sourceUrl.username || sourceUrl.password) throw new Error("Invalid evidence source URL");
  if (data.indicators.some(row => row.available && validDate(row.date) && row.date > nyDate(capturedAt))) throw new Error("Future observation cannot enter evidence");
  const record = {
    version: 1,
    observationDate: nyDate(capturedAt),
    capturedAt: new Date(now).toISOString(),
    generatedAt: new Date(generated).toISOString(),
    scoringVersion: data.scoringVersion,
    producer: { productVersion: data.productVersion || null, buildCommit: data.buildCommit || null, dataQualityVersion: data.dataQualityVersion || null },
    source: sourceUrl.href,
    score: Number.isFinite(data.score) ? data.score : null,
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
    || nyDate(record.capturedAt) !== record.observationDate || !/^\d+\.\d+\.\d+$/.test(record.scoringVersion || "")
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
  const byDate = new Map();
  for (const point of marketPrices) {
    if (!validDate(point?.date) || !Number.isFinite(point.value) || point.value <= 0) throw new Error("Invalid benchmark price");
    if (point.date > nyDate(asOf)) throw new Error("Future benchmark price cannot be an observed outcome");
    if (byDate.has(point.date) && byDate.get(point.date).value !== point.value) throw new Error("Conflicting benchmark close");
    byDate.set(point.date, point);
  }
  const prices = [...byDate.values()].sort((left, right) => left.date.localeCompare(right.date));
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
    const rows = [];
    for (const record of selected) {
      if (record.score === null) { unavailableScore += 1; continue; }
      // A historical cached close can precede capture. It must never become a retroactive entry.
      // Use the first observed market close strictly after the capture's New York date.
      const entry = prices.findIndex((point) => point.date > record.observationDate);
      if (entry < 0 || entry + tradingDays >= prices.length) { immature += 1; continue; }
      const window = prices.slice(entry, entry + tradingDays + 1);
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
    return { tradingDays, immatureSamples: immature, unavailableScoreSamples: unavailableScore, ...summarize(rows), bands, outcomes: rows };
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
    limitations: ["前瞻样本从实际抓取日开始，不补造过去判断。", "下一纽约日期之后首个实际市场收盘价作为起点；按实际价格观察计交易日。", "每日窗口互相重叠，样本并不独立；统计为描述结果，未校准概率或交易收益。", "价格指数不含分红、交易成本或仓位策略。"],
  };
}
