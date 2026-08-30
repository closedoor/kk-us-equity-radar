const DAY_MS = 86_400_000;

const BLS_ICS_URL = "https://www.bls.gov/schedule/news_release/bls.ics";
const BLS_CPI_URL = "https://www.bls.gov/schedule/news_release/cpi.htm";
const BLS_EMPLOYMENT_URL = "https://www.bls.gov/schedule/news_release/empsit.htm";
const FOMC_URL = "https://www.federalreserve.gov/monetarypolicy/fomccalendars.htm";
const FRED_CPI_URL = "https://fred.stlouisfed.org/releases/calendar?rid=10";
const FRED_EMPLOYMENT_URL = "https://fred.stlouisfed.org/releases/calendar?rid=50";
const NASDAQ_EARNINGS_URL = "https://api.nasdaq.com/api/analyst";

const monthNumbers = {
  jan: 1, january: 1, feb: 2, february: 2, mar: 3, march: 3,
  apr: 4, april: 4, may: 5, jun: 6, june: 6, jul: 7, july: 7,
  aug: 8, august: 8, sep: 9, sept: 9, september: 9,
  oct: 10, october: 10, nov: 11, november: 11, dec: 12, december: 12,
};

const fallbackCpiCalendar = [
  { date: "2026-08-12", period: "7 月" },
  { date: "2026-09-11", period: "8 月" },
  { date: "2026-10-14", period: "9 月" },
  { date: "2026-11-10", period: "10 月" },
  { date: "2026-12-10", period: "11 月" },
];

const fallbackEmploymentCalendar = [
  { date: "2026-08-07", period: "7 月" },
  { date: "2026-09-04", period: "8 月" },
  { date: "2026-10-02", period: "9 月" },
  { date: "2026-11-06", period: "10 月" },
  { date: "2026-12-04", period: "11 月" },
];

const fallbackFomcCalendar = [
  { startDate: "2026-07-28", date: "2026-07-29", projections: false },
  { startDate: "2026-09-15", date: "2026-09-16", projections: true },
  { startDate: "2026-10-27", date: "2026-10-28", projections: false },
  { startDate: "2026-12-08", date: "2026-12-09", projections: true },
];

function pad(value) {
  return String(value).padStart(2, "0");
}

function isoDate(year, month, day) {
  if (![year, month, day].every(Number.isFinite)) return null;
  const candidate = `${year}-${pad(month)}-${pad(day)}`;
  const parsed = new Date(`${candidate}T00:00:00Z`);
  return parsed.getUTCFullYear() === year && parsed.getUTCMonth() + 1 === month && parsed.getUTCDate() === day
    ? candidate
    : null;
}

function validIsoDate(value) {
  return /^\d{4}-\d{2}-\d{2}$/.test(String(value || "")) && !Number.isNaN(Date.parse(`${value}T00:00:00Z`));
}

function uniqueSortedEvents(events) {
  const byDate = new Map();
  for (const event of events || []) {
    if (validIsoDate(event?.date)) byDate.set(event.date, event);
  }
  return [...byDate.values()].sort((a, b) => a.date.localeCompare(b.date));
}

