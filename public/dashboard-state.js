import { computeScores, actionFor, INDICATOR_WEIGHTS, normalizeIndicator, SCORING_VERSION, SCORING_NOTE } from "./risk-model.js";
import { applyPublicationChecks, isPublicationSchedule } from "./publication-state.js";
import { applyEarningsChecks, isEarningsSchedule } from "./earnings-state.js";

export const MAX_MARKET_CACHE_AGE_MS = 24 * 60 * 60 * 1000;

export function isDashboardSnapshot(data) {
  const object = (row) => row !== null && typeof row === "object" && !Array.isArray(row);
  const rows = (value, check) => Array.isArray(value) && value.every(check);
  const optionalRows = (value, check) => value === undefined || rows(value, check);
  const textFields = (row, keys) => keys.every((key) => row[key] == null || typeof row[key] === "string");
  const optionalObject = (value, check) => value == null || (object(value) && check(value));
  const timestamp = (value) => value == null || (typeof value === "string" && Number.isFinite(Date.parse(value)));
  const calendarSources = (value) => optionalObject(value, (sources) => Object.values(sources).every((source) => object(source)
    && textFields(source, ["mode", "url", "cpiUrl", "employmentUrl", "error"]) && timestamp(source.lastSuccessAt)));
  const calendarSchedule = (schedule) => timestamp(schedule.updatedAt) && calendarSources(schedule.sources)
    && optionalRows(schedule.cpi, (event) => object(event) && validDate(event.date) && textFields(event, ["period"]))
    && optionalRows(schedule.employment, (event) => object(event) && validDate(event.date) && textFields(event, ["period"]))
    && optionalRows(schedule.fomc, (event) => object(event) && validDate(event.date) && validDate(event.startDate)
      && (event.projections === undefined || typeof event.projections === "boolean"))
    && optionalObject(schedule.earnings, (events) => Object.values(events).every((event) => object(event) && validDate(event.date)
      && textFields(event, ["timing", "status", "reportText"])))
    && optionalObject(schedule.pastEarnings, (events) => Object.values(events).every(validDate));
  const company = (row) => object(row) && typeof row.ticker === "string" && row.ticker.length > 0
    && textFields(row, ["company", "layer", "period", "role", "impact", "released", "revenue", "netIncome", "marginLabel", "grossMargin", "resultTone", "resultAssessment", "guidanceTone", "guidanceAssessment", "guidance", "guidanceSource", "note", "source", "nextReportDate", "nextReportEstimatedDate", "nextReportLabel", "nextReportStatus", "nextReportBasis", "nextReportSource", "snapshotLabel", "snapshotValidThrough"])
    && (row.snapshotStale === undefined || typeof row.snapshotStale === "boolean");
  return Boolean(object(data) && typeof data.generatedAt === "string" && Number.isFinite(Date.parse(data.generatedAt))
    && Number.isFinite(data.coverage) && data.coverage >= 0 && data.coverage <= 100
    && (data.dataQualityVersion === undefined || (Number.isInteger(data.dataQualityVersion) && data.dataQualityVersion > 0))
    && (data.refreshing === undefined || typeof data.refreshing === "boolean")
    && (data.scoringContext === undefined || object(data.scoringContext))
    && optionalObject(data.validationReference, row => row.series === "SP500" && validDate(row.date) && Number.isFinite(row.close) && row.close > 0)
    && rows(data.aiEarnings, company)
    && data.aiEarnings.length > 0 && new Set(data.aiEarnings.map((row) => row.ticker)).size === data.aiEarnings.length
    && rows(data.categories, (row) => object(row) && typeof row.name === "string" && row.name.length > 0)
    && new Set(data.categories.map((row) => row.name)).size === data.categories.length
    && rows(data.indicators, (row) => object(row) && typeof row.id === "string" && Object.hasOwn(INDICATOR_WEIGHTS, row.id) && Number.isFinite(row.weight) && row.weight > 0
      && typeof row.available === "boolean" && typeof row.title === "string" && row.title.length > 0
      && textFields(row, ["value", "detail", "description", "why", "date", "status", "confidence", "cadence", "unavailableReason"])
      && optionalObject(row.source, (source) => textFields(source, ["url", "label"]))
      && optionalObject(row.judgment, (judgment) => textFields(judgment, ["tone", "label", "text"]))
      && (row.inputDates === undefined || (object(row.inputDates) && Object.keys(row.inputDates).length === 2
        && ["headlinePce", "corePce"].every(key => Object.hasOwn(row.inputDates, key) && (row.inputDates[key] === null || validDate(row.inputDates[key])))))
      && (row.available ? Number.isFinite(row.risk) : row.risk === null)
      && data.categories.some((category) => category.name === row.category)
      && (row.risk === null || (Number.isFinite(row.risk) && row.risk >= 0 && row.risk <= 100))
      && (row.points === null || Number.isFinite(row.points))
      && optionalRows(row.sparkline, (point) => object(point) && (point.value == null || Number.isFinite(point.value)))
      && (row.breakdown == null || rows(row.breakdown, (metric) => object(metric) && textFields(metric, ["label", "value", "detail"]))))
    && data.indicators.length === Object.keys(INDICATOR_WEIGHTS).length
    && new Set(data.indicators.map((row) => row.id)).size === data.indicators.length
    && optionalRows(data.aiChainLayers, (row) => object(row) && textFields(row, ["name", "description"]) && rows(row.tickers, (ticker) => typeof ticker === "string"))
    && optionalRows(data.reminders, (row) => object(row) && textFields(row, ["label", "event", "source", "linkLabel", "indicatorId"])
      && (row.date == null || validDate(row.date)) && optionalRows(row.companies, (item) => object(item) && textFields(item, ["ticker", "released", "next", "status", "basis", "source"])))
    && optionalObject(data.calendarSchedule, calendarSchedule)
    && (data.publicationSchedule == null || isPublicationSchedule(data.publicationSchedule))
    && (data.earningsSchedule == null || isEarningsSchedule(data.earningsSchedule))
    && optionalObject(data.calendarSync, (sync) => timestamp(sync.updatedAt) && calendarSources(sync.sources))
    && optionalRows(data.sourceRevisions, row => object(row) && typeof row.series === "string" && /^[A-Z0-9]+$/.test(row.series)
      && textFields(row, ["label"]) && validDate(row.date) && Number.isFinite(row.before) && Number.isFinite(row.after)
      && typeof row.firstDetectedAt === "string" && timestamp(row.firstDetectedAt))
    && optionalRows(data.errors, (error) => typeof error === "string"));
}

