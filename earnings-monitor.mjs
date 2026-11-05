import { EARNINGS_COMPANIES, earningsPeriod, isEarningsSchedule, officialEarningsUrl, validEarningsDate, validEarningsTimestamp } from "./public/earnings-state.js";

const SEC_AGENT = "kk-us-equity-radar/earnings-monitor (personal public-market research)";
export const earningsMonitorSources = Object.freeze(Object.fromEntries(Object.entries(EARNINGS_COMPANIES).map(([ticker, profile]) => [ticker,
  profile.cik ? `https://data.sec.gov/submissions/CIK${profile.cik.padStart(10, "0")}.json` : "https://news.skhynix.com/en/category/press/feed/",
])));
const QUARTERS = ["First", "Second", "Third", "Fourth"];
const SEC_COLUMNS = ["form", "reportDate", "filingDate", "acceptanceDateTime", "accessionNumber", "primaryDocument"];

function text(value) {
  return String(value || "").replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, "$1").replace(/<[^>]*>/g, " ")
    .replace(/&amp;/gi, "&").replace(/&quot;/gi, '"').replace(/&apos;|&#39;/gi, "'").replace(/&nbsp;|&#160;/gi, " ").replace(/\s+/g, " ").trim();
}
function parsePayload(payload) {
  if (typeof payload === "string" && payload.length > 5_000_000) throw new Error("Official earnings response exceeds size limit");
  return typeof payload === "string" ? JSON.parse(payload) : payload;
}
function secRows(payload, ticker) {
  const data = parsePayload(payload);
  if (!data || String(data.cik).replace(/^0+/, "") !== EARNINGS_COMPANIES[ticker]?.cik) throw new Error("SEC company identity mismatch");
  const recent = data.filings?.recent;
  if (!recent || !SEC_COLUMNS.every((key) => Array.isArray(recent[key]) && recent[key].length === recent.form?.length)) {
    throw new Error("SEC submissions columns are missing or have inconsistent array lengths");
  }
  return recent.form.map((_, index) => Object.fromEntries(SEC_COLUMNS.map((key) => [key, recent[key][index]])));
}
function filingUrl(row, ticker) {
  if (!/^\d{10}-\d{2}-\d{6}$/.test(row.accessionNumber) || typeof row.primaryDocument !== "string"
    || !/^[A-Za-z0-9][A-Za-z0-9_.-]*\.(?:htm|html)$/i.test(row.primaryDocument)) throw new Error("SEC report document path is invalid");
  return `https://www.sec.gov/Archives/edgar/data/${EARNINGS_COMPANIES[ticker].cik}/${row.accessionNumber.replaceAll("-", "")}/${row.primaryDocument}`;
}
function publishedFiling(row, nowMs) {
  return validEarningsDate(row.reportDate) && validEarningsDate(row.filingDate) && validEarningsTimestamp(row.acceptanceDateTime)
    && Date.parse(row.acceptanceDateTime) <= nowMs && Date.parse(row.reportDate) <= Date.parse(row.acceptanceDateTime);
}
function calendarPeriod(date) {
  if (!validEarningsDate(date)) return null;
  const year = Number(date.slice(0, 4)); const month = Number(date.slice(5, 7));
  const quarter = Math.ceil(month / 3);
  return date === new Date(Date.UTC(year, quarter * 3, 0)).toISOString().slice(0, 10) ? `${year} Q${quarter}` : null;
}
function fiscalPeriod(ticker, date) {
  const year = Number(date.slice(0, 4)); const month = Number(date.slice(5, 7));
  if (ticker === "GOOG" || ticker === "AMZN") return calendarPeriod(date);
  if (ticker === "MSFT") {
    if (!calendarPeriod(date)) return null;
    return `FY${year + (month > 6 ? 1 : 0)} Q${month === 9 ? 1 : month === 12 ? 2 : month === 3 ? 3 : 4}`;
  }
  // These are calendar labels only. Actual evidence remains SEC's exact periodEnd.
  // A report outside the known weekly fiscal windows keeps a null label rather than guessing.
  const candidates = [];
  for (const fy of [year - 1, year, year + 1]) {
    const anchors = ticker === "NVDA" ? [[fy - 1, 4, 30], [fy - 1, 7, 31], [fy - 1, 10, 31], [fy, 1, 31]]
      : ticker === "AVGO" ? [[fy, 2, 1], [fy, 5, 1], [fy, 8, 1], [fy, 11, 1]]
        : ticker === "MU" ? [[fy - 1, 11, 30], [fy, 2, 28], [fy, 5, 31], [fy, 8, 31]] : [];
    anchors.forEach((anchor, index) => {
      const distance = Math.abs(Date.parse(date) - Date.UTC(anchor[0], anchor[1] - 1, anchor[2]));
      if (distance <= 14 * 86_400_000) candidates.push({ distance, period: `FY${fy} Q${index + 1}` });
    });
  }
  candidates.sort((a, b) => a.distance - b.distance);
  return candidates[0]?.period || null;
}
function knownFiscalCalendar(ticker, fiscalYearEnd) {
  if (typeof fiscalYearEnd !== "string" || !/^\d{4}$/.test(fiscalYearEnd)) return false;
  const date = `2000-${fiscalYearEnd.slice(0, 2)}-${fiscalYearEnd.slice(2)}`;
  if (!validEarningsDate(date)) return false;
  if (ticker === "MSFT") return fiscalYearEnd === "0630";
  if (ticker === "GOOG" || ticker === "AMZN") return fiscalYearEnd === "1231";
  const anchor = ticker === "NVDA" ? "2000-01-31" : ticker === "AVGO" ? "2000-11-01" : ticker === "MU" ? "2000-08-31" : null;
  return Boolean(anchor && Math.abs(Date.parse(date) - Date.parse(anchor)) <= 14 * 86_400_000);
}

