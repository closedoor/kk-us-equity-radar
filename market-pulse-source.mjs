const SYMBOLS = new Set(["VIX", "VXSMH", "SPX", "RSP", "QQQ", "SMH"]);
export const MARKET_PULSE_BUDGET_MS = 10_000;

const DAY = 86_400_000;
const MAX_QUOTE_AGE = 7 * DAY; // Keep a genuine previous close across weekends and holidays.
const REGULAR_OPEN = 9 * 3600 + 30 * 60;
const CASH_CLOSE = 16 * 3600;
const INDEX_CLOSE_END = CASH_CLOSE + 16 * 60;
const NY = new Intl.DateTimeFormat("en-US", {
  timeZone: "America/New_York", hourCycle: "h23", year: "numeric", month: "2-digit", day: "2-digit",
  hour: "2-digit", minute: "2-digit", second: "2-digit",
});
const object = (value) => value !== null && typeof value === "object" && !Array.isArray(value);
const positive = (value) => Number.isFinite(value) && value > 0;

function validDate(date) {
  return typeof date === "string" && /^\d{4}-\d{2}-\d{2}$/.test(date) && Number(date.slice(0, 4)) >= 1900
    && Number.isFinite(Date.parse(date)) && new Date(date).toISOString().slice(0, 10) === date;
}

function nowInstant(now) {
  const value = now instanceof Date ? now.getTime() : typeof now === "number" ? now : Date.parse(now);
  if (!Number.isFinite(value) || !Number.isFinite(new Date(value).getTime())) throw new Error("Invalid quote verification time");
  return value;
}

function nyParts(instant) {
  const parts = Object.fromEntries(NY.formatToParts(new Date(instant)).map(({ type, value }) => [type, value]));
  return { date: `${parts.year}-${parts.month}-${parts.day}`, seconds: Number(parts.hour) * 3600 + Number(parts.minute) * 60 + Number(parts.second) };
}

function wireTime(value) {
  if (typeof value !== "string") return null;
  const match = /^(\d{4}-\d{2}-\d{2})T([01]\d|2[0-3]):([0-5]\d):([0-5]\d)(?:\.(\d{1,9}))?(Z|[+-](?:[01]\d|2[0-3]):[0-5]\d)$/.exec(value);
  if (!match || match[0] !== value || !validDate(match[1])) return null;
  const [, date, hour, minute, second, fraction = "", zone] = match;
  const milliseconds = Number(fraction.padEnd(3, "0").slice(0, 3));
  return Date.parse(`${date}T${hour}:${minute}:${second}.${String(milliseconds).padStart(3, "0")}${zone}`);
}

function weekday(date) {
  const day = new Date(`${date}T00:00:00Z`).getUTCDay();
  return day >= 1 && day <= 5;
}

function requireQuoteTime(instant, nowMs) {
  if (!Number.isFinite(instant) || instant > nowMs || nowMs - instant > MAX_QUOTE_AGE) throw new Error("Quote observation time is invalid, future, or too old");
  return nyParts(instant);
}

const LICENSED_MAX_BYTES = 65_536;

function licensedUrl(value, attribution = false) {
  if (typeof value !== "string" || value.length > 2000 || value !== value.trim()) return null;
  try {
    const url = new URL(value);
    // Auth is header-only. Permit the known harmless Nasdaq attribution query.
    const harmlessQuery = attribution && url.hostname === "api.nasdaq.com" && url.search === "?assetclass=etf";
    return url.protocol === "https:" && !url.username && !url.password && !url.hash && (!url.search || harmlessQuery) ? url.href : null;
  } catch { return null; }
}

