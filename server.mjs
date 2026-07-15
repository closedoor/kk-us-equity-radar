import http from "node:http";
import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const publicDir = path.join(__dirname, "public");
const dashboardCacheFile = path.join(__dirname, "dashboard-cache.json");
const port = Number(process.env.PORT || 4173);
const host = process.env.HOST || "0.0.0.0";
const CACHE_TTL_MS = 15 * 60 * 1000;
const REQUEST_TIMEOUT_MS = 25_000;

let dashboardCache = null;
let dashboardCachedAt = 0;
let refreshPromise = null;

const weights = {
  oil: 5,
  inflation: 10,
  fed: 10,
  rates: 10,
  vix: 5,
  unemployment: 8,
  payrolls: 5,
  aiEarnings: 10,
  credit: 12,
  earningsBreadth: 10,
  breadth: 8,
  sp500: 7,
};

const aiEarnings = [
  {
    company: "NVIDIA", ticker: "NVDA", period: "FY2027 Q1", released: "2026-05-20",
    layer: "算力与互连", role: "GPU / 加速计算平台",
    impact: "GPU 需求、毛利率与供给指引，是整个 AI 服务器、HBM 和先进封装周期的第一风向标。",
    revenue: "$81.615B", netIncome: "$58.321B", grossMargin: "74.9%",
    guidance: "FY2027 Q2 营收 $91.0B ±2%，GAAP 毛利率 74.9% ±0.5 个百分点；指引未计入中国数据中心计算收入。",
    resultAssessment: "明显超预期：调整后 EPS $1.87、营收 $81.6B，均高于市场预期。",
    resultTone: "positive",
    guidanceAssessment: "明显利好：Q2 营收中值 $91B 高于一致预期，AI 算力需求继续扩张；中国收入缺口仍是风险。",
    guidanceTone: "positive",
    nextReportDate: "2026-08-26", nextReportLabel: "2026-08-26", nextReportStatus: "confirmed",
    nextReportSource: "https://investor.nvidia.com/events-and-presentations/events-and-presentations/event-details/2026/NVIDIA-2nd-Quarter-FY27-Financial-Results/default.aspx",
    note: "GAAP 净利润包含较大投资收益；非 GAAP 净利润为 $45.548B。",
    source: "https://nvidianews.nvidia.com/news/nvidia-announces-financial-results-for-first-quarter-fiscal-2027",
  },
  {
    company: "Broadcom", ticker: "AVGO", period: "FY2026 Q2", released: "2026-06-03",
    layer: "算力与互连", role: "定制 ASIC / AI 网络",
    impact: "定制加速器和以太网交换芯片直接反映云厂商自研芯片与集群互连需求，是 NVIDIA 之外最重要的增量信号。",
    revenue: "$22.187B", netIncome: "$9.310B", grossMargin: "69.5%",
    guidance: "FY2026 Q3 营收约 $29.4B；AI 半导体收入预计 $16.0B、同比增长超过 200%；非 GAAP 营业利润率约 67%。",
    resultAssessment: "超预期：营收与调整后 EPS 均高于市场预期，AI 半导体收入 $10.8B、同比增长 143%。",
    resultTone: "positive",
    guidanceAssessment: "基本面强但预期很高：AI 收入继续加速，定制芯片与网络需求明确；市场仍会追问更长期订单可见度。",
    guidanceTone: "mixed",
    nextReportDate: null, nextReportLabel: "预计 9 月上旬 · 待官宣", nextReportStatus: "estimated",
    note: "GAAP 毛利率按 SEC 财报毛利 $15.415B / 营收 $22.187B 计算。",
    source: "https://www.sec.gov/Archives/edgar/data/1730168/000173016826000051/avgo-05032026x8kxex99.htm",
  },
  {
    company: "TSMC", ticker: "TSM", period: "2026 Q1", released: "2026-04-16",
    layer: "晶圆与先进封装", role: "先进制程 / CoWoS",
    impact: "先进制程产能、良率与 CoWoS 扩产决定多数 AI 芯片能否按时交付，是供给端最关键的共同瓶颈。",
    revenue: "$35.898B", netIncome: "$18.121B", grossMargin: "66.2%",
    guidance: "2026 Q2 营收 $39.0B-$40.2B；毛利率 65.5%-67.5%，营业利润率 56.0%-58.0%。",
    resultAssessment: "超出公司指引：营收高于原指引上限，毛利率 66.2% 也高于原区间上限。",
    resultTone: "positive",
    guidanceAssessment: "明显利好：Q2 营收与利润率指引继续扩张，AI 先进制程与封装需求仍强。",
    guidanceTone: "positive",
    nextReportDate: "2026-07-16", nextReportLabel: "2026-07-16", nextReportStatus: "confirmed",
    nextReportSource: "https://investor.tsmc.com/english/quarterly-results/2026/q2",
    note: "美元口径采用公司官方财报；归属母公司净利润为 NT$571.15B / US$18.121B。",
    source: "https://investor.tsmc.com/english/quarterly-results/2026/q1",
  },
  {
    company: "Microsoft", ticker: "MSFT", period: "FY2026 Q3", released: "2026-04-29",
    layer: "云与资本开支", role: "Azure / AI 基础设施",
    impact: "Azure 增速、AI 供给约束和资本开支决定企业 AI 需求能否转化为云收入。",
    revenue: "$82.886B", netIncome: "$31.778B", grossMargin: "67.6%",
    guidance: "FY2026 Q4 营收 $86.7B-$87.8B；Azure 固定汇率增速 39%-40%；季度资本开支预计超过 $40B。",
    resultAssessment: "超预期：EPS $4.27、营收 $82.9B，均高于市场预期，Azure 增长保持强劲。",
    resultTone: "positive",
    guidanceAssessment: "中性偏利好：Azure 指引强、资本开支继续扩张，但总营收中值略低于市场一致预期。",
    guidanceTone: "mixed",
    nextReportDate: "2026-07-29", nextReportLabel: "2026-07-29", nextReportStatus: "confirmed",
    nextReportSource: "https://news.microsoft.com/source/2026/07/08/microsoft-announces-quarterly-earnings-release-date-68/",
    note: "毛利率按官方营收与毛利润计算。",
    source: "https://www.microsoft.com/en-us/Investor/earnings/FY-2026-Q3/press-release-webcast",
  },
  {
    company: "Alphabet", ticker: "GOOG", period: "2026 Q1", released: "2026-04-29",
    layer: "云与资本开支", role: "Google Cloud / TPU",
    impact: "Google Cloud、TPU 和年度资本开支指引共同反映自研算力、外购 GPU 与数据中心投资强度。",
    revenue: "$109.896B", netIncome: "$62.578B", grossMargin: "62.4%",
    guidance: "2026 年资本开支上调至 $180B-$190B，并预计 2027 年资本开支仍将显著增加，AI 基础设施投入继续扩张。",
    resultAssessment: "明显超预期：营收高于市场预期，EPS 受投资收益放大，需结合主营利润判断。",
    resultTone: "positive",
    guidanceAssessment: "扩张但有压力：AI 投资继续上修，需求信号偏强；折旧、现金流与回报率压力同步上升。",
    guidanceTone: "mixed",
    nextReportDate: "2026-07-22", nextReportLabel: "2026-07-22", nextReportStatus: "confirmed",
    nextReportSource: "https://abc.xyz/investor/",
    note: "毛利率按 SEC 10-Q 的营收减营业成本计算；净利润含投资相关收益。",
    source: "https://www.sec.gov/Archives/edgar/data/1652044/000165204426000048/goog-20260331.htm",
  },
  {
    company: "Amazon", ticker: "AMZN", period: "2026 Q1", released: "2026-04-29",
    layer: "云与资本开支", role: "AWS / Trainium",
    impact: "AWS 是最大云基础设施平台之一，其增长、供给和 Trainium 投入会改变整个 AI 服务器需求曲线。",
    revenue: "$181.519B", netIncome: "$30.255B", grossMargin: "51.8%",
    guidance: "2026 Q2 净销售额 $194B-$199B，营业利润 $20B-$24B。",
    resultAssessment: "超预期：营收高于市场预期，EPS 明显超预期但包含 Anthropic 估值收益。",
    resultTone: "positive",
    guidanceAssessment: "偏利好：销售额与营业利润区间继续增长，但利润仍受投资收益和促销时点影响。",
    guidanceTone: "positive",
    nextReportDate: null, nextReportLabel: "预计 7 月下旬 · 待官宣", nextReportStatus: "estimated",
    note: "净利润包含 Anthropic 投资约 $16.8B 的税前估值收益；毛利率按官方报表计算。",
    source: "https://ir.aboutamazon.com/news-release/news-release-details/2026/Amazon-com-Announces-First-Quarter-Results/default.aspx",
  },
  {
    company: "Micron", ticker: "MU", period: "FY2026 Q3", released: "2026-06-24",
    layer: "HBM 与存储", role: "HBM / DRAM / NAND",
    impact: "美光的 HBM 产能、价格和毛利率指引，是判断存储短缺能否持续的重要公开信号。",
    revenue: "$41.456B", netIncome: "$28.243B", grossMargin: "84.6%",
    guidance: "FY2026 Q4 营收 $50.0B ±$1.0B，GAAP 毛利率约 86%，GAAP EPS $30.73 ±$1.00。",
    resultAssessment: "大幅超预期：营收、毛利率与 EPS 再创纪录，HBM 与存储价格是核心驱动。",
    resultTone: "positive",
    guidanceAssessment: "明显利好：营收、毛利率和 EPS 指引均大幅上行；主要风险是周期高位后的供给扩张。",
    guidanceTone: "positive",
    nextReportDate: null, nextReportLabel: "预计 9 月下旬 · 待官宣", nextReportStatus: "estimated",
    note: "公司给出的下一季指引显示存储景气与 HBM 需求仍强。",
    source: "https://investors.micron.com/node/50671",
  },
  {
    company: "SK hynix", ticker: "000660.KS", period: "FY2026 Q1", released: "2026-04-23",
    layer: "HBM 与存储", role: "HBM 领先供应商",
    impact: "SK hynix 的 HBM 出货、定价与客户放量节奏直接决定高端显存供需，是存储链最纯的 AI 信号。",
    revenue: "KRW 52.576T", netIncome: "KRW 40.346T", grossMargin: "79.0%",
    guidance: "Q2 DRAM 出货量预计环比增长中十位数百分比、NAND 增长高个位数；HBM4 按客户计划放量，存储定价环境短期仍有利。",
    resultAssessment: "明显超预期：营收和净利润高于市场预期，HBM 与存储价格共同推动纪录业绩。",
    resultTone: "positive",
    guidanceAssessment: "偏利好：出货量与价格环境仍强，需求继续高于供给；PC 与手机需求放缓需要跟踪。",
    guidanceTone: "positive",
    nextReportDate: null, nextReportLabel: "预计 7 月下旬 · 待官宣", nextReportStatus: "estimated",
    note: "净利润包含约 KRW 9.94T 投资资产估值收益。",
    source: "https://news.skhynix.com/q1-2026-business-results/",
  },
];

