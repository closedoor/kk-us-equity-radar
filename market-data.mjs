const DAY_MS = 86_400_000;

function isoDate(year, month, day) {
  if (![year, month, day].every(Number.isInteger)) return null;
  const candidate = new Date(Date.UTC(year, month - 1, day));
  if (candidate.getUTCFullYear() !== year || candidate.getUTCMonth() + 1 !== month || candidate.getUTCDate() !== day) return null;
  return `${year}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
}

function validIsoDate(value) {
  const match = String(value || "").match(/^(\d{4})-(\d{2})-(\d{2})$/);
  return Boolean(match && isoDate(Number(match[1]), Number(match[2]), Number(match[3])) === match[0]);
}

export function parseFredCsv(csv) {
  const lines = String(csv || "").trim().split(/\r?\n/);
  if (lines.length < 2) return [];
  return lines.slice(1).map((line) => {
    const comma = line.indexOf(",");
    if (comma <= 0) return null;
    const date = line.slice(0, comma);
    const raw = line.slice(comma + 1).trim();
    if (!validIsoDate(date) || !raw || raw === "." || raw.toLowerCase() === "na") return null;
    const value = Number(raw);
    return Number.isFinite(value) ? { date, value } : null;
  }).filter(Boolean).sort((a, b) => a.date.localeCompare(b.date));
}

function parseNasdaqDate(value) {
  const match = String(value || "").trim().match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})$/);
  return match ? isoDate(Number(match[3]), Number(match[1]), Number(match[2])) : null;
}

export function parseNasdaqRows(rows) {
  if (!Array.isArray(rows)) return [];
  return rows.map((row) => {
    const date = parseNasdaqDate(row?.date);
    const value = Number(String(row?.close).replace(/[$,]/g, ""));
    return date && Number.isFinite(value) && value > 0 ? { date, value } : null;
  }).filter(Boolean).sort((a, b) => a.date.localeCompare(b.date));
}

export function requireFreshSeries(series, { name, maxAgeDays, now = new Date() }) {
  if (!Array.isArray(series) || !series.length) throw new Error(`${name} 没有可用数据`);
  const latestDate = series.reduce((latest, point) => point.date > latest ? point.date : latest, "");
  if (!validIsoDate(latestDate)) throw new Error(`${name} 最新日期格式无效`);
  const todayUtc = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate());
  const ageDays = Math.floor((todayUtc - Date.parse(`${latestDate}T00:00:00Z`)) / DAY_MS);
  if (ageDays < -1) throw new Error(`${name} 返回了未来日期 ${latestDate}`);
  if (ageDays > maxAgeDays) throw new Error(`${name} 最新数据停留在 ${latestDate}（${ageDays} 天前）`);
  return series;
}

function monthlyPoint(series, monthsAgo) {
  const latest = series?.at(-1);
  if (!validIsoDate(latest?.date) || !Number.isInteger(monthsAgo) || monthsAgo < 0) return null;
  const [year, month] = latest.date.split("-").map(Number);
  // Anchor to the first day so month-end dates cannot overflow into another month.
  const target = new Date(Date.UTC(year, month - 1 - monthsAgo, 1)).toISOString().slice(0, 7);
  return series.find((point) => point.date.slice(0, 7) === target && Number.isFinite(point.value)) || null;
}

export function monthlyPercentChange(series, months = 1, offset = 0) {
  const current = monthlyPoint(series, offset);
  const previous = monthlyPoint(series, months + offset);
  return current && previous && previous.value > 0
    ? (current.value / previous.value - 1) * 100
    : null;
}

export function monthlyAnnualizedChange(series, months) {
  const change = monthlyPercentChange(series, months);
  return Number.isFinite(change) && months > 0 ? ((1 + change / 100) ** (12 / months) - 1) * 100 : null;
}

export function monthlyDifference(series, months = 1) {
  const current = monthlyPoint(series, 0);
  const previous = monthlyPoint(series, months);
  return current && previous ? current.value - previous.value : null;
}

export function nearestPrior(series, daysAgo) {
  if (!series?.length) return null;
  const target = Date.parse(series.at(-1).date) - daysAgo * DAY_MS;
  let best = null;
  for (const point of series) {
    if (Date.parse(point.date) <= target) best = point;
    else break;
  }
  return best;
}