function marketDate(nowMs) {
  const parts = new Intl.DateTimeFormat("en-CA", { timeZone: "America/New_York", year: "numeric", month: "2-digit", day: "2-digit" }).formatToParts(new Date(nowMs));
  const values = Object.fromEntries(parts.map(({ type, value }) => [type, value]));
  return `${values.year}-${values.month}-${values.day}`;
}

function validDate(value) {
  return typeof value === "string" && /^\d{4}-\d{2}-\d{2}$/.test(value)
    && Number.isFinite(Date.parse(value)) && new Date(value).toISOString().slice(0, 10) === value;
}

export function checkPolicyBounds(lower, upper) {
  const complete = lower && upper && validDate(lower.date) && validDate(upper.date)
    && Number.isFinite(lower.value) && Number.isFinite(upper.value);
  if (!complete) return { valid: false, reason: null, error: null };
  if (lower.date !== upper.date) return {
    valid: false,
    reason: "政策区间待同步",
    error: `联邦基金目标区间日期不同（下限 ${lower.date}，上限 ${upper.date}），等待同日同步，暂停政策评分`,
  };
  if (lower.value > upper.value) return {
    valid: false,
    reason: "政策区间无效",
    error: "联邦基金目标区间无效：下限高于上限，暂停政策评分",
  };
  return { valid: true, reason: null, error: null };
}

function savedPolicyBounds(item) {
  const bound = (label) => {
    const rows = item.breakdown?.filter((row) => row.label === label) || [];
    if (rows.length !== 1 || !validDate(rows[0].detail) || typeof rows[0].value !== "string"
      || !/^[+-]?\d+(?:\.\d+)?%$/.test(rows[0].value)) return null;
    return { date: rows[0].detail, value: Number(rows[0].value.slice(0, -1)) };
  };
  return checkPolicyBounds(bound("政策目标下限"), bound("政策目标上限"));
}

export function cacheExpired(data, nowMs = Date.now()) {
  const generatedAt = Date.parse(data?.generatedAt);
  return !Number.isFinite(generatedAt) || generatedAt > nowMs + 60_000 || nowMs - generatedAt >= MAX_MARKET_CACHE_AGE_MS;
}

export function shouldReplaceDashboard(current, next, nowMs = Date.now()) {
  return !current || !next.errors?.length || next.coverage >= current.coverage || cacheExpired(current, nowMs);
}

export function resolveAiSnapshots(rows = [], nowMs = Date.now()) {
  const today = marketDate(nowMs);
  return rows.map((row) => {
    const age = validDate(row.released) ? Math.floor((Date.parse(today) - Date.parse(row.released)) / 86_400_000) : null;
    const snapshotStale = Boolean(row.snapshotStale) || !Number.isFinite(age) || age < 0 || age > 120
      || (validDate(row.snapshotValidThrough) && today > row.snapshotValidThrough);
    const nextDate = row.nextReportDate || row.nextReportEstimatedDate;
    const passed = validDate(nextDate) && nextDate < today;
    return {
      ...row,
      ...(passed ? { nextReportDate: null, nextReportEstimatedDate: null, nextReportLabel: "待核对下一期日程", nextReportStatus: "pending", nextReportBasis: null } : {}),
      snapshotStale, snapshotAgeDays: age, snapshotLabel: Number.isFinite(age) && age >= 0 ? `资料截至 ${row.released}` : "资料日期待核对",
    };
  });
}