const aiChainLayers = [
  { name: "算力与互连", description: "谁决定单集群算力、定制芯片和网络带宽", tickers: ["NVDA", "AVGO"] },
  { name: "晶圆与先进封装", description: "谁决定先进芯片能否按时、按量交付", tickers: ["TSM"] },
  { name: "云与资本开支", description: "谁决定 AI 基础设施需求和商业化速度", tickers: ["MSFT", "GOOG", "AMZN"] },
  { name: "HBM 与存储", description: "谁决定内存带宽、价格和供给周期", tickers: ["MU", "000660.KS"] },
];

const cpiReleaseCalendar = [
  { date: "2026-08-12", period: "7 月" },
  { date: "2026-09-11", period: "8 月" },
  { date: "2026-10-14", period: "9 月" },
  { date: "2026-11-10", period: "10 月" },
  { date: "2026-12-10", period: "11 月" },
];

const employmentReleaseCalendar = [
  { date: "2026-08-07", period: "7 月" },
  { date: "2026-09-04", period: "8 月" },
  { date: "2026-10-02", period: "9 月" },
  { date: "2026-11-06", period: "10 月" },
  { date: "2026-12-04", period: "11 月" },
];

const fomcDecisionCalendar = [
  { date: "2026-07-29", meeting: "7 月 28–29 日会议", projections: false },
  { date: "2026-09-16", meeting: "9 月 15–16 日会议", projections: true },
  { date: "2026-10-28", meeting: "10 月 27–28 日会议", projections: false },
  { date: "2026-12-09", meeting: "12 月 8–9 日会议", projections: true },
];

