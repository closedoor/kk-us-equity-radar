import http from "node:http";
import { readFile, writeFile, rename, unlink } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createCalendarService } from "./calendar.mjs";
import { parseFredCsv, parseNasdaqRows, requireFreshSeries, monthlyPercentChange, monthlyAnnualizedChange, monthlyDifference, nearestPrior, fredMaxAgeDays, relativePerformance } from "./market-data.mjs";
import { computeScores, actionFor, INDICATOR_WEIGHTS, normalizeIndicator, SCORING_VERSION, SCORING_NOTE } from "./public/risk-model.js";
import { projectDashboard, resolveAiIndicator, shouldReplaceDashboard, isDashboardSnapshot, checkPolicyBounds } from "./public/dashboard-state.js";
import { aiEarnings, aiChainLayers } from "./earnings-data.mjs";
import { createPublicationService } from "./publication.mjs";
import { createEarningsMonitor } from "./earnings-monitor.mjs";
import { hydrateSourceLedger, updateSourceLedger } from "./source-revisions.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const publicDir = path.join(__dirname, "public");
const dashboardCacheFile = path.join(__dirname, "dashboard-cache.json");
const productVersion = JSON.parse(await readFile(path.join(__dirname, "package.json"), "utf8")).version;
const buildCommit = /^[a-f0-9]{40}$/.test(process.env.RENDER_GIT_COMMIT || "") ? process.env.RENDER_GIT_COMMIT : null;
const port = Number(process.env.PORT || 4173);
const host = process.env.HOST || "0.0.0.0";
const CACHE_TTL_MS = 15 * 60 * 1000;
const FORCE_REFRESH_COOLDOWN_MS = 60 * 1000;
const REQUEST_TIMEOUT_MS = 25_000;
const MARKET_FETCH_BUDGET_MS = 90_000;
const SECURITY_HEADERS = {
  "content-security-policy": "default-src 'self'; base-uri 'none'; object-src 'none'; frame-ancestors 'none'; script-src 'self'; style-src 'self' 'unsafe-inline'; font-src 'self'; img-src 'self' data:; connect-src 'self'",
  "referrer-policy": "strict-origin-when-cross-origin",
  "x-content-type-options": "nosniff",
};

let dashboardCache = null;
let dashboardCachedAt = 0;
let lastDashboardAttemptAt = 0;
let refreshPromise = null;
let lastRefreshErrors = [];
let dashboardWritePromise = Promise.resolve();
let sourceLedger = hydrateSourceLedger(null);

const weights = INDICATOR_WEIGHTS;

const calendarService = createCalendarService({ fetchText, aiEarnings });
const publicationService = createPublicationService({ fetchText, onChange: () => publishDashboard() });
const earningsMonitor = createEarningsMonitor({ fetchText, aiEarnings, onChange: () => publishDashboard() });

const fredMeta = {
  DCOILBRENTEU: ["Brent 现货", "日度"],
  CPIAUCSL: ["整体 CPI", "月度"],
  CPIAUCNS: ["整体 CPI（未季调）", "月度"],
  CPILFESL: ["核心 CPI", "月度"],
  CPILFENS: ["核心 CPI（未季调）", "月度"],
  PCEPI: ["整体 PCE", "月度"],
  PCEPILFE: ["核心 PCE", "月度"],
  DFEDTARL: ["联邦基金目标下限", "日度"],
  DFEDTARU: ["联邦基金目标上限", "日度"],
  DGS2: ["2 年期美债收益率", "日度"],
  DGS10: ["10 年期美债收益率", "日度"],
  DFII10: ["10 年期实际利率", "日度"],
  T10Y3M: ["10 年-3 个月期限利差", "日度"],
  VIXCLS: ["VIX", "日度"],
  SP500: ["标普 500", "日度"],
  BAMLH0A0HYM2: ["美国高收益债 OAS", "日度"],
  DRTSCILM: ["银行收紧大中型企业贷款标准净比例", "季度"],
  SAHMREALTIME: ["Sahm Rule 实时指标", "月度"],
  ICSA: ["首次申请失业救济人数", "周度"],
  NFCI: ["芝加哥联储金融状况指数", "周度"],
  CP: ["美国税后企业利润", "季度"],
  UNRATE: ["美国失业率", "月度"],
  PAYEMS: ["美国非农就业人数", "月度"],
  CFNAIMA3: ["芝加哥联储经济活动三个月均值", "月度"],
};

function clamp(value, min = 0, max = 1) {
  return Math.min(max, Math.max(min, Number.isFinite(value) ? value : min));
}

function scale(value, low, high) {
  return clamp((value - low) / (high - low));
}

function round(value, digits = 2) {
  if (!Number.isFinite(value)) return null;
  const factor = 10 ** digits;
  return Math.round(value * factor) / factor;
}

function average(values) {
  const valid = values.filter(Number.isFinite);
  return valid.length ? valid.reduce((sum, value) => sum + value, 0) / valid.length : null;
}

function pctChange(current, previous) {
  return Number.isFinite(current) && Number.isFinite(previous) && previous !== 0
    ? ((current / previous) - 1) * 100
    : null;
}

function monthLabel(point) {
  if (!point?.date) return "数据期未知";
  const [year, month] = point.date.split("-");
  return `${year} 年 ${Number(month)} 月`;
}

function signedPercent(value, digits = 1) {
  if (!Number.isFinite(value)) return "--";
  return `${value >= 0 ? "+" : ""}${round(value, digits)}%`;
}

function latest(series) {
  return series?.at(-1) || null;
}

function statusFor(risk) {
  if (!Number.isFinite(risk)) return "unavailable";
  if (risk >= 0.8) return "critical";
  if (risk >= 0.55) return "high";
  if (risk >= 0.3) return "watch";
  return "low";
}

function spark(series, limit = 30) {
  return (series || []).slice(-limit).map((point) => ({ date: point.date, value: round(point.value, 3) }));
}

function sourceUrl(seriesId) {
  return `https://fred.stlouisfed.org/series/${seriesId}`;
}

async function fetchText(url, headers = {}, deadline = Infinity) {
  const remainingMs = deadline - Date.now();
  if (remainingMs <= 0) throw new Error("Market fetch budget exhausted");
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), Math.min(REQUEST_TIMEOUT_MS, remainingMs));
  try {
    const response = await fetch(url, {
      signal: controller.signal,
      headers: {
        "user-agent": "Mozilla/5.0 BearMarketRadar/1.0",
        ...headers,
      },
    });
    if (!response.ok) throw new Error(`${response.status} ${response.statusText}`);
    const text = await response.text();
    if (Date.now() >= deadline) throw new Error("Market fetch budget exhausted");
    return text;
  } finally {
    clearTimeout(timer);
    // Release unread error bodies as well as completed or timed-out requests.
    controller.abort();
  }
}

async function fetchJson(url, headers, deadline = Infinity) {
  const text = await fetchText(url, headers, deadline);
  return JSON.parse(text);
}