function resolveReminders(rows = [], aiEarnings, nowMs) {
  const today = marketDate(nowMs);
  const companies = new Map(aiEarnings.map((row) => [row.ticker, row]));
  return rows.map((row) => {
    if (row.companies) return { ...row, companies: row.companies.map((company) => {
      const report = companies.get(company.ticker);
      return report ? { ...company, next: report.nextReportLabel || report.nextReportDate, status: report.nextReportStatus, basis: report.nextReportBasis, source: report.nextReportSource || null } : { ...company };
    }) };
    if (validDate(row.date) && row.date < today) {
      return { ...row, date: null, scheduleStatus: "pending", event: "上期日程已过，待同步下一期安排" };
    }
    return { ...row };
  });
}

export function resolveAiIndicator(template, rows) {
  const toneRisk = { positive: 0.12, mixed: 0.34, negative: 0.75 };
  const current = rows.filter((row) => !row.snapshotStale && !row.reviewRequired && Object.hasOwn(toneRisk, row.guidanceTone));
  const available = current.length >= 3;
  const risk = available ? Math.min(100, (current.reduce((sum, row) => sum + toneRisk[row.guidanceTone], 0) / current.length + 0.03) * 100) : null;
  const latest = [...current].sort((a, b) => a.released.localeCompare(b.released)).at(-1);
  return {
    ...template,
    risk: available ? Math.round(risk * 10) / 10 : null,
    points: available ? Math.round(risk * template.weight) / 100 : null,
    available,
    status: !available ? "unavailable" : risk >= 80 ? "critical" : risk >= 55 ? "high" : risk >= 30 ? "watch" : "low",
    value: `${current.length} / ${rows.length} 家`,
    date: latest?.released || null,
    unavailableReason: available ? null : "有效财报不足",
    source: latest?.source ? { ...template.source, url: latest.source } : template.source,
  };
}

export function projectDashboard(data, nowMs = Date.now()) {
  const expired = cacheExpired(data, nowMs);
  const cacheAgeMs = Math.max(0, nowMs - Date.parse(data.generatedAt)) || 0;
  const earnings = applyEarningsChecks(data.aiEarnings, data.earningsSchedule, nowMs);
  const aiEarnings = resolveAiSnapshots(earnings.aiEarnings, nowMs);
  const reminders = resolveReminders(data.reminders, aiEarnings, nowMs);
  const policyErrors = [];
  const policyIndicators = data.indicators.map((item) => {
    if (item.id !== "fed") return item;
    const bounds = savedPolicyBounds(item);
    if (!bounds.error) return item;
    policyErrors.push(bounds.error);
    return { ...item, available: false, risk: null, points: null, status: "unavailable", confidence: "unavailable",
      unavailableReason: bounds.reason, value: bounds.reason, judgment: null,
      detail: [bounds.reason, ...(item.detail || "").split("；").slice(1)].join("；") };
  });
  const publication = applyPublicationChecks(policyIndicators, data.publicationSchedule, nowMs);
  const indicators = publication.indicators.map((previous) => {
    const item = { ...previous, weight: INDICATOR_WEIGHTS[previous.id] ?? previous.weight };
    if (item.id === "aiEarnings") return resolveAiIndicator(item, aiEarnings);
    if (!expired || !item.available) return { ...item };
    return { ...item, risk: null, points: null, available: false, status: "unavailable", unavailableReason: "缓存已过期" };
  }).map(normalizeIndicator);
  const { available, ...model } = computeScores(indicators, data.scoringContext);
  const categories = data.categories.map((category) => {
    const items = available.filter((item) => item.category === category.name);
    const weight = items.reduce((sum, item) => sum + item.weight, 0);
    return { ...category, weight, score: weight ? Math.round(items.reduce((sum, item) => sum + item.points, 0) / weight * 1000) / 10 : null };
  });
  return { ...data, ...model, aiEarnings, reminders, indicators, categories, errors: [...new Set([...(data.errors || []), ...policyErrors])], publicationChecks: publication.checks, publicationErrors: publication.errors,
    earningsChecks: earnings.checks, earningsErrors: earnings.errors, cacheAgeMs, stale: expired || cacheAgeMs >= 15 * 60_000, cacheExpired: expired,
    methodology: { ...data.methodology, version: SCORING_VERSION, note: SCORING_NOTE }, action: actionFor(model.score, model.coverage) };
}