async function readLicensedText(url, headers, deadline) {
  const remaining = deadline - Date.now();
  if (remaining <= 0) throw new Error("Licensed quote budget exhausted");
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), remaining);
  try {
    const response = await fetch(url, { headers, redirect: "error", signal: controller.signal });
    if (!response.ok || response.redirected) throw new Error("Licensed quote HTTP request failed");
    if (Number(response.headers.get("content-length")) > LICENSED_MAX_BYTES || !response.body) throw new Error("Licensed quote response size is invalid");
    const decoder = new TextDecoder("utf-8", { fatal: true });
    let text = ""; let bytes = 0;
    for await (const chunk of response.body) {
      bytes += chunk.byteLength;
      if (bytes > LICENSED_MAX_BYTES) throw new Error("Licensed quote response exceeds size limit");
      text += decoder.decode(chunk, { stream: true });
    }
    return text + decoder.decode();
  } finally { clearTimeout(timeout); controller.abort(); }
}

function licensedQuote(row, nowMs) {
  if (!object(row) || !SYMBOLS.has(row.symbol) || !positive(row.value)
    || !["regular", "close", "unconfirmed"].includes(row.session)
    || !(row.changePercent === null || (Number.isFinite(row.changePercent) && row.changePercent > -100))) {
    throw new Error("Invalid licensed quote fields");
  }
  const instant = wireTime(row.at);
  const { date, seconds } = requireQuoteTime(instant, nowMs);
  if (row.date !== date || (row.session !== "unconfirmed" && (!weekday(date) || seconds < REGULAR_OPEN || seconds >= INDEX_CLOSE_END))) {
    throw new Error("Licensed quote date or session is inconsistent");
  }
  const source = licensedUrl(row.source, true);
  if (!source) throw new Error("Invalid public attribution URL");
  return { symbol: row.symbol, value: row.value, date, at: new Date(instant).toISOString(), session: row.session, changePercent: row.changePercent, source };
}

// Use the default secure reader in production. An injected reader must honor
// the same absolute deadline, redirect rejection, and response byte limit.
export async function fetchLicensedMarketPulse({ fetchText = readLicensedText, now = () => new Date(), url, token }) {
  const endpoint = licensedUrl(url);
  const bearer = token ?? "";
  const validToken = typeof bearer === "string" && bearer.length <= 4096 && bearer === bearer.trim()
    && (!bearer || /^[A-Za-z0-9._~+\/-]+=*$/.test(bearer));
  const empty = (error) => ({ quotes: [], errors: [error], checkedAt: new Date(nowInstant(now())).toISOString() });
  if (!endpoint || !validToken) return empty("授权报价源未配置或地址无效");
  let body;
  try {
    const text = await fetchText(endpoint, { accept: "application/json", ...(bearer ? { authorization: `Bearer ${bearer}` } : {}) },
      Date.now() + MARKET_PULSE_BUDGET_MS, { redirect: "error", maxBytes: LICENSED_MAX_BYTES });
    if (typeof text !== "string" || Buffer.byteLength(text) > LICENSED_MAX_BYTES) throw new Error("Invalid licensed response size");
    body = JSON.parse(text);
  } catch { return empty("授权报价源请求失败或响应无法读取"); }
  const instant = nowInstant(now());
  const checkedAt = new Date(instant).toISOString();
  if (!object(body) || !Array.isArray(body.quotes) || body.quotes.length > SYMBOLS.size) {
    return { quotes: [], errors: ["授权报价源响应格式或批量大小无效"], checkedAt };
  }
  const quotes = []; const errors = [];
  const counts = new Map();
  for (const row of body.quotes) counts.set(row?.symbol, (counts.get(row?.symbol) || 0) + 1);
  for (const [index, row] of body.quotes.entries()) {
    const symbol = typeof row?.symbol === "string" && SYMBOLS.has(row.symbol) ? row.symbol : `第 ${index + 1} 项`;
    if (counts.get(row?.symbol) !== 1) { errors.push(`${symbol}：授权源报价重复，未采用`); continue; }
    try { quotes.push(licensedQuote(row, instant)); }
    catch { errors.push(`${symbol}：授权源报价字段、时间或来源无效`); }
  }
  if (Array.isArray(body.errors) && body.errors.length) errors.push("授权报价源报告部分行情不可用");
  return { quotes, errors: [...new Set(errors)], checkedAt };
}
