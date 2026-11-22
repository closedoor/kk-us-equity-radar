import { equityCloseMinute } from "./public/us-equity-session.js";

const nyClock = new Intl.DateTimeFormat("en-US", {
  timeZone: "America/New_York", year: "numeric", month: "2-digit", day: "2-digit",
  hourCycle: "h23", hour: "2-digit", minute: "2-digit",
});
const DAY_MS = 86_400_000;

export const fredMaxAgeDays = {
  DCOILBRENTEU: 14,
  CPIAUCSL: 75,
  CPIAUCNS: 75,
  CPILFESL: 75,
  CPILFENS: 75,
  // FRED dates PCE at the period's first day; BEA releases it near the next month's end.
  PCEPI: 100,
  PCEPILFE: 100,
  DFEDTARL: 14,
  DFEDTARU: 14,
  DGS2: 14,
  DGS10: 14,
  DFII10: 14,
  T10Y3M: 14,
  VIXCLS: 14,
  SP500: 14,
  BAMLH0A0HYM2: 14,
  DRTSCILM: 180,
  SAHMREALTIME: 75,
  ICSA: 21,
  NFCI: 21,
  UNRATE: 75,
  PAYEMS: 75,
};

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

function uniqueObservations(rows) {
  const dates = new Map();
  for (const row of rows) {
    if (dates.has(row.date) && dates.get(row.date).value !== row.value) throw new Error(`${row.date} 存在冲突的数据记录`);
    dates.set(row.date, row);
  }
  return [...dates.values()].sort((a, b) => a.date.localeCompare(b.date));
}

export function parseFredCsv(csv, expectedSeries) {
  const lines = String(csv || "").trim().split(/\r?\n/);
  if (expectedSeries !== undefined) {
    const columns = lines[0].split(",").map((value) => value.trim());
    if (columns.length !== 2 || !/^(?:date|observation_date)$/i.test(columns[0]) || columns[1] !== expectedSeries) {
      throw new Error(`FRED 返回的列名与请求序列 ${expectedSeries} 不符`);
    }
  }
  if (lines.length < 2) return [];
  return uniqueObservations(lines.slice(1).map((line) => {
    const comma = line.indexOf(",");
    if (comma <= 0) return null;
    const date = line.slice(0, comma);
    const raw = line.slice(comma + 1).trim();
    if (!validIsoDate(date) || !raw || raw === "." || raw.toLowerCase() === "na") return null;
    const value = Number(raw);
    return Number.isFinite(value) ? { date, value } : null;
  }).filter(Boolean));
}

function parseNasdaqDate(value) {
  const match = String(value || "").trim().match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})$/);
  return match ? isoDate(Number(match[3]), Number(match[1]), Number(match[2])) : null;
}

export function parseNasdaqRows(rows) {
  if (!Array.isArray(rows)) return [];
  return uniqueObservations(rows.map((row) => {
    const date = parseNasdaqDate(row?.date);
    const value = Number(String(row?.close).replace(/[$,]/g, ""));
    return date && Number.isFinite(value) && value > 0 ? { date, value } : null;
  }).filter(Boolean));
}

export function relativePerformance(reference, comparison, periods = 60) {
  if (!Array.isArray(reference) || !Array.isArray(comparison) || !Number.isInteger(periods) || periods < 1) return null;
  if (!reference.length || !comparison.length) return null;
  const comparisonByDate = new Map(comparison.map((point) => [point.date, point.value]));
  const endDate = reference.at(-1).date < comparison.at(-1).date ? reference.at(-1).date : comparison.at(-1).date;
  const end = reference.findIndex((point) => point.date === endDate);
  const first = reference[end - periods];
  const last = reference[end];
  if (!first || !last || !comparisonByDate.has(endDate)) return null;
  const comparisonStart = comparisonByDate.get(first.date);
  const comparisonEnd = comparisonByDate.get(last.date);
  if (![first.value, last.value, comparisonStart, comparisonEnd].every((value) => Number.isFinite(value) && value > 0)) return null;
  return {
    startDate: first.date,
    date: last.date,
    value: (comparisonEnd / comparisonStart - last.value / first.value) * 100,
  };
}

export function requireFreshSeries(series, { name, maxAgeDays, dailyClose, now = new Date() }) {
  if (!Array.isArray(series) || !series.length) throw new Error(`${name} 没有可用数据`);
  const parts = Object.fromEntries(nyClock.formatToParts(now).map(({ type, value }) => [type, value]));
  const today = `${parts.year}-${parts.month}-${parts.day}`;
  const latest = (rows) => rows.reduce((date, row) => row.date > date ? row.date : date, "");
  const reportedDate = latest(series);
  if (!validIsoDate(reportedDate)) throw new Error(`${name} 最新日期格式无效`);
  if (reportedDate > today) throw new Error(`${name} 返回了未来日期 ${reportedDate}（纽约日期 ${today}）`);
  let rows = series;
  if (dailyClose) {
    const minutes = Number(parts.hour) * 60 + Number(parts.minute);
    rows = series.filter(({ date }) => {
      const weekday = new Date(date + "T00:00:00Z").getUTCDay();
      if (weekday === 0 || weekday === 6) return false;
      const close = equityCloseMinute(date);
      if (dailyClose === "cash" && close === 0) return false;
      if (date !== today) return true;
      // Cboe may publish historical observations on US cash holidays (global trading).
      // A date without a time of day cannot prove today's final close. For an
      // unknown or non-cash session, wait for a subsequent New York date.
      return close > 0 && minutes >= close + (dailyClose === "vix" ? 15 : 0);
    });
    if (!rows.length) throw new Error(`${name} 暂无已完成交易时段的日度收盘数据`);
    if (rows.some(({ value }) => !Number.isFinite(value) || value <= 0)) throw new Error(`${name} 含有无效或非正的收盘值`);
  }
  const latestDate = latest(rows);
  const ageDays = (Date.parse(today) - Date.parse(latestDate)) / DAY_MS;
  if (ageDays > maxAgeDays) throw new Error(`${name} 最新数据停留在 ${latestDate}（${ageDays} 天前）`);
  return rows;
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
  if (!series?.length || !Number.isInteger(daysAgo) || daysAgo < 1) return null;
  const target = Date.parse(series.at(-1).date) - daysAgo * DAY_MS;
  let best = null;
  for (const point of series) {
    if (Date.parse(point.date) <= target) best = point;
    else break;
  }
  // Daily rate and spread series may skip non-business days. Allow one calendar
  // week before the intended baseline, but no substitution from an older month.
  return best && target - Date.parse(best.date) <= 7 * DAY_MS ? best : null;
}
