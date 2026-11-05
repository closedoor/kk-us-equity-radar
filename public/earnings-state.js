// Official report metadata is automatic; all financial commentary remains reviewed data.
export const EARNINGS_COMPANIES = Object.freeze({
  NVDA: { cik: "1045810", host: "nvidianews.nvidia.com", path: "/news/", fiscal: true },
  AVGO: { cik: "1730168", host: "investors.broadcom.com", path: "/news-releases/news-release-details/", fiscal: true },
  TSM: { cik: "1046179", host: "investor.tsmc.com", path: "/english/quarterly-results/", fiscal: false },
  MSFT: { cik: "789019", host: "www.microsoft.com", path: "/en-us/Investor/earnings/", fiscal: true },
  GOOG: { cik: "1652044", host: "abc.xyz", path: "/investor/", fiscal: false },
  AMZN: { cik: "1018724", host: "ir.aboutamazon.com", path: "/news-release/", fiscal: false },
  MU: { cik: "723125", host: "investors.micron.com", path: "/news/press-release/", fiscal: true },
  "000660.KS": { cik: null, host: "news.skhynix.com", path: "/en/", fiscal: false },
});

const object = (value) => value !== null && typeof value === "object" && !Array.isArray(value);
export function validEarningsDate(value) {
  return typeof value === "string" && /^\d{4}-\d{2}-\d{2}$/.test(value)
    && Number.isFinite(Date.parse(`${value}T00:00:00Z`)) && new Date(`${value}T00:00:00Z`).toISOString().slice(0, 10) === value;
}
export function validEarningsTimestamp(value) {
  return typeof value === "string" && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?(?:Z|[+-]\d{2}:?\d{2})$/.test(value)
    && validEarningsDate(value.slice(0, 10)) && Number.isFinite(Date.parse(value));
}
export function earningsPeriod(value) {
  const match = typeof value === "string" && /^(FY)?(20\d{2}) Q([1-4])$/.exec(value);
  return match ? { fiscal: Boolean(match[1]), year: Number(match[2]), quarter: Number(match[3]), ordinal: Number(match[2]) * 4 + Number(match[3]) } : null;
}
export function officialEarningsUrl(ticker, value) {
  const profile = EARNINGS_COMPANIES[ticker];
  if (!profile || typeof value !== "string") return false;
  try {
    const url = new URL(value);
    if (url.protocol !== "https:" || url.username || url.password || url.port || url.hash) return false;
    if (url.hostname === profile.host && url.pathname.startsWith(profile.path)) return true;
    return Boolean(profile.cik && url.hostname === "www.sec.gov"
      && url.pathname.startsWith(`/Archives/edgar/data/${profile.cik}/`));
  } catch { return false; }
}

export function isEarningsSchedule(value) {
  if (!object(value) || value.version !== 1 || !object(value.sources)) return false;
  return Object.entries(value.sources).every(([ticker, record]) => Object.hasOwn(EARNINGS_COMPANIES, ticker) && object(record)
    && ["checkedAt", "attemptedAt", "error", "reports"].every((key) => Object.hasOwn(record, key))
    && (record.checkedAt === null || validEarningsTimestamp(record.checkedAt))
    && (record.attemptedAt === null || validEarningsTimestamp(record.attemptedAt))
    && (!record.checkedAt || !record.attemptedAt || Date.parse(record.checkedAt) <= Date.parse(record.attemptedAt))
    && (record.error === null || (typeof record.error === "string" && record.error.length <= 1000))
    && Array.isArray(record.reports) && record.reports.length <= 12
    && (!record.reports.length || (record.checkedAt !== null && record.attemptedAt !== null))
    && record.reports.every((report) => object(report)
      && (report.period === null || (earningsPeriod(report.period)?.fiscal === EARNINGS_COMPANIES[ticker].fiscal))
      && (report.periodEnd === null || validEarningsDate(report.periodEnd))
      && (report.period !== null || report.periodEnd !== null)
      && validEarningsTimestamp(report.publishedAt) && Date.parse(report.publishedAt) <= Date.parse(record.checkedAt)
      && (!report.periodEnd || Date.parse(report.periodEnd) <= Date.parse(report.publishedAt))
      && consistentPeriodEnd(ticker, report)
      && officialEarningsUrl(ticker, report.source)
      && ["10-Q", "10-K", "earnings-release"].includes(report.form)
      && (report.form === "earnings-release" || report.source.startsWith("https://www.sec.gov/Archives/edgar/data/"))
      && typeof report.title === "string" && report.title.trim().length > 0 && report.title.length <= 500));
}