async function fetchFred(id, deadline = Infinity) {
  const start = new Date();
  start.setUTCFullYear(start.getUTCFullYear() - 3);
  const url = `https://fred.stlouisfed.org/graph/fredgraph.csv?id=${encodeURIComponent(id)}&cosd=${start.toISOString().slice(0, 10)}`;
  const series = parseFredCsv(await fetchText(url, {}, deadline));
  return requireFreshSeries(series, { name: fredMeta[id]?.[0] || id, maxAgeDays: fredMaxAgeDays[id] || 120 });
}

async function fetchNasdaq(symbol, assetClass, deadline = Infinity) {
  const start = new Date();
  start.setUTCFullYear(start.getUTCFullYear() - 2);
  const end = new Date();
  const url = `https://api.nasdaq.com/api/quote/${encodeURIComponent(symbol)}/historical?assetclass=${assetClass}&fromdate=${start.toISOString().slice(0, 10)}&todate=${end.toISOString().slice(0, 10)}&limit=5000`;
  const json = await fetchJson(url, undefined, deadline);
  const rows = json?.data?.tradesTable?.rows;
  if (!Array.isArray(rows)) throw new Error(json?.status?.bCodeMessage?.[0]?.errorMessage || `No data for ${symbol}`);
  const series = parseNasdaqRows(rows);
  return requireFreshSeries(series, { name: symbol, maxAgeDays: 14 });
}

async function mapLimit(items, limit, worker) {
  const results = new Array(items.length);
  let nextIndex = 0;
  async function run() {
    while (nextIndex < items.length) {
      const index = nextIndex++;
      results[index] = await worker(items[index], index);
    }
  }
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, run));
  return results;
}

async function safe(name, promise) {
  try {
    return { ok: true, data: await promise };
  } catch (error) {
    console.warn(`[data] ${name}: ${error.message}`);
    return { ok: false, data: [], error: error.message };
  }
}

async function retry(task, attempts = 2, deadline = Infinity) {
  let lastError;
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    if (Date.now() >= deadline) throw new Error("Market fetch budget exhausted");
    try {
      return await task();
    } catch (error) {
      lastError = error;
      if (attempt < attempts) {
        const delayMs = 350 * attempt;
        if (Date.now() + delayMs >= deadline) break;
        await new Promise((resolve) => setTimeout(resolve, delayMs));
      }
    }
  }
  throw lastError;
}

function seriesData(result) {
  return result?.ok ? result.data : [];
}

function indicator({ id, title, category, weight, risk, value, detail, date, description, why, source, cadence, confidence = "high", sparkline = [], available = true, unavailableReason = "数据不足", methodology = "", breakdown = null, judgment = null, inputDates }) {
  const normalizedRisk = available && Number.isFinite(risk) ? clamp(risk) : null;
  return {
    id,
    title,
    category,
    weight,
    risk: normalizedRisk === null ? null : round(normalizedRisk * 100, 1),
    points: normalizedRisk === null ? null : round(normalizedRisk * weight, 2),
    status: statusFor(normalizedRisk),
    value,
    detail,
    date,
    description,
    why,
    source,
    cadence,
    confidence,
    sparkline,
    available: normalizedRisk !== null,
    unavailableReason: normalizedRisk === null ? unavailableReason : null,
    methodology,
    breakdown,
    judgment,
    ...(inputDates ? { inputDates } : {}),
  };
}