export function parseSecEarnings(payload, ticker, checkedAt = new Date().toISOString()) {
  const nowMs = Date.parse(checkedAt);
  if (!Number.isFinite(nowMs)) throw new Error("Invalid SEC earnings check time");
  const data = parsePayload(payload);
  const calendarKnown = knownFiscalCalendar(ticker, data?.fiscalYearEnd);
  const reports = secRows(data, ticker).filter((row) => ["10-Q", "10-K"].includes(row.form) && publishedFiling(row, nowMs)).map((row) => ({
    period: calendarKnown && (row.form !== "10-K" || earningsPeriod(fiscalPeriod(ticker, row.reportDate))?.quarter === 4) ? fiscalPeriod(ticker, row.reportDate) : null, periodEnd: row.reportDate,
    publishedAt: new Date(row.acceptanceDateTime).toISOString(), source: filingUrl(row, ticker), form: row.form,
    title: `${ticker} ${row.form} for period ended ${row.reportDate}`,
  })).sort((a, b) => b.periodEnd.localeCompare(a.periodEnd) || Date.parse(b.publishedAt) - Date.parse(a.publishedAt)).slice(0, 6);
  if (!reports.length) throw new Error("SEC did not contain a verified published quarterly or annual report");
  return reports;
}

function rssField(block, name) {
  return text(block.match(new RegExp(`<${name}\\b[^>]*>([\\s\\S]*?)<\\/${name}>`, "i"))?.[1]);
}
export function parseSkEarningsFeed(payload, checkedAt = new Date().toISOString()) {
  const xml = String(payload || "");
  if (!/<rss\b/i.test(xml) || !/<channel\b/i.test(xml)) throw new Error("SK hynix official RSS feed is invalid");
  const nowMs = Date.parse(checkedAt); const reports = [];
  for (const match of xml.matchAll(/<item\b[^>]*>([\s\S]*?)<\/item>/gi)) {
    const title = rssField(match[1], "title");
    const periodMatch = /^SK hynix Announces ([1-4])Q(20\d{2}|\d{2}) Financial Results$/i.exec(title);
    if (!periodMatch) continue;
    const year = periodMatch[2].length === 2 ? 2000 + Number(periodMatch[2]) : Number(periodMatch[2]);
    const quarter = Number(periodMatch[1]); const rawTime = rssField(match[1], "pubDate");
    const instant = Date.parse(rawTime); const source = rssField(match[1], "link");
    const periodEnd = new Date(Date.UTC(year, quarter * 3, 0)).toISOString().slice(0, 10);
    if (!Number.isFinite(instant) || instant > nowMs || Date.parse(periodEnd) > instant || !officialEarningsUrl("000660.KS", source)) continue;
    reports.push({ period: `${year} Q${quarter}`, periodEnd, publishedAt: new Date(instant).toISOString(), source, form: "earnings-release", title });
  }
  if (!reports.length) throw new Error("SK hynix RSS did not contain verified published quarterly financial results");
  return reports.sort((a, b) => b.periodEnd.localeCompare(a.periodEnd)).slice(0, 6);
}