function earliestPeriodEnd(ticker, period) {
  const parsed = earningsPeriod(period);
  if (!parsed) return null;
  const { year, quarter, fiscal } = parsed;
  if (!fiscal) return Date.UTC(year, quarter * 3, 0);
  if (ticker === "MSFT") return Date.UTC(year - (quarter <= 2 ? 1 : 0), ((quarter + 1) % 4 + 1) * 3, 0);
  // Weekly fiscal calendars can end near either side of a month boundary.
  const anchors = ticker === "NVDA" ? [[year - 1, 4, 30], [year - 1, 7, 31], [year - 1, 10, 31], [year, 1, 31]]
    : ticker === "AVGO" ? [[year, 2, 1], [year, 5, 1], [year, 8, 1], [year, 11, 1]]
      : ticker === "MU" ? [[year - 1, 11, 30], [year, 2, 28], [year, 5, 31], [year, 8, 31]] : null;
  const anchor = anchors?.[quarter - 1];
  return anchor ? Date.UTC(anchor[0], anchor[1] - 1, anchor[2]) - 7 * 86_400_000 : null;
}

function consistentPeriodEnd(ticker, report) {
  if (!report.period || !report.periodEnd) return true;
  const period = earningsPeriod(report.period); const floor = earliestPeriodEnd(ticker, report.period);
  if (!period || floor === null) return false;
  if (!period.fiscal || ticker === "MSFT") return Date.parse(report.periodEnd) === floor;
  return Math.abs(Date.parse(report.periodEnd) - (floor + 7 * 86_400_000)) <= 14 * 86_400_000;
}

function publishedReport(ticker, report, nowMs) {
  const floor = earliestPeriodEnd(ticker, report.period);
  return Date.parse(report.publishedAt) <= nowMs
    && (!report.periodEnd || Date.parse(report.periodEnd) <= nowMs)
    && (floor === null || floor <= nowMs);
}

function newerThanReview(report, reviewed) {
  const current = earningsPeriod(reviewed.period);
  const next = earningsPeriod(report.period);
  if (current && next && current.fiscal === next.fiscal) {
    if (next.ordinal !== current.ordinal) return next.ordinal > current.ordinal;
    return Boolean(report.periodEnd && validEarningsDate(reviewed.released) && report.periodEnd > reviewed.released);
  }
  // This fallback is deliberately one-way: a period ending after the reviewed
  // announcement is conclusive, while a later filing date by itself is not.
  return Boolean(report.periodEnd && validEarningsDate(reviewed.released) && report.periodEnd > reviewed.released);
}

export function applyEarningsChecks(rows, schedule, nowMs = Date.now()) {
  const valid = isEarningsSchedule(schedule) && Number.isFinite(nowMs);
  const checks = [];
  const errors = [];
  const aiEarnings = rows.map((row) => {
    const record = valid ? schedule.sources[row.ticker] : null;
    const clockValid = record && (!record.checkedAt || Date.parse(record.checkedAt) <= nowMs)
      && (!record.attemptedAt || Date.parse(record.attemptedAt) <= nowMs);
    const reports = clockValid ? record.reports.filter((report) => publishedReport(row.ticker, report, nowMs)) : [];
    const newer = reports.filter((report) => newerThanReview(report, row));
    const ordered = [...(newer.length ? newer : reports)].sort((a, b) => {
      const ap = earningsPeriod(a.period); const bp = earningsPeriod(b.period);
      if (ap && bp && ap.fiscal === bp.fiscal && ap.ordinal !== bp.ordinal) return bp.ordinal - ap.ordinal;
      if (a.periodEnd && b.periodEnd && a.periodEnd !== b.periodEnd) return b.periodEnd.localeCompare(a.periodEnd);
      return Date.parse(b.publishedAt) - Date.parse(a.publishedAt);
    });
    const latestReport = ordered[0] || null;
    const reviewRequired = newer.length > 0;
    const reviewedPeriod = earningsPeriod(row.period);
    const coversReviewed = reports.some((report) => {
      const period = earningsPeriod(report.period);
      return reviewedPeriod && period && reviewedPeriod.fiscal === period.fiscal && period.ordinal >= reviewedPeriod.ordinal;
    });
    const recentCheck = record?.checkedAt && nowMs - Date.parse(record.checkedAt) <= 86_400_000;
    const status = reviewRequired ? "review-required" : coversReviewed && recentCheck && !record.error ? "no-newer-report" : "unknown";
    const message = reviewRequired ? `${row.ticker} 官方新报告 ${latestReport.period || latestReport.periodEnd} 已发布，原财报解读待复核，暂不参与自动评分。`
      : status === "no-newer-report" ? `${row.ticker} 本次官方来源未发现比已审核 ${row.period} 更新的季度报告。`
        : `${row.ticker} 财报发布进度暂无法确认${record?.error ? `：${record.error}` : ""}。`;
    if (schedule != null) {
      checks.push({ ticker: row.ticker, status, latestReport, checkedAt: record?.checkedAt || null, message });
      if (reviewRequired || status === "unknown") errors.push(message);
      if (reviewRequired && record?.error) errors.push(`${row.ticker} 本次监测失败：${record.error}；保留此前已确认的新报告证据。`);
    }
    return { ...row, reviewRequired, earningsReviewStatus: status, latestReport };
  });
  return { aiEarnings, checks, errors: [...new Set(errors)] };
}