async function buildDashboard({ fetchBudgetMs = MARKET_FETCH_BUDGET_MS } = {}) {
  const budgetMs = Number.isFinite(fetchBudgetMs) ? Math.min(MARKET_FETCH_BUDGET_MS, Math.max(0, fetchBudgetMs)) : MARKET_FETCH_BUDGET_MS;
  const deadline = Date.now() + budgetMs;
  const currentAiEarnings = calendarService.resolvedAiEarnings();
  const nextFomcDate = calendarService.nextFomc()?.date || "待官方公布";
  const fredIds = ["DCOILBRENTEU", "CPIAUCSL", "CPIAUCNS", "CPILFESL", "CPILFENS", "PCEPI", "PCEPILFE", "DFEDTARL", "DFEDTARU", "DGS2", "DGS10", "DFII10", "T10Y3M", "VIXCLS", "SP500", "BAMLH0A0HYM2", "DRTSCILM", "SAHMREALTIME", "ICSA", "NFCI", "UNRATE", "PAYEMS"];
  const marketSymbols = ["SPY", "RSP", "XLK", "XLF", "XLY", "XLC", "XLI", "XLV", "XLP", "XLE", "XLU", "XLRE", "XLB"];

  const [fredResults, marketResults] = await Promise.all([
    mapLimit(fredIds, 2, async (id) => [id, await safe(id, retry(() => fetchFred(id, deadline), 2, deadline))]),
    mapLimit(marketSymbols, 4, async (symbol) => [symbol, await safe(symbol, retry(() => fetchNasdaq(symbol, "etf", deadline), 2, deadline))]),
  ]);

  const fred = Object.fromEntries(fredResults);
  const market = Object.fromEntries(marketResults);
  const getFred = (id) => seriesData(fred[id]);
  const getMarket = (id) => seriesData(market[id]);

  const brent = getFred("DCOILBRENTEU");
  const brentLast = latest(brent);
  const brent20 = brent.length >= 20 ? average(brent.slice(-20).map((point) => point.value)) : null;
  const oilRisk = Number.isFinite(brent20)
    ? clamp(scale(brent20, 80, 110) * 0.75 + scale(brentLast?.value, 85, 115) * 0.25)
    : null;

  const cpiIds = ["CPIAUCSL", "CPIAUCNS", "CPILFESL", "CPILFENS"];
  const cpiInputs = cpiIds.map(getFred);
  const cpiLatestMonths = cpiInputs.map((series) => latest(series)?.date.slice(0, 7));
  const cpiMonth = cpiLatestMonths.every(Boolean) ? [...cpiLatestMonths].sort()[0] : null;
  const cpiAligned = cpiMonth && cpiInputs.every((series) => series.some((point) => point.date.slice(0, 7) === cpiMonth));
  const cpiAlignmentErrors = !cpiAligned
    ? ["CPI 子数据缺少共同月份，暂停相关评分"]
    : new Set(cpiLatestMonths).size > 1 ? [`CPI 来源月份不同，已对齐至 ${cpiMonth}，等待较新月份完整同步`] : [];
  // Join all CPI adjustment variants to one period before calculating changes.
  const [headlineCpi, headlineCpiNsa, coreCpi, coreCpiNsa] = cpiInputs.map((series) => cpiAligned
    ? series.filter((point) => point.date.slice(0, 7) <= cpiMonth) : []);
  const headlinePce = getFred("PCEPI");
  const corePce = getFred("PCEPILFE");
  const headlineCpiYoy = monthlyPercentChange(headlineCpiNsa, 12);
  const priorHeadlineCpiYoy = monthlyPercentChange(headlineCpiNsa, 12, 1);
  const headlineCpiMom = monthlyPercentChange(headlineCpi);
  const coreCpiYoy = monthlyPercentChange(coreCpiNsa, 12);
  const priorCoreCpiYoy = monthlyPercentChange(coreCpiNsa, 12, 1);
  const coreCpiMom = monthlyPercentChange(coreCpi);
  const headlinePceYoy = monthlyPercentChange(headlinePce, 12);
  const headlinePceMom = monthlyPercentChange(headlinePce);
  const corePceYoy = monthlyPercentChange(corePce, 12);
  const corePceMom = monthlyPercentChange(corePce);
  const headlineCpi3m = monthlyAnnualizedChange(headlineCpi, 3);
  const coreCpi3m = monthlyAnnualizedChange(coreCpi, 3);
  const pce3m = monthlyAnnualizedChange(corePce, 3);
  const inflationRisk = [headlineCpi3m, headlineCpiYoy, pce3m, coreCpi3m].every(Number.isFinite)
    ? clamp(
      scale(headlineCpi3m, 2.5, 7.0) * 0.35
      + scale(headlineCpiYoy, 2.5, 5.0) * 0.25
      + scale(pce3m, 2.2, 4.5) * 0.25
      + scale(coreCpi3m, 2.2, 4.0) * 0.15,
    )
    : null;
  const headlineAcceleration = Number.isFinite(headlineCpiYoy) && Number.isFinite(priorHeadlineCpiYoy)
    ? headlineCpiYoy - priorHeadlineCpiYoy
    : null;
  const coreAcceleration = Number.isFinite(coreCpiYoy) && Number.isFinite(priorCoreCpiYoy)
    ? coreCpiYoy - priorCoreCpiYoy
    : null;
  const inflationTrend = Number.isFinite(headlineAcceleration) && Number.isFinite(coreAcceleration)
    ? headlineAcceleration >= 0.15 && coreAcceleration >= -0.05
      ? {
        tone: "bad",
        label: "总体判断：恶化",
        text: `整体 CPI 同比比上月上升 ${round(headlineAcceleration, 1)} 个百分点，核心 CPI 同比${coreAcceleration >= 0 ? "也上升" : "仅小幅回落"}；能源冲击正在重新抬高通胀，而核心压力改善不足。`,
      }
      : headlineAcceleration <= -0.15 && coreAcceleration <= 0
        ? { tone: "good", label: "总体判断：改善", text: "整体与核心通胀同比同步回落，短期方向改善；仍需连续数月确认。" }
        : { tone: "mixed", label: "总体判断：分化", text: "整体与核心通胀方向不一致，暂时不能确认持续改善或全面恶化。" }
    : null;

  const fedRate = getFred("DFEDTARU");
  const fedRateLower = getFred("DFEDTARL");
  const fedLast = latest(fedRate);
  const fedLowerLast = latest(fedRateLower);
  const fedBounds = checkPolicyBounds(fedLowerLast, fedLast);
  const fedPrior = nearestPrior(fedRate, 100);
  const fedChange = fedLast && fedPrior ? fedLast.value - fedPrior.value : null;
  const twoYear = getFred("DGS2");
  const twoYearLast = latest(twoYear);
  const twoYearPrior = nearestPrior(twoYear, 90);
  const twoYearChange = twoYearLast && twoYearPrior ? twoYearLast.value - twoYearPrior.value : null;
  const policyGap = fedBounds.valid && twoYearLast ? twoYearLast.value - fedLast.value : null;

  const unemployment = getFred("UNRATE");
  const unemploymentLast = latest(unemployment);
  const unemployment3mChange = monthlyDifference(unemployment, 3);
  const payrolls = getFred("PAYEMS");
  const payrollLast = latest(payrolls);
  const payroll3mChange = monthlyDifference(payrolls, 3);
  const payroll6mChange = monthlyDifference(payrolls, 6);
  const payroll3mAvg = Number.isFinite(payroll3mChange) ? payroll3mChange / 3 : null;
  const payroll6mAvg = Number.isFinite(payroll6mChange) ? payroll6mChange / 6 : null;
  const payrollLatestChange = monthlyDifference(payrolls);
  const unemploymentHeat = unemploymentLast ? scale(5.0 - unemploymentLast.value, 0, 1.0) : null;
  const payrollHeat = Number.isFinite(payroll3mAvg) ? scale(payroll3mAvg, 75, 225) : null;
  const laborHeat = Number.isFinite(unemploymentHeat) && Number.isFinite(payrollHeat) ? average([unemploymentHeat, payrollHeat]) : null;
  const marketHawkishness = Number.isFinite(policyGap) && Number.isFinite(twoYearChange)
    ? average([scale(policyGap, -0.25, 0.75), scale(twoYearChange, 0, 0.75)])
    : null;
  const macroConstraint = Number.isFinite(inflationRisk) && Number.isFinite(laborHeat)
    ? average([inflationRisk, laborHeat])
    : null;
  const actualHikeRisk = Number.isFinite(fedChange) ? scale(fedChange, 0, 0.5) : null;
  const fedRisk = fedBounds.valid && [actualHikeRisk, marketHawkishness, macroConstraint].every(Number.isFinite)
    ? Math.max(actualHikeRisk, clamp(marketHawkishness * 0.55 + macroConstraint * 0.45))
    : null;

  const realYield = getFred("DFII10");
  const nominal10y = getFred("DGS10");
  const realLast = latest(realYield);
  const nominalLast = latest(nominal10y);
  const realYieldRisk = realLast && nominalLast
    ? clamp(scale(realLast.value, 1.3, 2.7) * 0.7 + scale(nominalLast.value, 4.2, 5.2) * 0.3)
    : null;

  const yieldCurve = getFred("T10Y3M");
  const yieldCurveLast = latest(yieldCurve);
  const curveWindowStart = yieldCurveLast ? Date.parse(yieldCurveLast.date) - 730 * 86_400_000 : null;
  const recentCurve = yieldCurveLast ? yieldCurve.filter((point) => Date.parse(point.date) >= curveWindowStart) : [];
  const curveMin = recentCurve.length ? Math.min(...recentCurve.map((point) => point.value)) : null;
  let curveCrossDate = null;
  for (let index = 1; index < recentCurve.length; index += 1) {
    if (recentCurve[index - 1].value <= 0 && recentCurve[index].value > 0) curveCrossDate = recentCurve[index].date;
  }
  const daysSinceCurveCross = yieldCurveLast && curveCrossDate
    ? Math.round((Date.parse(yieldCurveLast.date) - Date.parse(curveCrossDate)) / 86_400_000)
    : null;
  const curveWindowRisk = Number.isFinite(daysSinceCurveCross)
    ? (daysSinceCurveCross <= 540 ? scale(daysSinceCurveCross, 0, 90) : clamp(1 - (daysSinceCurveCross - 540) / 270))
    : 0;
  const yieldCurveRisk = Number.isFinite(curveMin) && yieldCurveLast
    ? Math.min(0.85, clamp(scale(-curveMin, 0.25, 1.5) * 0.65 + curveWindowRisk * 0.35))
    : null;
  const ratesRisk = Number.isFinite(realYieldRisk) && Number.isFinite(yieldCurveRisk)
    ? clamp(realYieldRisk * 0.72 + yieldCurveRisk * 0.28)
    : null;

  const vix = getFred("VIXCLS");
  const vixLast = latest(vix);
  const vix20 = vix.length >= 20 ? average(vix.slice(-20).map((point) => point.value)) : null;
  const vixRisk = Number.isFinite(vix20)
    ? clamp(scale(vix20, 16, 32) * 0.7 + scale(vixLast?.value, 18, 38) * 0.3)
    : null;

  const sp500 = getFred("SP500");
  const spLast = latest(sp500);
  const oneYear = sp500.slice(-252);
  const high52 = oneYear.length >= 252 ? Math.max(...oneYear.map((point) => point.value)) : null;
  const drawdown = spLast && high52 ? (1 - spLast.value / high52) * 100 : null;
  const spMa200 = sp500.length >= 200 ? average(sp500.slice(-200).map((point) => point.value)) : null;
  const below200 = spLast && Number.isFinite(spMa200) ? spLast.value < spMa200 : null;
  const spRisk = Number.isFinite(drawdown) && Number.isFinite(spMa200)
    ? clamp(
      (drawdown <= 5 ? 0.12 + scale(drawdown, 0, 5) * 0.13 : 0.25 + scale(drawdown, 5, 20) * 0.55)
      + (below200 ? 0.20 : 0),
    )
    : null;

  const credit = getFred("BAMLH0A0HYM2");
  const creditLast = latest(credit);
  const creditPrior = nearestPrior(credit, 90);
  const creditMove = creditLast && creditPrior ? creditLast.value - creditPrior.value : null;
  const creditRisk = creditLast && Number.isFinite(creditMove)
    ? clamp(scale(creditLast.value, 3.0, 6.0) * 0.8 + scale(creditMove, 0.25, 2.0) * 0.2)
    : null;

  const lending = getFred("DRTSCILM");
  const lendingLast = latest(lending);
  const lendingRisk = lendingLast ? scale(lendingLast.value, 0, 40) : null;

  const sahm = getFred("SAHMREALTIME");
  const claims = getFred("ICSA");
  const sahmLast = latest(sahm);
  const claims4 = claims.length >= 4 ? average(claims.slice(-4).map((point) => point.value)) : null;
  const claims52Low = claims.length >= 52 ? Math.min(...claims.slice(-52).map((point) => point.value)) : null;
  const claimsRise = Number.isFinite(claims4) && Number.isFinite(claims52Low) ? pctChange(claims4, claims52Low) : null;
  const laborRisk = sahmLast && Number.isFinite(claimsRise)
    ? clamp(scale(sahmLast.value, 0.15, 0.5) * 0.7 + scale(claimsRise, 8, 30) * 0.3)
    : null;
  const unemploymentDeterioration = unemploymentLast && Number.isFinite(unemployment3mChange)
    ? clamp(scale(unemploymentLast.value, 4.5, 6.0) * 0.35 + scale(unemployment3mChange, 0.1, 0.6) * 0.65)
    : null;
  const unemploymentPolicyPressure = Number.isFinite(unemploymentHeat) && Number.isFinite(inflationRisk)
    ? unemploymentHeat * inflationRisk * 0.62
    : null;
  const unemploymentRisk = Number.isFinite(unemploymentDeterioration) && Number.isFinite(unemploymentPolicyPressure)
    ? Math.max(unemploymentDeterioration, unemploymentPolicyPressure)
    : null;
  const payrollDeterioration = Number.isFinite(payroll3mAvg)
    ? scale(110 - payroll3mAvg, 0, 110)
    : null;
  const payrollPolicyPressure = Number.isFinite(payrollHeat) && Number.isFinite(inflationRisk)
    ? payrollHeat * inflationRisk * 0.72
    : null;
  const payrollRisk = Number.isFinite(payrollDeterioration) && Number.isFinite(payrollPolicyPressure)
    ? Math.max(payrollDeterioration, payrollPolicyPressure)
    : null;

  const spy = getMarket("SPY");
  const rsp = getMarket("RSP");
  const breadthWindow = relativePerformance(spy, rsp);
  const relative60 = breadthWindow?.value ?? null;
  const sectorSymbols = ["XLK", "XLF", "XLY", "XLC", "XLI", "XLV", "XLP", "XLE", "XLU", "XLRE", "XLB"];
  const sectorTrends = sectorSymbols.map((symbol) => {
    const series = breadthWindow ? getMarket(symbol).filter((point) => point.date <= breadthWindow.date) : [];
    if (series.length < 200 || latest(series)?.date !== breadthWindow?.date) return null;
    const current = latest(series)?.value;
    const ma200 = average(series.slice(-200).map((point) => point.value));
    return Number.isFinite(current) && Number.isFinite(ma200) ? { symbol, below200: current < ma200 } : null;
  }).filter(Boolean);
  const availableSectorCount = sectorTrends.length;
  const belowSectorCount = sectorTrends.filter((item) => item.below200).length;
  const breadthRisk = Number.isFinite(relative60) && availableSectorCount >= 8
    ? clamp(scale(-relative60, 0, 8) * 0.45 + (belowSectorCount / availableSectorCount) * 0.55)
    : null;
  const breadthDetail = !breadthWindow
    ? "SPY/RSP 缺少同日起止价格，暂不计分"
    : `RSP 相对 SPY 收益差（百分点）；${breadthWindow.startDate} 至 ${breadthWindow.date}；${availableSectorCount >= 8
      ? `${availableSectorCount} 个同日行业中 ${belowSectorCount} 个低于 200 日线`
      : `仅 ${availableSectorCount}/11 个行业有同日价格与足够历史，暂不计分`}`;

  const nfci = getFred("NFCI");
  const nfciLast = latest(nfci);
  const nfciRisk = nfciLast ? scale(nfciLast.value, -0.5, 0.5) : null;
  const unemploymentComposite = Number.isFinite(unemploymentRisk) && Number.isFinite(laborRisk)
    ? clamp(unemploymentRisk * 0.65 + laborRisk * 0.35)
    : null;
  const creditComposite = [creditRisk, lendingRisk, nfciRisk].every(Number.isFinite)
    ? clamp(creditRisk * 0.65 + lendingRisk * 0.25 + nfciRisk * 0.10)
    : null;


  const indicators = [
    indicator({
      id: "oil", title: "原油价格与能源冲击", category: "通胀与政策", weight: weights.oil, risk: oilRisk,
      value: brentLast ? `$${round(brentLast.value, 2)}` : "暂无数据", detail: `20 日均价 ${Number.isFinite(brent20) ? `$${round(brent20, 2)}` : "--"}`,
      date: brentLast?.date, description: "同时观察油价水平、持续时间和供应冲击，而不是把单日冲高直接判成危机。", why: "持续能源冲击会抬高通胀预期、压缩消费与企业利润。",
      source: { label: "FRED · Brent 现货", url: sourceUrl("DCOILBRENTEU") }, cadence: "交易日", confidence: "high", sparkline: spark(brent), methodology: "20 日均价为主、最新价为辅；80 至 110 美元逐步映射风险。",
    }),
    indicator({
      id: "inflation", title: "CPI / PCE 通胀趋势", category: "通胀与政策", weight: weights.inflation, risk: inflationRisk,
      value: Number.isFinite(headlineCpiYoy) ? `${round(headlineCpiYoy, 1)}%` : "暂无数据", detail: `整体 CPI 同比；三个月年化 ${Number.isFinite(headlineCpi3m) ? round(headlineCpi3m, 1) : "--"}%`,
      date: latest(headlineCpiNsa)?.date || latest(headlineCpi)?.date, description: "同比采用 BLS 未季调正式口径，月率与三个月年化采用季调数据；重点看核心 CPI、核心 PCE 的短期趋势。卡片日期表示最新数据期，不冒充官方发布日期。", why: "通胀黏性决定美联储能否降息，也决定估值压力会持续多久。",
      source: { label: "BLS / BEA / FRED · CPI 与 PCE", url: "https://www.bls.gov/news.release/cpi.nr0.htm" }, cadence: "月度", confidence: Number.isFinite(inflationRisk) ? "high" : "unavailable", unavailableReason: "子数据不足", sparkline: spark(headlineCpi, 18), methodology: "CPI 四条季调与未季调序列先对齐同月；整体 CPI 三个月年化和同比占 60%，核心 PCE 与核心 CPI 占 40%。",
      inputDates: { headlinePce: latest(headlinePce)?.date ?? null, corePce: latest(corePce)?.date ?? null },
      breakdown: [
        { label: "CPI", value: Number.isFinite(headlineCpiYoy) ? `${round(headlineCpiYoy, 1)}%` : "--", detail: `${monthLabel(latest(headlineCpiNsa) || latest(headlineCpi))} · 月率 ${signedPercent(headlineCpiMom)}` },
        { label: "核心 CPI", value: Number.isFinite(coreCpiYoy) ? `${round(coreCpiYoy, 1)}%` : "--", detail: `${monthLabel(latest(coreCpiNsa) || latest(coreCpi))} · 月率 ${signedPercent(coreCpiMom)}` },
        { label: "PCE", value: Number.isFinite(headlinePceYoy) ? `${round(headlinePceYoy, 1)}%` : "--", detail: `${monthLabel(latest(headlinePce))} · 月率 ${signedPercent(headlinePceMom)}` },
        { label: "核心 PCE", value: Number.isFinite(corePceYoy) ? `${round(corePceYoy, 1)}%` : "--", detail: `${monthLabel(latest(corePce))} · 月率 ${signedPercent(corePceMom)}` },
      ],
      judgment: inflationTrend,
    }),
    indicator({
      id: "fed", title: "美联储政策周期", category: "通胀与政策", weight: weights.fed, risk: fedRisk,
      value: fedBounds.valid ? `${round(fedLowerLast.value, 2)}%–${round(fedLast.value, 2)}%` : fedBounds.reason || "暂无数据", detail: `${fedBounds.reason || "当前联邦基金目标区间"}；下次会议 ${nextFomcDate}；2 年期 ${twoYearLast ? round(twoYearLast.value, 2) : "--"}%`,
      date: fedLast?.date, description: "用联邦基金目标区间、2 年期美债和宏观约束判断市场是否在重新定价政策路径。", why: "政策收紧会压制估值和融资；2 年期利率比未经自动核验的概率快照更适合持续监测。",
      source: { label: "Federal Reserve / FRED · 政策利率", url: sourceUrl("DFEDTARU") }, cadence: "交易日 / 会议", confidence: Number.isFinite(fedRisk) ? "high" : "unavailable", unavailableReason: fedBounds.reason || "子数据不足", sparkline: spark(twoYear, 90), methodology: "市场利率重定价、实际政策变化、通胀和就业约束共同评分；子数据不足时不计分。",
      breakdown: [
        { label: "政策目标下限", value: fedLowerLast ? `${round(fedLowerLast.value, 2)}%` : "--", detail: fedLowerLast?.date || "" },
        { label: "政策目标上限", value: fedLast ? `${round(fedLast.value, 2)}%` : "--", detail: fedLast?.date || "" },
        { label: "2 年期美债", value: twoYearLast ? `${round(twoYearLast.value, 2)}%` : "--", detail: twoYearLast?.date || "" },
      ],
      judgment: Number.isFinite(policyGap) ? {
        tone: policyGap > 0.25 ? "bad" : policyGap < -0.25 ? "good" : "mixed",
        label: "市场定价",
        text: `2 年期美债相对政策上限${policyGap >= 0 ? "高" : "低"} ${Math.abs(round(policyGap, 2))} 个百分点，${policyGap > 0.25 ? "市场仍在计入偏紧政策风险。" : policyGap < -0.25 ? "市场正在计入未来宽松空间。" : "市场利率与当前政策区间较为接近。"}`,
      } : null,
    }),
    indicator({
      id: "rates", title: "10年期美债与实际利率", category: "通胀与政策", weight: weights.rates, risk: ratesRisk,
      value: nominalLast ? `${round(nominalLast.value, 2)}%` : "暂无数据", detail: `10 年期名义收益率；实际利率 ${realLast ? round(realLast.value, 2) : "--"}%；10Y-3M ${yieldCurveLast ? `${yieldCurveLast.value >= 0 ? "+" : ""}${round(yieldCurveLast.value, 2)}%` : "--"}`,
      date: nominalLast?.date, description: "观察 10 年期名义与实际利率水平，以及期限曲线倒挂和重新转正的周期信号；当前评分未纳入利率上涨速度。", why: "实际利率决定股票折现压力，期限结构则反映融资与衰退风险。",
      source: { label: "U.S. Treasury / FRED · 10Y", url: "https://home.treasury.gov/resource-center/data-chart-center/interest-rates/TextView?type=daily_treasury_yield_curve" }, cadence: "交易日", confidence: Number.isFinite(ratesRisk) ? "high" : "unavailable", unavailableReason: "子数据不足", sparkline: spark(nominal10y, 90), methodology: "实际与名义收益率压力占 72%，期限曲线周期风险占 28%；两组输入齐全才计分。",
      breakdown: [
        { label: "10年期名义", value: nominalLast ? `${round(nominalLast.value, 2)}%` : "--", detail: nominalLast?.date || "" },
        { label: "10年期实际", value: realLast ? `${round(realLast.value, 2)}%` : "--", detail: realLast?.date || "" },
        { label: "10Y-3M", value: yieldCurveLast ? `${yieldCurveLast.value >= 0 ? "+" : ""}${round(yieldCurveLast.value, 2)}%` : "--", detail: "期限利差" },
      ],
    }),
    indicator({
      id: "vix", title: "VIX 市场波动率", category: "市场确认", weight: weights.vix, risk: vixRisk,
      value: vixLast ? round(vixLast.value, 2).toString() : "暂无数据", detail: `20 日均值 ${Number.isFinite(vix20) ? round(vix20, 2) : "--"}`,
      date: vixLast?.date, description: "低于 15 可能过度乐观，20 以上进入警戒，30 以上代表明显恐慌。", why: "VIX 是压力温度计，持续高位比单日尖峰更重要。",
      source: { label: "Cboe / FRED · VIX", url: "https://www.cboe.com/tradable_products/vix/" }, cadence: "交易日", confidence: "high", sparkline: spark(vix), methodology: "20 日均值为主、最新值为辅。",
    }),
    indicator({
      id: "unemployment", title: "美国失业率", category: "就业与经济", weight: weights.unemployment, risk: unemploymentComposite,
      value: unemploymentLast ? `${round(unemploymentLast.value, 1)}%` : "暂无数据", detail: `三个月 ${Number.isFinite(unemployment3mChange) ? `${unemployment3mChange >= 0 ? "+" : ""}${round(unemployment3mChange, 1)}` : "--"} 个百分点；Sahm ${sahmLast ? round(sahmLast.value, 2) : "--"}`,
      date: unemploymentLast?.date, description: "观察本月失业率与三个月前相比的变化，并用基于三个月平均值的 Sahm 规则及初请失业金交叉验证。", why: "就业恶化会削弱消费和盈利，并可能把估值调整升级为衰退型熊市。",
      source: { label: "BLS / FRED · Unemployment / Sahm", url: sourceUrl("UNRATE") }, cadence: "月度/周度", confidence: Number.isFinite(unemploymentComposite) ? "high" : "unavailable", unavailableReason: "子数据不足", sparkline: spark(unemployment, 24), methodology: "失业率变化与政策压力占 65%，Sahm 与初请变化占 35%；子数据不足时不计分。",
    }),
    indicator({
      id: "payrolls", title: "非农就业数据", category: "就业与经济", weight: weights.payrolls, risk: payrollRisk,
      value: Number.isFinite(payrollLatestChange) ? `${round(payrollLatestChange, 0)}k` : "暂无数据", detail: `三个月平均 ${Number.isFinite(payroll3mAvg) ? round(payroll3mAvg, 0) : "--"}k；六个月平均 ${Number.isFinite(payroll6mAvg) ? round(payroll6mAvg, 0) : "--"}k`,
      date: payrollLast?.date, description: "使用当前可得的非农就业总量计算单月增量、三个月和六个月平均；当前评分未纳入历史版本修正、平均工时或行业分布。", why: "单月数据噪声很大，持续转弱才意味着需求与企业盈利下行。",
      source: { label: "BLS / FRED · Nonfarm Payrolls", url: sourceUrl("PAYEMS") }, cadence: "月度", confidence: Number.isFinite(payrollRisk) ? "high" : "unavailable", unavailableReason: "子数据不足", sparkline: spark(payrolls, 24), methodology: "取三个月就业恶化与高通胀下的政策约束风险中较高值；两组输入齐全才计分。",
    }),
    resolveAiIndicator(indicator({
      id: "aiEarnings", title: "AI 产业链财报与指引", category: "盈利与AI", weight: weights.aiEarnings, risk: null,
      value: "", detail: "仅让仍在有效期内的财报解读参与评分；下次财报日期单独自动同步",
      date: null, description: "按算力与互连、晶圆与先进封装、云资本开支、HBM 与存储四层监测行业巨头。过期解读会明确标记并退出自动评分。", why: "这些公司的指引能同时改变 AI 需求、供给、带宽和资本开支预期，比单纯按市值选股更接近产业链真实风险。",
      source: { label: "公司 IR / SEC 原始文件", url: aiEarnings[1].source }, cadence: "季度", confidence: "medium", sparkline: [], methodology: "仅使用尚未跨过公司确认或自动抓取的下一次财报日、且资料期不超过 120 天的公司指引；加入 3 分产业集中度溢价，支持人工覆盖。",
    }), currentAiEarnings),
    indicator({
      id: "credit", title: "信用利差与银行信贷", category: "信用", weight: weights.credit, risk: creditComposite,
      value: creditLast ? `${round(creditLast.value * 100, 0)} bp` : "暂无数据", detail: `高收益债 OAS；SLOOS 净收紧 ${lendingLast ? `${round(lendingLast.value, 1)}%` : "--"}；NFCI ${nfciLast ? round(nfciLast.value, 2) : "--"}`,
      date: creditLast?.date, description: "把高收益债利差、银行贷款标准与综合金融条件合并成最高权重的信用信号。", why: "信用压力决定企业能否融资，是系统性风险从市场传向实体经济的关键通道。",
      source: { label: "FRED / Fed SLOOS · Credit", url: sourceUrl("BAMLH0A0HYM2") }, cadence: "交易日/季度", confidence: Number.isFinite(creditComposite) ? "high" : "unavailable", unavailableReason: "子数据不足", sparkline: spark(credit), methodology: "高收益债利差占 65%，SLOOS 占 25%，NFCI 占 10%；三项齐全才计分。",
      breakdown: [
        { label: "高收益债 OAS", value: creditLast ? `${round(creditLast.value * 100, 0)} bp` : "--", detail: creditLast?.date || "" },
        { label: "SLOOS 净收紧", value: lendingLast ? `${round(lendingLast.value, 1)}%` : "--", detail: lendingLast?.date || "" },
        { label: "NFCI", value: nfciLast ? String(round(nfciLast.value, 2)) : "--", detail: nfciLast?.date || "" },
      ],
    }),
    indicator({
      id: "earningsBreadth", title: "标普 500 整体盈利预期", category: "盈利与AI", weight: weights.earningsBreadth, risk: null,
      value: "待接入", detail: "免费公开源无法稳定提供每周 EPS 上调/下调广度，暂不以旧快照计分",
      date: null, description: "观察未来 12 个月 EPS 是否连续 8 至 12 周下修，并检查下修是否扩散。", why: "盈利下调从科技扩散至金融、工业和消费时，熊市风险会显著上升。",
      source: { label: "S&P Global · S&P 500", url: "https://www.spglobal.com/spdji/en/indices/equity/sp-500/" }, cadence: "需要专业数据", confidence: "manual", sparkline: [], available: false, unavailableReason: "待接入", methodology: "该项需要 FactSet、Bloomberg 或同等级 EPS 修正广度；接入前保持未计分，也可人工覆盖。",
    }),
    indicator({
      id: "breadth", title: "市场宽度", category: "市场确认", weight: weights.breadth, risk: breadthRisk,
      value: Number.isFinite(relative60) ? `${relative60 >= 0 ? "+" : ""}${round(relative60, 1)}` : "暂无数据", detail: breadthDetail,
      date: breadthWindow?.date, description: "用等权指数、行业趋势和 200 日均线判断上涨是否只靠少数巨头。收益差从共同截至日回溯 SPY 的 60 个交易日，使用同一起止日期，行业也对齐同一截至日。", why: "指数创新高而多数股票走弱，说明内部结构已经脆化。",
      source: { label: "Nasdaq · SPY / RSP / Sector ETFs", url: "https://www.nasdaq.com/market-activity/etf/rsp/historical" }, cadence: "交易日", confidence: "proxy", sparkline: spark(rsp.filter((point) => !breadthWindow || point.date <= breadthWindow.date), 60), methodology: "RSP 相对 SPY 落后幅度占 45%，行业跌破 200 日线比例占 55%；缺少共同基期或少于 8 个同日行业时暂停计分。",
    }),
    indicator({
      id: "sp500", title: "标普 500 距 52 周高点跌幅", category: "市场确认", weight: weights.sp500, risk: spRisk,
      value: Number.isFinite(drawdown) ? `-${round(drawdown, 1)}%` : "暂无数据", detail: `${spLast ? round(spLast.value, 2).toLocaleString("en-US") : "--"}；${below200 === null ? "200 日历史不足" : below200 ? "低于 200 日线" : "高于 200 日线"}`,
      date: spLast?.date, description: "0%-5% 为正常高位，10%-15% 为明显调整，20% 以上确认技术性熊市。", why: "这是结果确认指标，因此权重低于信用、通胀和盈利。",
      source: { label: "FRED · S&P 500", url: sourceUrl("SP500") }, cadence: "交易日", confidence: "high", sparkline: spark(sp500, 60), methodology: "高位 0%-5% 先计 12%-25% 脆弱风险，5%-20% 逐步升高；跌破 200 日线额外确认。",
    }),
  ].map(normalizeIndicator);

  const scoringContext = { drawdownPercent: drawdown, breadthRiskPercent: Number.isFinite(breadthRisk) ? breadthRisk * 100 : null };
  const { available, ...model } = computeScores(indicators, scoringContext);
  const categories = ["通胀与政策", "信用", "盈利与AI", "就业与经济", "市场确认"].map((name) => {
    const items = available.filter((item) => item.category === name);
    const weight = items.reduce((sum, item) => sum + item.weight, 0);
    const points = items.reduce((sum, item) => sum + item.points, 0);
    return { name, score: weight ? round((points / weight) * 100, 1) : null, weight };
  });

  return {
    dataQualityVersion: 1,
    productVersion,
    buildCommit,
    generatedAt: new Date().toISOString(),
    _sourceObservations: Object.fromEntries(fredResults.filter(([, result]) => result.ok).map(([id, result]) => [id, result.data])),
    ...model,
    scoringContext,
    validationReference: spLast ? { series: "SP500", date: spLast.date, close: spLast.value } : null,
    action: actionFor(model.score, model.coverage),
    categories,
    indicators,
    aiEarnings: currentAiEarnings,
    aiChainLayers,
    reminders: calendarService.buildReminders(),
    calendarSchedule: calendarService.snapshot(),
    calendarSync: calendarService.syncStatus(),
    methodology: {
      version: SCORING_VERSION,
      note: SCORING_NOTE,
      bands: [
        { min: 0, max: 20, label: "健康、风险较低" },
        { min: 21, max: 40, label: "正常波动" },
        { min: 41, max: 60, label: "黄色警戒" },
        { min: 61, max: 75, label: "橙色警报" },
        { min: 76, max: 100, label: "红色警报" },
      ],
    },
    errors: [
      ...cpiAlignmentErrors,
      ...(fedBounds.error ? [fedBounds.error] : []),
      ...fredResults.filter(([, result]) => !result.ok).map(([id, result]) => `${fredMeta[id]?.[0] || id}: ${result.error}`),
      ...marketResults.filter(([, result]) => !result.ok).map(([id, result]) => `${id}: ${result.error}`),
    ],
  };
}