function decodeHtml(value) {
  return String(value || "")
    .replace(/<br\s*\/?>/gi, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;|&#160;/gi, " ")
    .replace(/&amp;/gi, "&")
    .replace(/&quot;/gi, "\"")
    .replace(/&#39;|&apos;/gi, "'")
    .replace(/\s+/g, " ")
    .trim();
}

function parseEnglishDate(value) {
  const text = decodeHtml(value).replace(/^(Monday|Tuesday|Wednesday|Thursday|Friday|Saturday|Sunday),?\s+/i, "");
  const match = text.match(/([A-Za-z]+)\.?\s+(\d{1,2}),\s*(\d{4})/);
  if (!match) return null;
  return isoDate(Number(match[3]), monthNumbers[match[1].toLowerCase()], Number(match[2]));
}

function previousMonthLabel(date) {
  const parsed = new Date(`${date}T12:00:00Z`);
  parsed.setUTCMonth(parsed.getUTCMonth() - 1);
  return `${parsed.getUTCMonth() + 1} 月`;
}

function periodLabel(value, fallbackDate) {
  const text = decodeHtml(value);
  const match = text.match(/(January|February|March|April|May|June|July|August|September|October|November|December)\s+\d{4}/i);
  return match ? `${monthNumbers[match[1].toLowerCase()]} 月` : previousMonthLabel(fallbackDate);
}

function dateInTimeZone(date, timeZone = "America/New_York") {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(date);
  const values = Object.fromEntries(parts.map(({ type, value }) => [type, value]));
  return `${values.year}-${values.month}-${values.day}`;
}

export function parseBlsIcs(ics) {
  const unfolded = String(ics || "").replace(/\r?\n[ \t]/g, "");
  const blocks = [...unfolded.matchAll(/BEGIN:VEVENT([\s\S]*?)END:VEVENT/gi)].map((match) => match[1]);
  const cpi = [];
  const employment = [];

  for (const block of blocks) {
    const dateRaw = block.match(/^DTSTART[^:]*:(\d{8})/mi)?.[1];
    if (!dateRaw) continue;
    const date = isoDate(Number(dateRaw.slice(0, 4)), Number(dateRaw.slice(4, 6)), Number(dateRaw.slice(6, 8)));
    if (!date) continue;
    const summary = block.match(/^SUMMARY:(.*)$/mi)?.[1] || "";
    const description = block.match(/^DESCRIPTION:(.*)$/mi)?.[1] || "";
    const text = `${summary} ${description}`.replace(/\\[nN]/g, " ").replace(/\\([,;])/g, "$1");
    const event = { date, period: periodLabel(text, date) };
    if (/Consumer Price Index/i.test(text)) cpi.push(event);
    if (/Employment Situation/i.test(text)) employment.push(event);
  }

  return { cpi: uniqueSortedEvents(cpi), employment: uniqueSortedEvents(employment) };
}

export function parseBlsReleasePage(html) {
  const events = [];
  for (const row of String(html || "").matchAll(/<tr[^>]*>([\s\S]*?)<\/tr>/gi)) {
    const cells = [...row[1].matchAll(/<t[dh][^>]*>([\s\S]*?)<\/t[dh]>/gi)].map((match) => decodeHtml(match[1]));
    if (cells.length < 2) continue;
    const date = parseEnglishDate(cells[1]);
    if (!date) continue;
    events.push({ date, period: periodLabel(cells[0], date) });
  }
  return uniqueSortedEvents(events);
}

export function parseFredReleaseCalendar(html) {
  const events = [];
  const regex = /<span[^>]*font-weight:\s*bold;?[^>]*>([^<]+)<\/span>/gi;
  for (const match of String(html || "").matchAll(regex)) {
    const date = parseEnglishDate(match[1]);
    if (date) events.push({ date, period: previousMonthLabel(date) });
  }
  return uniqueSortedEvents(events);
}

function addMonth(year, month, offset) {
  const zeroBased = (year * 12) + (month - 1) + offset;
  return { year: Math.floor(zeroBased / 12), month: (zeroBased % 12) + 1 };
}

export function parseFomcCalendar(html) {
  const source = String(html || "");
  const headings = [...source.matchAll(/<h4>\s*<a[^>]*>\s*(\d{4})\s+FOMC Meetings\s*<\/a>\s*<\/h4>/gi)];
  const events = [];

  for (let index = 0; index < headings.length; index += 1) {
    const year = Number(headings[index][1]);
    const start = headings[index].index + headings[index][0].length;
    const end = headings[index + 1]?.index ?? source.length;
    const block = source.slice(start, end);
    const meetingRegex = /fomc-meeting__month[^>]*>\s*<strong>([^<]+)<\/strong>\s*<\/div>[\s\S]*?fomc-meeting__date[^>]*>\s*([^<]+?)\s*<\/div>/gi;

    for (const match of block.matchAll(meetingRegex)) {
      const monthParts = match[1].trim().split("/").map((part) => monthNumbers[part.trim().toLowerCase()]);
      const dateText = match[2].trim();
      const dayParts = dateText.replace(/\*/g, "").match(/\d{1,2}/g)?.map(Number) || [];
      if (!monthParts[0] || !dayParts[0]) continue;
      let startMonth = monthParts[0];
      let endMonth = monthParts[1] || startMonth;
      let endYear = year;
      if (!monthParts[1] && dayParts[1] && dayParts[1] < dayParts[0]) {
        const shifted = addMonth(year, startMonth, 1);
        endMonth = shifted.month;
        endYear = shifted.year;
      }
      const startDate = isoDate(year, startMonth, dayParts[0]);
      const date = isoDate(endYear, endMonth, dayParts[1] || dayParts[0]);
      if (startDate && date) events.push({ startDate, date, projections: dateText.includes("*") });
    }
  }

  return uniqueSortedEvents(events);
}

export function parseNasdaqEarningsDate(payload) {
  const data = typeof payload === "string" ? JSON.parse(payload)?.data : payload?.data;
  const announcement = data?.announcement || "";
  const reportText = data?.reportText || "";
  const namedDate = announcement.match(/([A-Za-z]+)\s+(\d{1,2}),\s*(\d{4})/);
  const numericDate = reportText.match(/\b(\d{1,2})\/(\d{1,2})\/(\d{4})\b/);
  const date = namedDate
    ? isoDate(Number(namedDate[3]), monthNumbers[namedDate[1].toLowerCase()], Number(namedDate[2]))
    : numericDate
      ? isoDate(Number(numericDate[3]), Number(numericDate[1]), Number(numericDate[2]))
      : null;
  if (!date) return null;
  const timing = /before market open/i.test(reportText)
    ? "盘前"
    : /after market close/i.test(reportText)
      ? "盘后"
      : null;
  return { date, timing, status: "estimated", reportText };
}

function formatFomcMeeting(event) {
  const start = new Date(`${event.startDate}T12:00:00Z`);
  const end = new Date(`${event.date}T12:00:00Z`);
  if (start.getUTCMonth() === end.getUTCMonth()) {
    return `${start.getUTCMonth() + 1} 月 ${start.getUTCDate()}–${end.getUTCDate()} 日会议`;
  }
  return `${start.getUTCMonth() + 1} 月 ${start.getUTCDate()} 日–${end.getUTCMonth() + 1} 月 ${end.getUTCDate()} 日会议`;
}

function nextEvent(events, now) {
  const today = dateInTimeZone(now);
  return (events || []).find((event) => event.date >= today) || null;
}

function estimatedQuarterDate(released, now) {
  const today = dateInTimeZone(now);
  const base = validIsoDate(released) ? new Date(`${released}T12:00:00Z`) : new Date(now);
  let candidate = new Date(base);
  candidate.setUTCMonth(candidate.getUTCMonth() + 3);
  while (candidate.toISOString().slice(0, 10) < today) candidate.setUTCMonth(candidate.getUTCMonth() + 3);
  return candidate.toISOString().slice(0, 10);
}

function validCalendar(value) {
  return Array.isArray(value) && value.some((event) => validIsoDate(event?.date));
}

export function createCalendarService({ fetchText, aiEarnings, now = () => new Date(), logger = console, cacheTtlMs = 6 * 60 * 60 * 1000 }) {
  let lastAttemptAt = 0;
  let refreshPromise = null;
  let state = {
    cpi: fallbackCpiCalendar,
    employment: fallbackEmploymentCalendar,
    fomc: fallbackFomcCalendar,
    earnings: {},
    updatedAt: null,
    sources: {
      bls: { mode: "built-in", url: BLS_CPI_URL, lastSuccessAt: null, error: null },
      fomc: { mode: "built-in", url: FOMC_URL, lastSuccessAt: null, error: null },
      earnings: { mode: "built-in", url: "https://www.nasdaq.com/market-activity/earnings", lastSuccessAt: null, error: null },
    },
  };

  function hydrate(snapshot) {
    if (!snapshot || typeof snapshot !== "object") return;
    state = {
      ...state,
      cpi: validCalendar(snapshot.cpi) ? uniqueSortedEvents(snapshot.cpi) : state.cpi,
      employment: validCalendar(snapshot.employment) ? uniqueSortedEvents(snapshot.employment) : state.employment,
      fomc: validCalendar(snapshot.fomc) ? uniqueSortedEvents(snapshot.fomc) : state.fomc,
      earnings: snapshot.earnings && typeof snapshot.earnings === "object" ? snapshot.earnings : state.earnings,
      updatedAt: snapshot.updatedAt || state.updatedAt,
      sources: { ...state.sources, ...(snapshot.sources || {}) },
    };
  }

  async function fetchBlsCalendars() {
    try {
      const parsed = parseBlsIcs(await fetchText(BLS_ICS_URL, { accept: "text/calendar,text/plain,*/*" }));
      if (validCalendar(parsed.cpi) && validCalendar(parsed.employment)) {
        return { ...parsed, mode: "bls-live", url: BLS_ICS_URL };
      }
      throw new Error("BLS calendar did not contain CPI and Employment Situation dates");
    } catch (icsError) {
      try {
        const [cpiHtml, employmentHtml] = await Promise.all([
          fetchText(BLS_CPI_URL),
          fetchText(BLS_EMPLOYMENT_URL),
        ]);
        const cpi = parseBlsReleasePage(cpiHtml);
        const employment = parseBlsReleasePage(employmentHtml);
        if (!validCalendar(cpi) || !validCalendar(employment)) throw new Error("BLS release pages did not contain future dates");
        return { cpi, employment, mode: "bls-live", url: BLS_CPI_URL };
      } catch (pageError) {
        const currentYear = now().getUTCFullYear();
        const years = [currentYear, currentYear + 1];
        const [cpiPages, employmentPages] = await Promise.all([
          Promise.all(years.map((year) => fetchText(`${FRED_CPI_URL}&y=${year}`))),
          Promise.all(years.map((year) => fetchText(`${FRED_EMPLOYMENT_URL}&y=${year}`))),
        ]);
        const cpi = uniqueSortedEvents(cpiPages.flatMap(parseFredReleaseCalendar));
        const employment = uniqueSortedEvents(employmentPages.flatMap(parseFredReleaseCalendar));
        if (!validCalendar(cpi) || !validCalendar(employment)) {
          throw new Error(`BLS and FRED calendars unavailable: ${icsError.message}; ${pageError.message}`);
        }
        return { cpi, employment, mode: "fred-fallback", url: `${FRED_CPI_URL}&y=${currentYear}` };
      }
    }
  }

  async function fetchFomcCalendar() {
    const events = parseFomcCalendar(await fetchText(FOMC_URL));
    if (!validCalendar(events)) throw new Error("FOMC page did not contain meeting dates");
    return events;
  }

  async function fetchEarningsCalendar() {
    const rows = await Promise.all((aiEarnings || []).map(async (company) => {
      const symbol = company.nasdaqTicker || (company.ticker === "000660.KS" ? "SKHY" : company.ticker);
      try {
        const url = `${NASDAQ_EARNINGS_URL}/${encodeURIComponent(symbol)}/earnings-date`;
        const payload = await fetchText(url, {
          accept: "application/json,text/plain,*/*",
          referer: `https://www.nasdaq.com/market-activity/stocks/${symbol.toLowerCase()}/earnings`,
        });
        return [company.ticker, parseNasdaqEarningsDate(payload)];
      } catch (error) {
        logger.warn?.(`[calendar] ${company.ticker} earnings: ${error.message}`);
        return [company.ticker, null];
      }
    }));
    return Object.fromEntries(rows.filter(([, event]) => event));
  }

  async function runRefresh() {
    const attemptedAt = new Date().toISOString();
    const [blsResult, fomcResult, earningsResult] = await Promise.allSettled([
      fetchBlsCalendars(),
      fetchFomcCalendar(),
      fetchEarningsCalendar(),
    ]);
    const sources = { ...state.sources };

    if (blsResult.status === "fulfilled") {
      state.cpi = blsResult.value.cpi;
      state.employment = blsResult.value.employment;
      sources.bls = { mode: blsResult.value.mode, url: blsResult.value.url, lastSuccessAt: attemptedAt, error: null };
    } else {
      sources.bls = { ...sources.bls, error: blsResult.reason?.message || "calendar fetch failed" };
    }

    if (fomcResult.status === "fulfilled") {
      state.fomc = fomcResult.value;
      sources.fomc = { mode: "fed-live", url: FOMC_URL, lastSuccessAt: attemptedAt, error: null };
    } else {
      sources.fomc = { ...sources.fomc, error: fomcResult.reason?.message || "calendar fetch failed" };
    }

    if (earningsResult.status === "fulfilled" && Object.keys(earningsResult.value).length) {
      state.earnings = { ...state.earnings, ...earningsResult.value };
      sources.earnings = { mode: "nasdaq-live", url: "https://www.nasdaq.com/market-activity/earnings", lastSuccessAt: attemptedAt, error: null };
    } else if (earningsResult.status === "rejected") {
      sources.earnings = { ...sources.earnings, error: earningsResult.reason?.message || "calendar fetch failed" };
    }

    state = { ...state, updatedAt: attemptedAt, sources };
    return snapshot();
  }

  function refresh({ force = false } = {}) {
    if (refreshPromise) return refreshPromise;
    if (!force && lastAttemptAt && Date.now() - lastAttemptAt < cacheTtlMs) return Promise.resolve(snapshot());
    lastAttemptAt = Date.now();
    refreshPromise = runRefresh().finally(() => { refreshPromise = null; });
    return refreshPromise;
  }

  function resolvedAiEarnings(at = now()) {
    const today = dateInTimeZone(at);
    return (aiEarnings || []).map((company) => {
      const snapshotAgeDays = validIsoDate(company.released)
        ? Math.floor((Date.parse(`${today}T00:00:00Z`) - Date.parse(`${company.released}T00:00:00Z`)) / DAY_MS)
        : null;
      const knownReportPassed = company.nextReportStatus === "confirmed"
        && validIsoDate(company.nextReportDate)
        && company.nextReportDate < today
        && company.nextReportDate > company.released;
      const snapshotStale = knownReportPassed || (Number.isFinite(snapshotAgeDays) && snapshotAgeDays > 120);
      const snapshot = {
        snapshotStale,
        snapshotAgeDays,
        snapshotLabel: snapshotStale ? "财报解读待更新" : `资料截至 ${company.released}`,
      };
      const automatic = state.earnings[company.ticker];
      const automaticIsFuture = validIsoDate(automatic?.date) && automatic.date >= today;
      const confirmedFallback = company.nextReportStatus === "confirmed"
        && validIsoDate(company.nextReportDate)
        && company.nextReportDate >= today;

      if (automaticIsFuture) {
        const confirmed = confirmedFallback && company.nextReportDate === automatic.date;
        return {
          ...company,
          ...snapshot,
          nextReportDate: automatic.date,
          nextReportLabel: `${automatic.date}${automatic.timing ? ` · ${automatic.timing}` : ""}`,
          nextReportStatus: confirmed ? "confirmed" : "estimated",
          nextReportSource: confirmed
            ? company.nextReportSource
            : `https://www.nasdaq.com/market-activity/stocks/${(company.nasdaqTicker || company.ticker).toLowerCase()}/earnings`,
        };
      }

      if (confirmedFallback) return { ...company, ...snapshot };
      const estimate = estimatedQuarterDate(company.released, at);
      return {
        ...company,
        ...snapshot,
        nextReportDate: null,
        nextReportLabel: `预计 ${estimate} 前后 · 待官宣`,
        nextReportStatus: "estimated",
        nextReportSource: null,
      };
    });
  }

  function buildReminders(at = now()) {
    const cpi = nextEvent(state.cpi, at);
    const employment = nextEvent(state.employment, at);
    const fomc = nextEvent(state.fomc, at);
    const earnings = resolvedAiEarnings(at);
    const blsSource = state.sources.bls?.url || BLS_CPI_URL;

    return [
      {
        indicatorId: "inflation", label: "CPI 公布", date: cpi?.date || null,
        event: cpi ? `美国 ${cpi.period} CPI / 核心 CPI，08:30 ET` : "正在等待官方发布下一期日程",
        source: blsSource, linkLabel: "查看自动同步日程", scheduleStatus: cpi ? "confirmed" : "pending",
      },
      {
        indicatorId: "fed", label: "FOMC 利率决议", date: fomc?.date || null,
        event: fomc ? `${formatFomcMeeting(fomc)}：利率决议与主席发布会${fomc.projections ? "，同时公布经济预测" : ""}` : "正在等待美联储发布下一期日程",
        source: FOMC_URL, linkLabel: "查看美联储会议日程", scheduleStatus: fomc ? "confirmed" : "pending",
      },
      {
        indicatorId: "unemployment", label: "失业率", date: employment?.date || null,
        event: employment ? `${employment.period}就业报告·失业率，08:30 ET` : "正在等待官方发布下一期日程",
        source: blsSource, linkLabel: "查看自动同步日程", scheduleStatus: employment ? "confirmed" : "pending",
      },
      {
        indicatorId: "payrolls", label: "非农就业", date: employment?.date || null,
        event: employment ? `${employment.period}就业报告·非农就业，08:30 ET` : "正在等待官方发布下一期日程",
        source: blsSource, linkLabel: "查看自动同步日程", scheduleStatus: employment ? "confirmed" : "pending",
      },
      {
        indicatorId: "aiEarnings", label: "八家 AI 巨头财报", date: null,
        event: "Nasdaq 自动更新日期；公司已官宣与市场预估分开标注",
        source: "https://www.nasdaq.com/market-activity/earnings",
        companies: earnings.map(({ company, ticker, released, nextReportDate, nextReportLabel, nextReportStatus, nextReportSource }) => ({
          company,
          ticker,
          released,
          next: nextReportDate || nextReportLabel,
          status: nextReportStatus || "estimated",
          source: nextReportSource || null,
        })),
      },
    ];
  }

  function snapshot() {
    return JSON.parse(JSON.stringify(state));
  }

  function syncStatus() {
    return {
      updatedAt: state.updatedAt,
      refreshEveryHours: cacheTtlMs / 3_600_000,
      sources: state.sources,
    };
  }

  return {
    refresh,
    hydrate,
    snapshot,
    syncStatus,
    buildReminders,
    resolvedAiEarnings,
    nextFomc: (at = now()) => nextEvent(state.fomc, at),
  };
}

export const calendarSources = {
  BLS_ICS_URL,
  BLS_CPI_URL,
  BLS_EMPLOYMENT_URL,
  FOMC_URL,
  FRED_CPI_URL,
  FRED_EMPLOYMENT_URL,
  NASDAQ_EARNINGS_URL,
};