function dateInTimeZone(date, timeZone) {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(date);
  const values = Object.fromEntries(parts.map(({ type, value }) => [type, value]));
  return `${values.year}-${values.month}-${values.day}`;
}

function nextCalendarEvent(calendar, now = new Date()) {
  const todayInNewYork = dateInTimeZone(now, "America/New_York");
  return calendar.find(({ date }) => date >= todayInNewYork) || null;
}

function buildReminders(now = new Date()) {
  const cpi = nextCalendarEvent(cpiReleaseCalendar, now);
  const employment = nextCalendarEvent(employmentReleaseCalendar, now);
  const fomc = nextCalendarEvent(fomcDecisionCalendar, now);
  const blsSource = "https://www.bls.gov/schedule/2026/";

  return [
    {
      indicatorId: "inflation", label: "CPI 公布", date: cpi?.date || null,
      event: cpi ? `美国 ${cpi.period} CPI / 核心 CPI，08:30 ET` : "等待 BLS 公布下一年日程",
      source: blsSource, linkLabel: "查看 BLS 官方发布日程", scheduleStatus: cpi ? "confirmed" : "pending",
    },
    {
      indicatorId: "fed", label: "FOMC 利率决议", date: fomc?.date || null,
      event: fomc ? `${fomc.meeting}：利率决议与主席发布会${fomc.projections ? "，同时公布经济预测" : ""}` : "等待美联储公布下一年日程",
      source: "https://www.federalreserve.gov/monetarypolicy/fomccalendars.htm", linkLabel: "查看美联储会议日程", scheduleStatus: fomc ? "confirmed" : "pending",
    },
    {
      indicatorId: "unemployment", label: "失业率", date: employment?.date || null,
      event: employment ? `${employment.period}就业报告·失业率，08:30 ET` : "等待 BLS 公布下一年日程",
      source: blsSource, linkLabel: "查看 BLS 就业报告日程", scheduleStatus: employment ? "confirmed" : "pending",
    },
    {
      indicatorId: "payrolls", label: "非农就业", date: employment?.date || null,
      event: employment ? `${employment.period}就业报告·非农就业，08:30 ET` : "等待 BLS 公布下一年日程",
      source: blsSource, linkLabel: "查看 BLS 就业报告日程", scheduleStatus: employment ? "confirmed" : "pending",
    },
    {
      indicatorId: "aiEarnings", label: "八家 AI 巨头财报", date: null, event: "已确认日期与待官宣窗口分开标注", source: "https://www.sec.gov/edgar/search/",
      companies: aiEarnings.map(({ company, ticker, released, nextReportDate, nextReportLabel, nextReportStatus, nextReportSource }) => ({
        company, ticker, released, next: nextReportDate || nextReportLabel, status: nextReportStatus || "estimated", source: nextReportSource || null,
      })),
    },
  ];
}

const officialInflationSnapshot = {
  cpi: { yoy: 4.2, mom: 0.5, period: "2026-05", released: "2026-06-10" },
  coreCpi: { yoy: 2.9, mom: 0.2, period: "2026-05", released: "2026-06-10" },
  pce: { yoy: 3.8, mom: 0.4, period: "2026-04", released: "2026-05-29" },
  corePce: { yoy: 3.3, mom: 0.2, period: "2026-04", released: "2026-05-29" },
  priorCpiYoy: 3.8,
  priorCoreCpiYoy: 2.8,
};

const fedWatchSnapshot = {
  asOf: "2026-06-12",
  hike25: 1.5,
  unchanged: 98.5,
  cut25: "<0.1",
  source: "https://www.cmegroup.com/markets/interest-rates/cme-fedwatch-tool.html",
};

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

function annualizedChange(current, previous, months) {
  return Number.isFinite(current) && Number.isFinite(previous) && previous > 0
    ? ((current / previous) ** (12 / months) - 1) * 100
    : null;
}

function latest(series) {
  return series?.at(-1) || null;
}

function nearestPrior(series, daysAgo) {
  if (!series?.length) return null;
  const target = Date.parse(series.at(-1).date) - daysAgo * 86_400_000;
  let best = series[0];
  for (const point of series) {
    if (Date.parse(point.date) <= target) best = point;
    else break;
  }
  return best;
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

async function fetchText(url) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  try {
    const response = await fetch(url, {
      signal: controller.signal,
      headers: { "user-agent": "Mozilla/5.0 BearMarketRadar/1.0" },
    });
    if (!response.ok) throw new Error(`${response.status} ${response.statusText}`);
    return await response.text();
  } finally {
    clearTimeout(timer);
  }
}

async function fetchJson(url) {
  const text = await fetchText(url);
  return JSON.parse(text);
}