async function tsmReports(payload, request, checkedAt) {
  const nowMs = Date.parse(checkedAt);
  const candidates = secRows(payload, "TSM").filter((row) => row.form === "6-K" && publishedFiling(row, nowMs)
    && calendarPeriod(row.reportDate) && !/monthend|revenue/i.test(row.primaryDocument))
    .sort((a, b) => b.reportDate.localeCompare(a.reportDate) || Date.parse(b.acceptanceDateTime) - Date.parse(a.acceptanceDateTime)).slice(0, 4);
  for (const row of candidates) {
    const primary = filingUrl(row, "TSM");
    const html = await request(primary);
    const expected = calendarPeriod(row.reportDate); const parsed = earningsPeriod(expected);
    const filenames = [...html.matchAll(/href\s*=\s*["']([^"']+)["']/gi)].map((match) => match[1])
      .filter((name) => new RegExp(`^a${parsed.quarter}q${String(parsed.year).slice(-2)}e[A-Za-z0-9_.-]*\\.htm$`, "i").test(name));
    for (const filename of new Set(filenames)) {
      const source = new URL(filename, primary).href;
      if (!officialEarningsUrl("TSM", source)) continue;
      const body = text(await request(source));
      if (!new RegExp(`\\bTSMC Reports ${QUARTERS[parsed.quarter - 1]} Quarter (?:EPS|Financial Results)\\b`, "i").test(body)
        || !new RegExp(`\\b${parsed.year}\\b`).test(body) || !/\bnet (?:revenue|income)\b/i.test(body)) continue;
      return [{ period: expected, periodEnd: row.reportDate, publishedAt: new Date(row.acceptanceDateTime).toISOString(), source,
        form: "earnings-release", title: `TSMC ${expected} quarterly financial results (SEC earnings exhibit)` }];
    }
  }
  throw new Error("TSMC quarterly earnings exhibit was not verified; monthly revenue and other 6-Ks are not quarterly results");
}

function mergeReports(previous, incoming) {
  const merged = new Map();
  for (const report of [...previous, ...incoming]) merged.set(`${report.period}|${report.periodEnd}|${report.source}`, report);
  return [...merged.values()].sort((a, b) => Date.parse(b.publishedAt) - Date.parse(a.publishedAt)).slice(0, 12);
}

function latestTimestamp(first, second) {
  const timestamps = [first, second].filter(Boolean).map((value) => Date.parse(value));
  return timestamps.length ? new Date(Math.max(...timestamps)).toISOString() : null;
}