function contentType(filePath) {
  const ext = path.extname(filePath);
  return ({ ".html": "text/html; charset=utf-8", ".css": "text/css; charset=utf-8", ".js": "text/javascript; charset=utf-8", ".json": "application/json; charset=utf-8", ".svg": "image/svg+xml" })[ext] || "application/octet-stream";
}

function sendJson(res, status, payload) {
  res.writeHead(status, { ...SECURITY_HEADERS, "content-type": "application/json; charset=utf-8", "cache-control": "no-store" });
  res.end(JSON.stringify(payload));
}

function persistDashboard(snapshot) {
  const contents = JSON.stringify(snapshot);
  const temporaryFile = `${dashboardCacheFile}.${randomUUID()}.tmp`;
  dashboardWritePromise = dashboardWritePromise
    .then(async () => {
      try {
        await writeFile(temporaryFile, contents, { flag: "wx" });
        await rename(temporaryFile, dashboardCacheFile);
      } finally {
        await unlink(temporaryFile).catch((error) => {
          if (error.code !== "ENOENT") console.warn(`[cache] cleanup failed: ${error.message}`);
        });
      }
    })
    .catch((error) => console.warn(`[cache] write failed: ${error.message}`));
  return dashboardWritePromise;
}

function resolveDashboardCalendar(snapshot) {
  const nextFomcDate = calendarService.nextFomc()?.date || "待官方公布";
  const indicators = snapshot.indicators.map((item) => {
    if (item.id !== "fed") return item;
    const twoYear = item.breakdown?.find((row) => row.label === "2 年期美债")?.value;
    const historicalYield = item.sparkline?.at(-1)?.value;
    const twoYearLabel = typeof twoYear === "string" ? twoYear : Number.isFinite(historicalYield) ? `${round(historicalYield, 2)}%` : "--";
    const policyLabel = item.detail?.split("；")[0] || "当前联邦基金目标区间";
    return { ...item, detail: `${policyLabel}；下次会议 ${nextFomcDate}；2 年期 ${twoYearLabel}` };
  });
  return projectDashboard({
    ...snapshot,
    indicators,
    reminders: calendarService.buildReminders(),
    aiEarnings: calendarService.resolvedAiEarnings(),
    calendarSchedule: calendarService.snapshot(),
    calendarSync: calendarService.syncStatus(),
    publicationSchedule: publicationService.snapshot(),
    earningsSchedule: earningsMonitor.snapshot(),
  });
}