function parseFredCsv(csv) {
  const lines = csv.trim().split(/\r?\n/);
  if (lines.length < 2) return [];
  return lines.slice(1).map((line) => {
    const comma = line.indexOf(",");
    const date = line.slice(0, comma);
    const raw = line.slice(comma + 1).trim();
    if (!raw || raw === "." || raw.toLowerCase() === "na") return null;
    const value = Number(raw);
    return Number.isFinite(value) ? { date, value } : null;
  }).filter(Boolean);
}

async function fetchFred(id) {
  const start = new Date();
  start.setUTCFullYear(start.getUTCFullYear() - 3);
  const url = `https://fred.stlouisfed.org/graph/fredgraph.csv?id=${encodeURIComponent(id)}&cosd=${start.toISOString().slice(0, 10)}`;
  return parseFredCsv(await fetchText(url));
}

async function fetchNasdaq(symbol, assetClass) {
  const start = new Date();
  start.setUTCFullYear(start.getUTCFullYear() - 2);
  const end = new Date();
  const url = `https://api.nasdaq.com/api/quote/${encodeURIComponent(symbol)}/historical?assetclass=${assetClass}&fromdate=${start.toISOString().slice(0, 10)}&todate=${end.toISOString().slice(0, 10)}&limit=5000`;
  const json = await fetchJson(url);
  const rows = json?.data?.tradesTable?.rows;
  if (!Array.isArray(rows)) throw new Error(json?.status?.bCodeMessage?.[0]?.errorMessage || `No data for ${symbol}`);
  return rows.map((row) => {
    const [month, day, year] = String(row.date).split("/");
    const value = Number(String(row.close).replace(/[$,]/g, ""));
    return Number.isFinite(value) ? { date: `${year}-${month}-${day}`, value } : null;
  }).filter(Boolean).reverse();
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

async function retry(task, attempts = 2) {
  let lastError;
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try {
      return await task();
    } catch (error) {
      lastError = error;
      if (attempt < attempts) await new Promise((resolve) => setTimeout(resolve, 350 * attempt));
    }
  }
  throw lastError;
}

function seriesData(result) {
  return result?.ok ? result.data : [];
}

function indicator({ id, title, category, weight, risk, value, detail, date, description, why, source, cadence, confidence = "high", sparkline = [], available = true, methodology = "", breakdown = null, judgment = null }) {
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
    methodology,
    breakdown,
    judgment,
  };
}