export function createEarningsMonitor({ fetchText, aiEarnings = Object.keys(EARNINGS_COMPANIES).map((ticker) => ({ ticker })),
  now = () => new Date(), logger = console, cacheTtlMs = 6 * 3_600_000, failureRetryMs = 30 * 60_000,
  fetchBudgetMs = 60_000, secUserAgent = SEC_AGENT, onChange = null,
}) {
  if (typeof fetchText !== "function") throw new Error("Earnings monitor requires fetchText");
  if (onChange !== null && typeof onChange !== "function") throw new Error("Earnings monitor onChange must be a function");
  const tickers = [...new Set(aiEarnings.map((row) => row.ticker))].filter((ticker) => Object.hasOwn(EARNINGS_COMPANIES, ticker));
  let state = { version: 1, sources: Object.fromEntries(tickers.map((ticker) => [ticker, { checkedAt: null, attemptedAt: null, error: null, reports: [] }])) };
  let refreshPromise = null; let lastAttemptAt = null;
  const snapshot = () => JSON.parse(JSON.stringify(state));
  function hydrate(saved) {
    if (!isEarningsSchedule(saved)) return;
    const time = now().getTime();
    for (const ticker of tickers) {
      const record = saved.sources[ticker];
      if (!record || (record.checkedAt && Date.parse(record.checkedAt) > time) || (record.attemptedAt && Date.parse(record.attemptedAt) > time)) continue;
      const reports = record.reports.filter((report) => Date.parse(report.publishedAt) <= time && (!report.periodEnd || Date.parse(report.periodEnd) <= time));
      const previous = state.sources[ticker];
      const newer = Date.parse(record.attemptedAt || record.checkedAt) >= Date.parse(previous.attemptedAt || previous.checkedAt) || !previous.attemptedAt;
      state.sources[ticker] = { ...(newer ? record : previous),
        checkedAt: latestTimestamp(previous.checkedAt, record.checkedAt),
        attemptedAt: latestTimestamp(previous.attemptedAt, record.attemptedAt),
        reports: mergeReports(previous.reports, reports) };
    }
  }
  async function runRefresh() {
    const deadline = Date.now() + (Number.isFinite(fetchBudgetMs) ? Math.max(0, Math.min(60_000, fetchBudgetMs)) : 60_000);
    let requestStarts = Promise.resolve(); let lastStartAt = 0;
    const request = async (url) => {
      requestStarts = requestStarts.then(async () => {
        const wait = Math.max(0, 150 - (Date.now() - lastStartAt));
        if (Date.now() + wait >= deadline) throw new Error("Earnings monitor fetch budget exhausted");
        if (wait) await new Promise((resolve) => setTimeout(resolve, wait));
        lastStartAt = Date.now();
      });
      await requestStarts;
      const result = await fetchText(url, { accept: url.startsWith("https://data.sec.gov/") ? "application/json" : "text/html,application/rss+xml,text/xml,*/*", "user-agent": secUserAgent }, deadline);
      if (typeof result !== "string" || result.length > 5_000_000) throw new Error("Official earnings response is invalid or exceeds size limit");
      return result;
    };
    let cursor = 0;
    const worker = async () => {
      while (cursor < tickers.length) {
        const ticker = tickers[cursor++];
        try {
          const payload = await request(earningsMonitorSources[ticker]);
          const checkedAt = now().toISOString();
          const reports = ticker === "000660.KS" ? parseSkEarningsFeed(payload, checkedAt)
            : ticker === "TSM" ? await tsmReports(payload, request, checkedAt) : parseSecEarnings(payload, ticker, checkedAt);
          const finishedAt = now().toISOString();
          state.sources[ticker] = { checkedAt: finishedAt, attemptedAt: finishedAt, error: null,
            reports: mergeReports(state.sources[ticker].reports, reports) };
        } catch (error) {
          const message = String(error?.message || error || "Earnings report check failed").slice(0, 1000);
          logger.warn?.(`[earnings] ${ticker}: ${message}`);
          state.sources[ticker] = { ...state.sources[ticker], attemptedAt: now().toISOString(), error: message };
        }
        // Publish evidence as soon as this company finishes. A slow unrelated
        // source must not leave already-verified reports only in process memory.
        if (onChange) {
          try { await onChange(snapshot()); }
          catch (error) {
            logger.warn?.(`[earnings] onChange failed for ${ticker}: ${String(error?.message || error).slice(0, 1000)}`);
          }
        }
      }
    };
    await Promise.all(Array.from({ length: Math.min(2, tickers.length) }, worker));
    return snapshot();
  }
  function refresh({ force = false } = {}) {
    if (refreshPromise) return refreshPromise;
    const timestamp = now().getTime();
    const hasErrors = Object.values(state.sources).some((record) => record.error);
    const interval = hasErrors ? Math.min(cacheTtlMs, failureRetryMs) : cacheTtlMs;
    if (!force && lastAttemptAt !== null && timestamp >= lastAttemptAt && timestamp - lastAttemptAt < interval) return Promise.resolve(snapshot());
    lastAttemptAt = timestamp;
    refreshPromise = runRefresh().finally(() => { refreshPromise = null; });
    return refreshPromise;
  }
  return { refresh, hydrate, snapshot };
}