function publishDashboard(snapshot = dashboardCache) {
  if (!snapshot) return Promise.resolve(null);
  dashboardCache = resolveDashboardCalendar({ ...snapshot, sourceLedger });
  return persistDashboard(dashboardCache).then(() => dashboardCache);
}

function refreshDashboard(force = false) {
  if (refreshPromise) return refreshPromise;
  const cooldownMs = force ? FORCE_REFRESH_COOLDOWN_MS : CACHE_TTL_MS;
  if (lastDashboardAttemptAt && Date.now() - lastDashboardAttemptAt < cooldownMs) {
    return Promise.resolve(dashboardCache);
  }
  lastDashboardAttemptAt = Date.now();
  const calendarRefresh = Promise.resolve()
    .then(() => calendarService.refresh({ force }))
    .catch((error) => console.warn(`[calendar] refresh failed: ${error.message}`))
    .then(() => publishDashboard());
  const publicationRefresh = Promise.resolve()
    .then(() => publicationService.refresh({ force }))
    .catch((error) => console.warn(`[publication] refresh failed: ${error.message}`))
    .then(() => publishDashboard());
  const earningsRefresh = Promise.resolve()
    .then(() => earningsMonitor.refresh({ force }))
    .catch((error) => console.warn(`[earnings-monitor] refresh failed: ${error.message}`))
    .then(() => publishDashboard());
  const marketRefresh = Promise.resolve()
    .then(() => buildDashboard())
    .then((next) => {
      const { _sourceObservations, ...marketSnapshot } = next;
      sourceLedger = updateSourceLedger(sourceLedger, _sourceObservations, new Date().toISOString()).ledger;
      lastRefreshErrors = next.errors;
      const resolved = resolveDashboardCalendar(marketSnapshot);
      // Official evidence may make a previously higher-coverage cache obsolete.
      // Project both candidates before the existing cache-retention comparison.
      if (dashboardCache) dashboardCache = resolveDashboardCalendar(dashboardCache);
      if (shouldReplaceDashboard(dashboardCache, resolved)) {
        dashboardCache = resolved;
        dashboardCachedAt = Date.now();
      }
      return publishDashboard();
    })
    .catch((error) => {
      console.warn(`[dashboard] refresh failed: ${error.message}`);
      lastRefreshErrors = [error.message];
      return dashboardCache;
    });
  // Market publication is independent; calendars and publication checks also settle.
  refreshPromise = Promise.allSettled([marketRefresh, calendarRefresh, publicationRefresh, earningsRefresh])
    .then((results) => {
      const failed = results.find((result) => result.status === "rejected");
      if (failed) {
        console.warn(`[dashboard] refresh failed: ${failed.reason.message}`);
        lastRefreshErrors = [failed.reason.message];
      }
      return dashboardCache;
    })
    .finally(() => { refreshPromise = null; });
  return refreshPromise;
}