async function buildDashboard() {
  const nextFomcDate = nextCalendarEvent(fomcDecisionCalendar)?.date || "待官方公布";
  const fredIds = ["DCOILBRENTEU", "CPIAUCSL", "CPILFESL", "PCEPILFE", "DFEDTARL", "DFEDTARU", "DGS2", "DGS10", "DFII10", "T10Y3M", "VIXCLS", "SP500", "BAMLH0A0HYM2", "DRTSCILM", "SAHMREALTIME", "ICSA", "NFCI", "CP", "UNRATE", "PAYEMS"];
  const marketSymbols = ["SPY", "RSP", "XLK", "XLF", "XLY", "XLC", "XLI", "XLV", "XLP", "XLE", "XLU", "XLRE", "XLB"];

  const [fredResults, marketResults] = await Promise.all([
    mapLimit(fredIds, 2, async (id) => [id, await safe(id, retry(() => fetchFred(id)))]),
    mapLimit(marketSymbols, 4, async (symbol) => [symbol, await safe(symbol, retry(() => fetchNasdaq(symbol, "etf")))]),
  ]);

  const fred = Object.fromEntries(fredResults);
  const market = Object.fromEntries(marketResults);
  const getFred = (id) => seriesData(fred[id]);
  const getMarket = (id) => seriesData(market[id]);

  const brent = getFred("DCOILBRENTEU");
  const brentLast = latest(brent);
  const brent20 = average(brent.slice(-20).map((point) => point.value));
  const oilRisk = Number.isFinite(brent20)
    ? clamp(scale(brent20, 80, 110) * 0.75 + scale(brentLast?.value, 85, 115) * 0.25)
    : null;

  const headlineCpi = getFred("CPIAUCSL");
  const coreCpi = getFred("CPILFESL");
  const corePce = getFred("PCEPILFE");
  // Display and year-over-year scoring use the latest BLS/BEA release values.
  // FRED seasonally adjusted series remain the source for multi-month momentum.
  const headlineCpiYoy = officialInflationSnapshot.cpi.yoy;
  const priorHeadlineCpiYoy = officialInflationSnapshot.priorCpiYoy;
  const coreCpiYoy = officialInflationSnapshot.coreCpi.yoy;
  const priorCoreCpiYoy = officialInflationSnapshot.priorCoreCpiYoy;
  const headlinePceYoy = officialInflationSnapshot.pce.yoy;
  const headlinePceMom = officialInflationSnapshot.pce.mom;
  const corePceYoy = officialInflationSnapshot.corePce.yoy;
  const corePceMom = officialInflationSnapshot.corePce.mom;
  const headlineCpi3m = headlineCpi.length >= 4 ? annualizedChange(headlineCpi.at(-1).value, headlineCpi.at(-4).value, 3) : null;
  const coreCpi3m = coreCpi.length >= 4 ? annualizedChange(coreCpi.at(-1).value, coreCpi.at(-4).value, 3) : null;
  const pce3m = corePce.length >= 4 ? annualizedChange(corePce.at(-1).value, corePce.at(-4).value, 3) : null;
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
  const fedPrior = nearestPrior(fedRate, 100);
  const fedChange = fedLast && fedPrior ? fedLast.value - fedPrior.value : null;
  const twoYear = getFred("DGS2");
  const twoYearLast = latest(twoYear);
  const twoYearPrior = nearestPrior(twoYear, 90);
  const twoYearChange = twoYearLast && twoYearPrior ? twoYearLast.value - twoYearPrior.value : null;
  const policyGap = twoYearLast && fedLast ? twoYearLast.value - fedLast.value : null;

  const unemployment = getFred("UNRATE");
  const unemploymentLast = latest(unemployment);
  const unemployment3mChange = unemployment.length >= 4 ? unemploymentLast.value - unemployment.at(-4).value : null;
  const unemployment12mChange = unemployment.length >= 13 ? unemploymentLast.value - unemployment.at(-13).value : null;
  const payrolls = getFred("PAYEMS");
  const payrollLast = latest(payrolls);
  const payroll3mAvg = payrolls.length >= 4 ? (payrollLast.value - payrolls.at(-4).value) / 3 : null;
  const payroll6mAvg = payrolls.length >= 7 ? (payrollLast.value - payrolls.at(-7).value) / 6 : null;
  const payrollLatestChange = payrolls.length >= 2 ? payrollLast.value - payrolls.at(-2).value : null;
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
  const fedRisk = Number.isFinite(marketHawkishness) && Number.isFinite(macroConstraint)
    ? Math.max(actualHikeRisk || 0, clamp(marketHawkishness * 0.55 + macroConstraint * 0.45))
    : actualHikeRisk;

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
    : realYieldRisk;
  const aiToneRisk = { positive: 0.12, mixed: 0.34, negative: 0.75 };
  const aiRisk = clamp(average(aiEarnings.map((row) => aiToneRisk[row.guidanceTone] ?? 0.5)) + 0.03);

  const vix = getFred("VIXCLS");
  const vixLast = latest(vix);
  const vix20 = average(vix.slice(-20).map((point) => point.value));
  const vixRisk = Number.isFinite(vix20)
    ? clamp(scale(vix20, 16, 32) * 0.7 + scale(vixLast?.value, 18, 38) * 0.3)
    : null;

  const sp500 = getFred("SP500");
  const spLast = latest(sp500);
  const oneYear = sp500.slice(-252);
  const high52 = oneYear.length ? Math.max(...oneYear.map((point) => point.value)) : null;
  const drawdown = spLast && high52 ? (1 - spLast.value / high52) * 100 : null;
  const spMa200 = average(sp500.slice(-200).map((point) => point.value));
  const below200 = spLast && Number.isFinite(spMa200) ? spLast.value < spMa200 : false;
  const spRisk = Number.isFinite(drawdown)
    ? clamp(
      (drawdown <= 5 ? 0.12 + scale(drawdown, 0, 5) * 0.13 : 0.25 + scale(drawdown, 5, 20) * 0.55)
      + (below200 ? 0.20 : 0),
    )
    : null;

  const credit = getFred("BAMLH0A0HYM2");
  const creditLast = latest(credit);
  const creditPrior = nearestPrior(credit, 90);
  const creditMove = creditLast && creditPrior ? creditLast.value - creditPrior.value : null;
  const creditRisk = creditLast
    ? clamp(scale(creditLast.value, 3.0, 6.0) * 0.8 + scale(creditMove, 0.25, 2.0) * 0.2)
    : null;

  const lending = getFred("DRTSCILM");
  const lendingLast = latest(lending);
  const lendingRisk = lendingLast ? scale(lendingLast.value, 0, 40) : null;

  const sahm = getFred("SAHMREALTIME");
  const claims = getFred("ICSA");
  const sahmLast = latest(sahm);
  const claims4 = average(claims.slice(-4).map((point) => point.value));
  const claims52Low = claims.length ? Math.min(...claims.slice(-52).map((point) => point.value)) : null;
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
    : unemploymentDeterioration;
  const payrollDeterioration = Number.isFinite(payroll3mAvg)
    ? scale(110 - payroll3mAvg, 0, 110)
    : null;
  const payrollPolicyPressure = Number.isFinite(payrollHeat) && Number.isFinite(inflationRisk)
    ? payrollHeat * inflationRisk * 0.72
    : null;
  const payrollRisk = Number.isFinite(payrollDeterioration) && Number.isFinite(payrollPolicyPressure)
    ? Math.max(payrollDeterioration, payrollPolicyPressure)
    : payrollDeterioration;

  const spy = getMarket("SPY");
  const rsp = getMarket("RSP");
  const spy60 = pctChange(latest(spy)?.value, spy.at(-61)?.value);
  const rsp60 = pctChange(latest(rsp)?.value, rsp.at(-61)?.value);
  const relative60 = Number.isFinite(rsp60) && Number.isFinite(spy60) ? rsp60 - spy60 : null;
  const sectorSymbols = ["XLK", "XLF", "XLY", "XLC", "XLI", "XLV", "XLP", "XLE", "XLU", "XLRE", "XLB"];
  const belowSectorCount = sectorSymbols.reduce((count, symbol) => {
    const series = getMarket(symbol);
    const now = latest(series)?.value;
    const ma = average(series.slice(-200).map((point) => point.value));
    return count + (Number.isFinite(now) && Number.isFinite(ma) && now < ma ? 1 : 0);
  }, 0);
  const breadthRisk = Number.isFinite(relative60)
    ? clamp(scale(-relative60, 0, 8) * 0.45 + (belowSectorCount / sectorSymbols.length) * 0.55)
    : null;

  const profits = getFred("CP");
  // Current public earnings snapshots remain constructive, but a 10% weight should not
  // receive a zero-risk/full-confidence score from a stale quarterly profits proxy.
  const earningsBreadthRisk = 0.10;

  const nfci = getFred("NFCI");
  const nfciLast = latest(nfci);
  const nfciRisk = nfciLast ? scale(nfciLast.value, -0.5, 0.5) : null;
  const unemploymentComposite = Number.isFinite(unemploymentRisk) && Number.isFinite(laborRisk)
    ? clamp(unemploymentRisk * 0.65 + laborRisk * 0.35)
    : unemploymentRisk;
  const creditComposite = [creditRisk, lendingRisk, nfciRisk].every(Number.isFinite)
    ? clamp(creditRisk * 0.65 + lendingRisk * 0.25 + nfciRisk * 0.10)
    : creditRisk;


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
      date: officialInflationSnapshot.cpi.released, description: "重点看核心 CPI、核心 PCE 的三个月与六个月趋势，避免被单月噪声带偏。", why: "通胀黏性决定美联储能否降息，也决定估值压力会持续多久。",
      source: { label: "BLS / BEA / FRED · CPI 与 PCE", url: "https://www.bls.gov/news.release/cpi.nr0.htm" }, cadence: "月度", confidence: "high", sparkline: spark(headlineCpi, 18), methodology: "整体 CPI 三个月年化和同比占 60%，核心 PCE 与核心 CPI 占 40%。",
      breakdown: [
        { label: "CPI", value: `${round(headlineCpiYoy, 1)}%`, detail: `5月 · 月率 +${officialInflationSnapshot.cpi.mom}%` },
        { label: "核心 CPI", value: `${round(coreCpiYoy, 1)}%`, detail: `5月 · 月率 +${officialInflationSnapshot.coreCpi.mom}%` },
        { label: "PCE", value: `${round(headlinePceYoy, 1)}%`, detail: `4月 · 月率 +${headlinePceMom}%` },
        { label: "核心 PCE", value: `${round(corePceYoy, 1)}%`, detail: `4月 · 月率 +${corePceMom}%` },
      ],
      judgment: inflationTrend,
    }),
    indicator({
      id: "fed", title: "美联储政策周期", category: "通胀与政策", weight: weights.fed, risk: fedRisk,
      value: fedLast && fedLowerLast ? `${round(fedLowerLast.value, 2)}%–${round(fedLast.value, 2)}%` : "暂无数据", detail: `当前联邦基金目标区间；下次会议 ${nextFomcDate}；2 年期 ${twoYearLast ? round(twoYearLast.value, 2) : "--"}%`,
      date: fedLast?.date, description: "区分预防性降息与危机降息，并用联邦基金期货观察市场对下次会议的加息、不变和降息定价。", why: "政策收紧会压制估值和融资；市场隐含概率可以衡量预期，但不代表美联储承诺。",
      source: { label: "CME FedWatch · 官方市场概率工具", url: fedWatchSnapshot.source }, cadence: "市场快照 / 会议", confidence: "high", sparkline: spark(twoYear, 90), methodology: "市场利率重定价、实际政策变化、通胀和就业约束共同评分；会议概率来自 CME FedWatch 市场隐含定价。",
      breakdown: [
        { label: "加息 25 bp", value: `${fedWatchSnapshot.hike25}%`, detail: `目标区间 3.75%–4.00%` },
        { label: "维持不变", value: `${fedWatchSnapshot.unchanged}%`, detail: `目标区间 3.50%–3.75%` },
        { label: "降息 25 bp", value: `${fedWatchSnapshot.cut25}%`, detail: `目标区间 3.25%–3.50%` },
      ],
      judgment: { tone: "watch", label: "市场预测", text: `截至 ${fedWatchSnapshot.asOf}，市场几乎确定本次按兵不动。98.5% 为最新公开 FedWatch 引用值；其余尾部定价偏向加息，降息接近零。` },
    }),
    indicator({
      id: "rates", title: "10年期美债与实际利率", category: "通胀与政策", weight: weights.rates, risk: ratesRisk,
      value: nominalLast ? `${round(nominalLast.value, 2)}%` : "暂无数据", detail: `10 年期名义收益率；实际利率 ${realLast ? round(realLast.value, 2) : "--"}%；10Y-3M ${yieldCurveLast ? `${yieldCurveLast.value >= 0 ? "+" : ""}${round(yieldCurveLast.value, 2)}%` : "--"}`,
      date: nominalLast?.date, description: "同时看 10 年期名义与实际利率、上涨速度，以及倒挂后重新变陡的周期信号。", why: "实际利率决定股票折现压力，期限结构则反映融资与衰退风险。",
      source: { label: "U.S. Treasury / FRED · 10Y", url: "https://home.treasury.gov/resource-center/data-chart-center/interest-rates/TextView?type=daily_treasury_yield_curve" }, cadence: "交易日", confidence: "high", sparkline: spark(nominal10y, 90), methodology: "实际与名义收益率压力占 72%，期限曲线周期风险占 28%。",
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
      date: unemploymentLast?.date, description: "重点看三个月平均失业率的上升速度，并用 Sahm 规则和初请失业金交叉验证。", why: "就业恶化会削弱消费和盈利，并可能把估值调整升级为衰退型熊市。",
      source: { label: "BLS / FRED · Unemployment / Sahm", url: sourceUrl("UNRATE") }, cadence: "月度/周度", confidence: "high", sparkline: spark(unemployment, 24), methodology: "失业率变化占 65%，Sahm 与初请变化占 35%。",
    }),
    indicator({
      id: "payrolls", title: "非农就业数据", category: "就业与经济", weight: weights.payrolls, risk: payrollRisk,
      value: Number.isFinite(payrollLatestChange) ? `${round(payrollLatestChange, 0)}k` : "暂无数据", detail: `三个月平均 ${Number.isFinite(payroll3mAvg) ? round(payroll3mAvg, 0) : "--"}k；六个月平均 ${Number.isFinite(payroll6mAvg) ? round(payroll6mAvg, 0) : "--"}k`,
      date: payrollLast?.date, description: "观察三个月平均、历史修正、平均工时和就业是否只集中于少数行业。", why: "单月数据噪声很大，持续转弱才意味着需求与企业盈利下行。",
      source: { label: "BLS / FRED · Nonfarm Payrolls", url: sourceUrl("PAYEMS") }, cadence: "月度", confidence: "high", sparkline: spark(payrolls, 24), methodology: "取三个月就业恶化与高通胀下的政策约束风险中较高值。",
    }),
    indicator({
      id: "aiEarnings", title: "AI 产业链财报与指引", category: "盈利与AI", weight: weights.aiEarnings, risk: aiRisk,
      value: "8 家", detail: "NVDA / AVGO / TSM / MSFT / GOOG / AMZN / MU / SK hynix",
      date: "2026-06-03", description: "按算力与互连、晶圆与先进封装、云资本开支、HBM 与存储四层监测行业巨头。", why: "这些公司的指引能同时改变 AI 需求、供给、带宽和资本开支预期，比单纯按市值选股更接近产业链真实风险。",
      source: { label: "公司 IR / SEC 原始文件", url: aiEarnings[1].source }, cadence: "季度", confidence: "high", sparkline: [], methodology: "按八家公司下一期指引语气映射基础风险，并加入 3 分产业集中度溢价；支持人工覆盖。",
    }),
    indicator({
      id: "credit", title: "信用利差与银行信贷", category: "信用", weight: weights.credit, risk: creditComposite,
      value: creditLast ? `${round(creditLast.value * 100, 0)} bp` : "暂无数据", detail: `高收益债 OAS；SLOOS 净收紧 ${lendingLast ? `${round(lendingLast.value, 1)}%` : "--"}；NFCI ${nfciLast ? round(nfciLast.value, 2) : "--"}`,
      date: creditLast?.date, description: "把高收益债利差、银行贷款标准与综合金融条件合并成最高权重的信用信号。", why: "信用压力决定企业能否融资，是系统性风险从市场传向实体经济的关键通道。",
      source: { label: "FRED / Fed SLOOS · Credit", url: sourceUrl("BAMLH0A0HYM2") }, cadence: "交易日/季度", confidence: "high", sparkline: spark(credit), methodology: "高收益债利差占 65%，SLOOS 占 25%，NFCI 占 10%。",
    }),
    indicator({
      id: "earningsBreadth", title: "标普 500 整体盈利预期", category: "盈利与AI", weight: weights.earningsBreadth, risk: earningsBreadthRisk,
      value: "仍在上修", detail: "公开市场快照：远期盈利预期保持增长，尚未出现持续 8–12 周的广泛下修",
      date: "2026-06-12", description: "观察未来 12 个月 EPS 是否连续 8 至 12 周下修，并检查下修是否扩散。", why: "盈利下调从科技扩散至金融、工业和消费时，熊市风险会显著上升。",
      source: { label: "S&P Global / 公开盈利预期跟踪", url: "https://www.spglobal.com/spdji/en/indices/equity/sp-500/" }, cadence: "每周复核", confidence: "medium", sparkline: spark(profits, 20), methodology: "当前公开盈利快照偏强，风险设为 10；如有 FactSet/Bloomberg EPS 修正广度，可人工覆盖。",
    }),
    indicator({
      id: "breadth", title: "市场宽度", category: "市场确认", weight: weights.breadth, risk: breadthRisk,
      value: Number.isFinite(relative60) ? `${relative60 >= 0 ? "+" : ""}${round(relative60, 1)}%` : "暂无数据", detail: `RSP 相对 SPY 60 日表现；11 个行业中 ${belowSectorCount} 个低于 200 日线`,
      date: latest(spy)?.date, description: "用等权指数、行业趋势和 200 日均线判断上涨是否只靠少数巨头。", why: "指数创新高而多数股票走弱，说明内部结构已经脆化。",
      source: { label: "Nasdaq · SPY / RSP / Sector ETFs", url: "https://www.nasdaq.com/market-activity/etf/rsp/historical" }, cadence: "交易日", confidence: "proxy", sparkline: spark(rsp, 60), methodology: "RSP 相对 SPY 落后幅度占 45%，行业跌破 200 日线比例占 55%。",
    }),
    indicator({
      id: "sp500", title: "标普 500 距历史高点跌幅", category: "市场确认", weight: weights.sp500, risk: spRisk,
      value: Number.isFinite(drawdown) ? `-${round(drawdown, 1)}%` : "暂无数据", detail: `${spLast ? round(spLast.value, 2).toLocaleString("en-US") : "--"}；${below200 ? "低于" : "高于"} 200 日线`,
      date: spLast?.date, description: "0%-5% 为正常高位，10%-15% 为明显调整，20% 以上确认技术性熊市。", why: "这是结果确认指标，因此权重低于信用、通胀和盈利。",
      source: { label: "FRED · S&P 500", url: sourceUrl("SP500") }, cadence: "交易日", confidence: "high", sparkline: spark(sp500, 60), methodology: "高位 0%-5% 先计 12%-25% 脆弱风险，5%-20% 逐步升高；跌破 200 日线额外确认。",
    }),
  ];

  const available = indicators.filter((item) => item.available);
  const rawPoints = available.reduce((sum, item) => sum + item.points, 0);
  const availableWeight = available.reduce((sum, item) => sum + item.weight, 0);
  const baseScore = availableWeight ? (rawPoints / availableWeight) * 100 : null;
  const confirmationIds = new Set(["vix", "sp500", "credit", "breadth", "earningsBreadth"]);
  const confirmationItems = available.filter((item) => confirmationIds.has(item.id));
  const confirmationWeight = confirmationItems.reduce((sum, item) => sum + item.weight, 0);
  const confirmationPoints = confirmationItems.reduce((sum, item) => sum + item.points, 0);
  const confirmationScore = confirmationWeight ? (confirmationPoints / confirmationWeight) * 100 : null;
  const categories = ["通胀与政策", "信用", "盈利与AI", "就业与经济", "市场确认"].map((name) => {
    const items = available.filter((item) => item.category === name);
    const weight = items.reduce((sum, item) => sum + item.weight, 0);
    const points = items.reduce((sum, item) => sum + item.points, 0);
    return { name, score: weight ? round((points / weight) * 100, 1) : null, weight };
  });

  const scoreByIds = (ids) => {
    const selected = available.filter((item) => ids.includes(item.id));
    const selectedWeight = selected.reduce((sum, item) => sum + item.weight, 0);
    const selectedPoints = selected.reduce((sum, item) => sum + item.points, 0);
    return selectedWeight ? round((selectedPoints / selectedWeight) * 100, 1) : null;
  };
  const stagflationScore = scoreByIds(["oil", "inflation", "fed", "rates"]);
  const recessionScore = scoreByIds(["unemployment", "payrolls", "credit", "earningsBreadth"]);
  const marketBreakScore = scoreByIds(["vix", "breadth", "sp500"]);
  const dominantRegimeScore = Math.max(...[stagflationScore, recessionScore, marketBreakScore].filter(Number.isFinite));
  const stagflationHighCount = ["oil", "inflation", "fed", "rates"]
    .map((id) => available.find((item) => item.id === id)?.risk)
    .filter((risk) => Number.isFinite(risk) && risk >= 60).length;
  const macroSynergyUplift = stagflationHighCount >= 4 ? 10 : stagflationHighCount >= 3 ? 7 : 0;
  const fragileHighUplift = Number.isFinite(drawdown) && drawdown < 5 && Number.isFinite(breadthRisk) && breadthRisk >= 0.20 ? 4 : 0;
  const riskUplift = macroSynergyUplift + fragileHighUplift;
  const score = Number.isFinite(baseScore) && Number.isFinite(dominantRegimeScore)
    ? clamp((baseScore * 0.70 + dominantRegimeScore * 0.30 + riskUplift) / 100) * 100
    : baseScore;
  const action = score <= 20
    ? { key: "add", label: "风险较低：可考虑分批增加风险敞口", detail: "适合按既定资产配置逐步投入，不代表短期不会回调。" }
    : score <= 40
      ? { key: "hold", label: "正常波动：以持有和再平衡为主", detail: "不追涨，也不因单项噪声急于减仓，等待风险是否跨指标扩散。" }
      : score <= 60
        ? { key: "caution", label: "黄色警戒：保持仓位，暂停加仓", detail: "当前不支持全面卖出；保留现金，优先降低高估值、高波动或带杠杆仓位，等待信用、盈利或市场宽度改善。" }
        : score <= 75
          ? { key: "reduce", label: "橙色警报：考虑降低高波动仓位", detail: "风险链已明显共振，重点控制回撤、杠杆与流动性。" }
          : { key: "defend", label: "红色警报：优先防守与控制回撤", detail: "系统性风险较高，应优先处理杠杆和流动性暴露。" };

  return {
    generatedAt: new Date().toISOString(),
    score: round(score, 1),
    baseScore: round(baseScore, 1),
    confirmationScore: round(confirmationScore, 1),
    heatScore: stagflationScore,
    stagflationScore,
    recessionScore,
    marketBreakScore,
    dominantRegimeScore: round(dominantRegimeScore, 1),
    riskUplift,
    action,
    rawPoints: round(rawPoints, 2),
    availableWeight,
    coverage: availableWeight,
    categories,
    indicators,
    aiEarnings,
    aiChainLayers,
    reminders: buildReminders(),
    methodology: {
      version: "4.5",
      note: "先计算 12 项基础加权分，再用 30% 的主导风险链和最多 14 分的同向共振修正，避免油价、通胀、政策与利率同时恶化时被低风险项过度稀释。基础分与修正项均单独展示。",
      bands: [
        { min: 0, max: 20, label: "健康、风险较低" },
        { min: 21, max: 40, label: "正常波动" },
        { min: 41, max: 60, label: "黄色警戒" },
        { min: 61, max: 75, label: "橙色警报" },
        { min: 76, max: 100, label: "红色警报" },
      ],
    },
    errors: [
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
  res.writeHead(status, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" });
  res.end(JSON.stringify(payload));
}

function refreshDashboard() {
  if (refreshPromise) return refreshPromise;
  refreshPromise = buildDashboard()
    .then((next) => {
      if (!dashboardCache || next.errors.length === 0 || next.coverage >= dashboardCache.coverage) {
        dashboardCache = next;
        dashboardCachedAt = Date.now();
        writeFile(dashboardCacheFile, JSON.stringify(next)).catch((error) => console.warn(`[cache] write failed: ${error.message}`));
      }
      return dashboardCache;
    })
    .catch((error) => {
      console.warn(`[dashboard] refresh failed: ${error.message}`);
      return dashboardCache;
    })
    .finally(() => { refreshPromise = null; });
  return refreshPromise;
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host || "localhost"}`);

  if (url.pathname === "/api/dashboard") {
    const force = url.searchParams.get("refresh") === "1";
    const fresh = dashboardCache && Date.now() - dashboardCachedAt < CACHE_TTL_MS;
    if (!dashboardCache) {
      refreshDashboard();
      return sendJson(res, 202, { warming: true, message: "正在同步最新数据" });
    }
    if (force || !fresh) refreshDashboard();
    return sendJson(res, 200, {
      ...dashboardCache,
      reminders: buildReminders(),
      cache: fresh && !force,
      refreshing: force || !fresh,
    });
  }

  const requested = url.pathname === "/" ? "/index.html" : url.pathname;
  const normalized = path.normalize(requested).replace(/^(\.\.(\/|\\|$))+/, "");
  const filePath = path.join(publicDir, normalized);
  if (!filePath.startsWith(publicDir)) {
    res.writeHead(403);
    return res.end("Forbidden");
  }
  try {
    const data = await readFile(filePath);
    res.writeHead(200, { "content-type": contentType(filePath), "cache-control": "no-cache" });
    res.end(data);
  } catch {
    res.writeHead(404, { "content-type": "text/plain; charset=utf-8" });
    res.end("Not found");
  }
});

try {
  dashboardCache = JSON.parse(await readFile(dashboardCacheFile, "utf8"));
  dashboardCachedAt = Date.parse(dashboardCache.generatedAt) || 0;
} catch {
  dashboardCache = null;
}

server.listen(port, host, () => {
  const displayHost = host === "0.0.0.0" ? "127.0.0.1" : host;
  console.log(`kk的美股雷达已启动：http://${displayHost}:${port}`);
  refreshDashboard();
});
