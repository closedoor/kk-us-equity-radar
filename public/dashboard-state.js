import { computeScores, actionFor } from "./risk-model.js";

export const MAX_MARKET_CACHE_AGE_MS = 24 * 60 * 60 * 1000;

export function isDashboardSnapshot(data) {
  return Boolean(data && Number.isFinite(Date.parse(data.generatedAt)) && Number.isFinite(data.coverage)
    && Array.isArray(data.aiEarnings) && Array.isArray(data.categories) && data.categories.every((row) => typeof row?.name === "string")
    && Array.isArray(data.indicators) && data.indicators.length
    && data.indicators.every((row) => typeof row?.id === "string" && Number.isFinite(row.weight)
      && (row.risk === null || Number.isFinite(row.risk)) && (row.points === null || Number.isFinite(row.points))));
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
    return { ...row, snapshotStale, snapshotAgeDays: age, snapshotLabel: snapshotStale ? "财报解读待更新" : `资料截至 ${row.released}` };
  });
}

export function resolveAiIndicator(template, rows) {
  const toneRisk = { positive: 0.12, mixed: 0.34, negative: 0.75 };
  const current = rows.filter((row) => !row.snapshotStale && Object.hasOwn(toneRisk, row.guidanceTone));
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
  const aiEarnings = resolveAiSnapshots(data.aiEarnings, nowMs);
  const indicators = data.indicators.map((item) => {
    if (item.id === "aiEarnings") return resolveAiIndicator(item, aiEarnings);
    if (!expired || !item.available) return { ...item };
    return { ...item, risk: null, points: null, available: false, status: "unavailable", unavailableReason: "缓存已过期" };
  });
  const { available, ...model } = computeScores(indicators, data.scoringContext);
  const categories = data.categories.map((category) => {
    const items = available.filter((item) => item.category === category.name);
    const weight = items.reduce((sum, item) => sum + item.weight, 0);
    return { ...category, weight, score: weight ? Math.round(items.reduce((sum, item) => sum + item.points, 0) / weight * 1000) / 10 : null };
  });
  return { ...data, ...model, aiEarnings, indicators, categories, cacheAgeMs, stale: expired || cacheAgeMs >= 15 * 60_000, cacheExpired: expired, action: actionFor(model.score, model.coverage) };
}