async function handleRequest(req, res) {
  if (req.method !== "GET" && req.method !== "HEAD") {
    req.resume();
    res.setHeader("allow", "GET, HEAD");
    return sendJson(res, 405, { error: "Method not allowed" });
  }
  let url;
  try {
    // Routing never needs the client-provided Host header.
    url = new URL(req.url, "http://localhost");
  } catch {
    return sendJson(res, 400, { error: "Invalid request URL" });
  }

  if (url.pathname === "/api/dashboard") {
    const force = req.method === "GET" && url.searchParams.get("refresh") === "1";
    if (!dashboardCache) {
      refreshDashboard();
      return sendJson(res, 202, { warming: true, message: "正在同步最新数据" });
    }
    const fresh = Date.now() - dashboardCachedAt < CACHE_TTL_MS;
    if (force) refreshDashboard(true);
    else if (!fresh) refreshDashboard();
    const cacheAgeMs = Math.max(0, Date.now() - dashboardCachedAt);
    const { sourceLedger: _privateLedger, ...publicCache } = dashboardCache;
    return sendJson(res, 200, projectDashboard({
      ...publicCache,
      productVersion,
      buildCommit,
      validationReference: dashboardCache.validationReference ?? null,
      sourceRevisions: sourceLedger.revisions.map(row => ({ ...row, label: fredMeta[row.series]?.[0] || row.series })),
      ...(url.searchParams.get("evidence") === "1" ? { sourceLedger } : {}),
      reminders: calendarService.buildReminders(),
      aiEarnings: calendarService.resolvedAiEarnings(),
      calendarSchedule: calendarService.snapshot(),
      calendarSync: calendarService.syncStatus(),
      publicationSchedule: publicationService.snapshot(),
      earningsSchedule: earningsMonitor.snapshot(),
      errors: lastRefreshErrors.length ? lastRefreshErrors : dashboardCache.errors,
      cache: !force && cacheAgeMs < CACHE_TTL_MS,
      stale: cacheAgeMs >= CACHE_TTL_MS,
      refreshing: Boolean(refreshPromise),
      cacheAgeMs,
    }));
  }

  const requested = url.pathname === "/" ? "/index.html" : url.pathname;
  const normalized = path.normalize(requested).replace(/^(\.\.(\/|\\|$))+/, "");
  const filePath = path.join(publicDir, normalized);
  if (!filePath.startsWith(publicDir)) {
    res.writeHead(403, SECURITY_HEADERS);
    return res.end("Forbidden");
  }
  try {
    const data = await readFile(filePath);
    res.writeHead(200, { ...SECURITY_HEADERS, "content-type": contentType(filePath), "cache-control": "no-cache" });
    res.end(data);
  } catch {
    res.writeHead(404, { ...SECURITY_HEADERS, "content-type": "text/plain; charset=utf-8" });
    res.end("Not found");
  }
}

const server = http.createServer((req, res) => {
  handleRequest(req, res).catch((error) => {
    console.warn(`[http] request failed: ${error.message}`);
    if (!res.headersSent && !res.destroyed) sendJson(res, 500, { error: "Request failed" });
    else res.destroy();
  });
});

try {
  dashboardCache = JSON.parse(await readFile(dashboardCacheFile, "utf8"));
  if (!isDashboardSnapshot(dashboardCache)) throw new Error("Invalid dashboard cache");
  // Legacy error snapshots predate composite-dependency integrity checks.
  if (dashboardCache.dataQualityVersion === undefined && dashboardCache.errors?.length) {
    throw new Error("Unverified composite integrity in legacy dashboard cache");
  }
  dashboardCachedAt = Math.min(Date.now(), Date.parse(dashboardCache.generatedAt) || 0);
  lastRefreshErrors = Array.isArray(dashboardCache.errors) ? dashboardCache.errors : [];
  calendarService.hydrate(dashboardCache.calendarSchedule);
  publicationService.hydrate(dashboardCache.publicationSchedule);
  earningsMonitor.hydrate(dashboardCache.earningsSchedule);
  sourceLedger = hydrateSourceLedger(dashboardCache.sourceLedger);
} catch {
  dashboardCache = null;
}

// Repository checkpoints survive host rebuilds; service hydration never rolls proof backward.
try {
  const checkpoint = JSON.parse(await readFile(path.join(__dirname, "evidence/source-ledger.json"), "utf8"));
  if (!Object.keys(sourceLedger.sources).length) sourceLedger = hydrateSourceLedger(checkpoint);
  publicationService.hydrate(checkpoint.publicationSchedule);
  earningsMonitor.hydrate(checkpoint.earningsSchedule);
} catch { /* First deployment can legitimately have no recorded baseline. */ }

server.listen(port, host, () => {
  const displayHost = host === "0.0.0.0" ? "127.0.0.1" : host;
  console.log(`kk的美股雷达已启动：http://${displayHost}:${port}`);
  refreshDashboard();
  const timer = setInterval(() => refreshDashboard(), CACHE_TTL_MS);
  timer.unref();
});
