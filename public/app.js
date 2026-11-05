import { computeScores, actionFor, MIN_SCORE_COVERAGE, normalizeIndicator } from "./risk-model.js";
import { projectDashboard, cacheExpired } from "./dashboard-state.js";
import { requestDashboard } from "./dashboard-client.js";
import { mergeManualOverrides } from "./manual-state.js";
import { isMarketPulseSnapshot, projectMarketPulse } from "./market-pulse.js";

const manualConfig = [
  { id: "aiEarnings", label: "AI 产业链财报风险", help: "当云资本开支、芯片指引或库存出现新变化时，可调整风险值。" },
  { id: "earningsBreadth", label: "标普盈利下调广度", help: "用未来 12 个月 EPS 修正广度补充盈利风险判断。" },
];

const initialOverrides = loadOverrides() ?? {};
let lastPersistedOverrides = initialOverrides;
const state = {
  data: null,
  filter: "全部",
  overrides: initialOverrides,
  lastLoadedAt: 0,
  loadError: null,
  syncPending: false,
  displayValidity: null,
};
let manualDraft = {};
const PULSE_INTERVAL_MS = 2 * 60_000;
const pulseState = { snapshot: null, controller: null, error: null, lastAttemptAt: 0 };
const pulseSymbols = [["VIX", "标普隐含波动"], ["VXSMH", "半导体隐含波动"], ["SPX", "标普 500"], ["RSP", "标普等权 ETF"], ["QQQ", "纳指 100 ETF"], ["SMH", "半导体 ETF"]];
const nyQuoteTime = new Intl.DateTimeFormat("en-GB", { timeZone: "America/New_York", hourCycle: "h23", hour: "2-digit", minute: "2-digit" });

const els = {
  score: document.querySelector("#scoreValue"),
  scoreGauge: document.querySelector("#scoreGauge"),
  gauge: document.querySelector("#gaugeProgress"),
  marker: document.querySelector("#bandMarker"),
  verdict: document.querySelector("#verdictLabel"),
  verdictDescription: document.querySelector("#verdictDescription"),
  verdictDot: document.querySelector("#verdictDot"),
  coverage: document.querySelector("#coverageValue"),
  updated: document.querySelector("#updatedValue"),
  scoreDelta: document.querySelector("#scoreDelta"),
  manualScoreNote: document.querySelector("#manualScoreNote"),
  manualScoreText: document.querySelector("#manualScoreText"),
  reviewManual: document.querySelector("#reviewManualButton"),
  baseScore: document.querySelector("#baseScoreValue"),
  heat: document.querySelector("#heatValue"),
  recession: document.querySelector("#recessionValue"),
  marketBreak: document.querySelector("#marketBreakValue"),
  regimeUplift: document.querySelector("#regimeUpliftValue"),
  uplift: document.querySelector("#upliftValue"),
  methodology: document.querySelector("#methodologyContent"),
  liveText: document.querySelector("#liveText"),
  grid: document.querySelector("#indicatorGrid"),
  loading: document.querySelector("#loadingGrid"),
  categories: document.querySelector("#categoryStrip"),
  drivers: document.querySelector("#driverList"),
  driversSummary: document.querySelector("#driversSummary"),
  error: document.querySelector("#errorBanner"),
  refresh: document.querySelector("#refreshButton"),
  filters: document.querySelector("#filters"),
  manualButton: document.querySelector("#manualButton"),
  manualDialog: document.querySelector("#manualDialog"),
  manualForm: document.querySelector("#manualForm"),
  manualFields: document.querySelector("#manualFields"),
  clearManual: document.querySelector("#clearManual"),
  closeManual: document.querySelector("#closeManual"),
  storageNotices: [document.querySelector("#storageNotice"), document.querySelector("#dialogStorageNotice")],
  actionLabel: document.querySelector("#actionLabel"),
  actionDetail: document.querySelector("#actionDetail"),
  actionCallout: document.querySelector("#actionCallout"),
  aiChainMap: document.querySelector("#aiChainMap"),
  aiCompanyGrid: document.querySelector("#aiCompanyGrid"),
  earningsStatus: document.querySelector("#earningsStatus"),
  reminderGrid: document.querySelector("#reminderGrid"),
  calendarSyncStatus: document.querySelector("#calendarSyncStatus"),
  publicationStatus: document.querySelector("#publicationStatus"),
  modelHistory: document.querySelector("#modelHistory"),
  forwardValidation: document.querySelector("#forwardValidation"),
  sourceRevisions: document.querySelector("#sourceRevisions"),
  revisionList: document.querySelector("#revisionList"),
  pulsePeek: document.querySelector("#overview"),
  pulsePeekStatus: document.querySelector("#pulsePeekStatus"),
  pulsePeekVix: document.querySelector("#pulsePeekVix"),
  pulsePeekVxsmh: document.querySelector("#pulsePeekVxsmh"),
  pulseStatus: document.querySelector("#pulseStatus"),
  pulseQuotes: document.querySelector("#pulseQuotes"),
  pulseJudgments: document.querySelector("#pulseJudgments"),
  pulseErrors: document.querySelector("#pulseErrors"),
  pulseRefresh: document.querySelector("#pulseRefresh"),
  structureTiming: document.querySelector("#structureTiming"),
};

function setLiveStatus(text, status = "updating") {
  els.liveText.textContent = text;
  els.liveText.parentElement.dataset.state = status;
}

function showStorageResult(saved, clearing = false) {
  for (const notice of els.storageNotices) {
    notice.hidden = saved;
    notice.textContent = saved ? "" : clearing
      ? "浏览器未能保存清除操作，当前页面已清除，但重新打开可能恢复旧的人工数据。"
      : "浏览器未能保存人工数据，本次重算仍然有效，刷新页面后可能恢复原值。";
  }
}

function loadOverrides() {
  try {
    const parsed = JSON.parse(localStorage.getItem("bearRadarOverrides") || "{}");
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return {};
    return Object.fromEntries(manualConfig.flatMap(({ id }) => {
      const entry = parsed[id];
      if (!entry || !Number.isFinite(entry.risk) || entry.risk < 0 || entry.risk > 100) return [];
      const timestamp = typeof entry.updatedAt === "string" ? Date.parse(entry.updatedAt) : NaN;
      return [[id, {
        risk: entry.risk,
        note: typeof entry.note === "string" ? entry.note.slice(0, 80) : "",
        updatedAt: Number.isFinite(timestamp) && timestamp <= Date.now() ? new Date(timestamp).toISOString() : null,
      }]];
    }));
  }
  catch { return undefined; }
}

function saveOverrides() {
  try {
    localStorage.setItem("bearRadarOverrides", JSON.stringify(state.overrides));
    lastPersistedOverrides = state.overrides;
    return true;
  } catch {
    return false;
  }
}

function clamp(value, min = 0, max = 100) {
  return Math.min(max, Math.max(min, value));
}

function manualReviewInfo(override) {
  const ageDays = override?.updatedAt ? Math.floor((Date.now() - Date.parse(override.updatedAt)) / 86_400_000) : null;
  return { ageDays, unknownDate: !Number.isFinite(ageDays), needsReview: !Number.isFinite(ageDays) || ageDays >= 30 };
}

function dateInTimeZone(date = new Date(), timeZone = "America/New_York") {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(date);
  const values = Object.fromEntries(parts.map(({ type, value }) => [type, value]));
  return `${values.year}-${values.month}-${values.day}`;
}

function trackTopbarHeight() {
  const topbar = document.querySelector(".topbar");
  if (!topbar) return;
  const update = () => document.documentElement.style.setProperty("--topbar-height", `${Math.ceil(topbar.getBoundingClientRect().height)}px`);
  update();
  if (typeof ResizeObserver === "function") new ResizeObserver(update).observe(topbar);
}

function riskMeta(score) {
  if (score > 75) return { label: "红色警报", color: "#cc3a2d", description: "多项规则指标处于高压力区，应核对流动性、信用事件与盈利下修。分数不代表下跌概率或后续回撤幅度。" };
  if (score > 60) return { label: "橙色警报", color: "#e46e31", description: "规则指标显示当前压力升高，信用、盈利与价格趋势需要逐项核查。" };
  if (score > 40) return { label: "黄色警戒", color: "#d8a232", description: "当前宏观、信用或盈利指标出现压力叠加，需要核查共同驱动。" };
  if (score > 20) return { label: "正常波动", color: "#a9a348", description: "当前规则指标显示局部压力，跨风险链的压力叠加仍有限。" };
  return { label: "健康、风险较低", color: "#4b9b67", description: "当前规则指标所示压力较低；低分不保证后续回撤更小，也不代表短期不会回调。" };
}

function applyOverrides(data) {
  const indicators = data.indicators.map((item) => {
    const override = state.overrides[item.id];
    if (!override || !Number.isFinite(override.risk)) return { ...item };
    const risk = clamp(override.risk);
    return {
      ...item,
      risk,
      points: Math.round((risk / 100) * item.weight * 100) / 100,
      value: `${risk}/100`,
      detail: `${override.note || "人工风险判断"}${override.updatedAt ? " · 录入于" : " · 录入日期未记录"}`,
      date: override.updatedAt ? dateInTimeZone(new Date(override.updatedAt)) : null,
      status: risk >= 80 ? "critical" : risk >= 55 ? "high" : risk >= 30 ? "watch" : "low",
      confidence: "manual",
      available: true,
      overridden: true,
    };
  }).map(normalizeIndicator);
  const model = computeScores(indicators, data.scoringContext);
  const categories = data.categories.map((category) => {
    const items = model.available.filter((item) => item.category === category.name);
    const weight = items.reduce((sum, item) => sum + item.weight, 0);
    const points = items.reduce((sum, item) => sum + item.points, 0);
    return { ...category, weight, score: weight ? (points / weight) * 100 : null };
  });
  return { ...data, indicators, ...model, coverage: model.availableWeight, categories, heatScore: model.stagflationScore, action: actionFor(model.score, model.coverage) };
}

function formatDate(date) {
  if (!date) return "--";
  const parsed = new Date(date);
  if (Number.isNaN(parsed.getTime())) return "--";
  return new Intl.DateTimeFormat("zh-CN", { month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", hour12: false, timeZoneName: "short" }).format(parsed);
}

function formatCacheAge(value) {
  const milliseconds = Number(value);
  if (!Number.isFinite(milliseconds) || milliseconds < 60_000) return "刚刚的";
  if (milliseconds < 3_600_000) return `${Math.floor(milliseconds / 60_000)} 分钟前的`;
  if (milliseconds < 86_400_000) return `${Math.floor(milliseconds / 3_600_000)} 小时前的`;
  return `${Math.floor(milliseconds / 86_400_000)} 天前的`;
}

function scoreColor(score) {
  return riskMeta(score).color;
}

function renderSummary(data) {
  const score = Number.isFinite(data.score) ? Math.round(data.score * 10) / 10 : null;
  const meta = score === null
    ? { label: "数据不足", color: "#777a74", description: `当前有效数据覆盖率为 ${data.coverage}%，低于 ${MIN_SCORE_COVERAGE}% 评分门槛。` }
    : riskMeta(score);
  const circumference = 2 * Math.PI * 103;
  els.score.textContent = score === null ? "--" : score.toFixed(1);
  els.gauge.style.strokeDasharray = `${circumference}`;
  els.gauge.style.strokeDashoffset = `${circumference * (1 - (score ?? 0) / 100)}`;
  els.gauge.style.stroke = meta.color;
  els.gauge.style.visibility = score === null ? "hidden" : "visible";
  els.marker.hidden = score === null;
  els.marker.style.left = `calc(${clamp(score ?? 0)}% - 1px)`;
  els.scoreGauge?.setAttribute("aria-label", score === null ? "综合结构风险分暂不可用" : `综合结构风险分 ${score.toFixed(1)} 分`);
  els.verdict.textContent = meta.label;
  const stagflationDominant = Number.isFinite(data.stagflationScore)
    && data.stagflationScore > 40
    && Number.isFinite(data.recessionScore) && data.recessionScore <= 40
    && Number.isFinite(data.dominantRegimeScore)
    && Math.abs(data.stagflationScore - data.dominantRegimeScore) < 0.05;
  els.verdictDescription.textContent = score !== null && stagflationDominant
    ? "滞胀与政策规则指标当前压力较高，信用与就业指标尚未显示同等程度的压力。"
    : meta.description;
  els.verdictDot.style.background = meta.color;
  els.coverage.textContent = Number.isFinite(data.coverage) ? `${data.coverage}%` : "--";
  els.updated.textContent = formatDate(data.generatedAt);
  renderStructureTiming();
  const availableCount = data.indicators.filter((item) => item.available).length;
  const manual = data.indicators.filter((item) => item.overridden);
  const reviews = manual.map((item) => manualReviewInfo(state.overrides[item.id]));
  const unknownDates = reviews.filter((row) => row.unknownDate).length;
  const oldDates = reviews.filter((row) => row.needsReview && !row.unknownDate).length;
  const reviewReasons = [unknownDates ? `${unknownDates} 项确认日期未知` : "", oldDates ? `${oldDates} 项超过 30 天未复核` : ""].filter(Boolean);
  els.scoreDelta.textContent = `${availableCount} 项有效 · 权重 ${data.coverage}%${manual.length ? ` · ${manual.length} 项人工` : ""}`;
  els.manualScoreNote.hidden = manual.length === 0;
  els.manualScoreNote.dataset.review = String(reviewReasons.length > 0);
  els.manualScoreText.textContent = `评分含 ${manual.length} 项人工判断${reviewReasons.length ? `，${reviewReasons.join("、")}，建议复核。` : "。"}`;
  els.baseScore.textContent = Number.isFinite(data.baseScore) ? data.baseScore.toFixed(1) : "--";
  els.heat.textContent = Number.isFinite(data.heatScore) ? data.heatScore.toFixed(1) : "--";
  els.recession.textContent = Number.isFinite(data.recessionScore) ? data.recessionScore.toFixed(1) : "--";
  els.marketBreak.textContent = Number.isFinite(data.marketBreakScore) ? data.marketBreakScore.toFixed(1) : "--";
  els.regimeUplift.textContent = Number.isFinite(data.regimeUplift) ? `+${data.regimeUplift.toFixed(1)}` : "--";
  els.uplift.textContent = Number.isFinite(data.riskUplift) ? `+${data.riskUplift.toFixed(0)}` : "--";
  const cacheAge = formatCacheAge(data.cacheAgeMs);
  const offline = navigator.onLine === false;
  const marketFailed = Boolean(data.errors?.length);
  const calendarFailed = Object.values(data.calendarSync?.sources || {}).some((source) => source?.error);
  const publicationFailed = Boolean(data.publicationErrors?.length);
  const earningsReviewCount = data.aiEarnings?.filter((row) => row.reviewRequired).length || 0;
  const earningsPending = earningsReviewCount > 0 || Boolean(data.earningsErrors?.length) || data.earningsChecks?.some((row) => row.status === "unknown");
  const status = offline || state.loadError ? "error" : data.cacheExpired || data.refreshing || state.syncPending || data.stale || marketFailed || calendarFailed || publicationFailed || earningsPending ? "updating" : "connected";
  setLiveStatus(offline ? "离线 · 暂用已有数据" : state.loadError ? "连接失败" : data.cacheExpired ? "缓存已过期 · 等待新数据" : data.refreshing || state.syncPending
    ? `后台更新中 · 暂用${cacheAge}缓存`
    : marketFailed ? "部分来源失败 · 暂用已有数据"
    : calendarFailed ? "日程部分同步失败"
    : publicationFailed ? "官方发布进度待核对 · 见详情"
    : earningsPending ? earningsReviewCount ? `${earningsReviewCount} 家财报待复核 · 见 AI 财报` : "AI 财报最新性待核对 · 见详情"
    : data.stale
      ? `更新暂缓 · 暂用${cacheAge}缓存`
      : "已连接 · 数据已更新", status);
  els.actionLabel.textContent = data.action?.label || "等待数据";
  els.actionDetail.textContent = data.action?.detail || "";
  els.actionCallout.dataset.action = data.action?.key || "hold";
}

function renderMethodology(data) {
  els.methodology.innerHTML = `<p class="methodology-note">模型 ${escapeHtml(data.scoringVersion)} · ${escapeHtml(data.methodology.note)}</p>
    <ul class="regime-coverage">${data.regimes.map((row) => `<li data-regime-id="${escapeHtml(row.id)}">
      <span>${escapeHtml(row.label)}</span><strong>${row.score === null ? "--" : row.score.toFixed(1)}</strong>
      <small>${row.availableCount} 项有效 · 本组覆盖 ${row.coverage}%${row.eligible ? "" : " · 不参与主导修正"}</small>
    </li>`).join("")}</ul>
    <table class="weight-table"><caption>指标权重 · 合计 100%</caption><thead><tr><th scope="col">指标</th><th scope="col">权重</th><th scope="col">当前状态</th></tr></thead>
      <tbody>${data.indicators.map((row) => `<tr data-weight-id="${escapeHtml(row.id)}"><th scope="row">${escapeHtml(row.title)}</th><td>${row.weight}%</td><td>${row.overridden ? "人工覆盖" : row.available ? "有效" : "不计分"}</td></tr>`).join("")}</tbody>
    </table>
    <p class="methodology-sources">设计参考：<a href="https://www.federalreserve.gov/financial-stability/types-of-financial-system-vulnerabilities-and-risks.htm" target="_blank" rel="noopener noreferrer" data-focus-key="methodology-source-fed">美联储风险框架</a>、<a href="https://www.chicagofed.org/research/data/nfci/about" target="_blank" rel="noopener noreferrer" data-focus-key="methodology-source-nfci">芝加哥联储金融条件</a>、<a href="https://www.spglobal.com/spdji/en/indices/equity/sp-500-equal-weight-index/" target="_blank" rel="noopener noreferrer" data-focus-key="methodology-source-breadth">标普等权指数口径</a>。上述来源不代表对本模型权重的认可。</p>`;
}

function renderCategories(categories) {
  els.categories.innerHTML = categories.map((category) => {
    const value = Number.isFinite(category.score) ? Math.round(category.score) : null;
    return `<article class="category-item">
      <div class="category-top"><span>${escapeHtml(category.name)}</span><strong>${value ?? "--"}</strong></div>
      <div class="mini-bar"><i style="width:${value ?? 0}%;background:${value === null ? "#aaa" : scoreColor(value)}"></i></div>
    </article>`;
  }).join("");
}

function renderDrivers(data) {
  const drivers = data.indicators
    .filter((item) => item.available && Number.isFinite(item.points))
    .sort((a, b) => b.points - a.points)
    .slice(0, 3);
  const driverPoints = drivers.reduce((sum, item) => sum + item.points, 0);
  const share = data.rawPoints > 0 ? Math.round((driverPoints / data.rawPoints) * 100) : 0;

  els.driversSummary.textContent = drivers.length
    ? `前三项原始加权点数合计 ${driverPoints.toFixed(1)}，占有效指标原始点数的 ${share}%。这里尚未按有效权重归一化，也未加入规则修正。点击可定位到信号详情。`
    : "暂无可用信号，请稍后刷新数据。";
  els.drivers.innerHTML = drivers.map((item, index) => {
    const risk = Number.isFinite(item.risk) ? Math.round(item.risk) : 0;
    return `<button class="driver-item" type="button" data-focus-key="driver-${escapeHtml(item.id)}" data-driver-id="${escapeHtml(item.id)}" data-driver-category="${escapeHtml(item.category)}">
      <span class="driver-rank">0${index + 1}</span>
      <span class="driver-copy"><small>${escapeHtml(item.category)}</small><strong>${escapeHtml(item.title)}</strong><span>${escapeHtml(item.detail || item.description)}</span></span>
      <span class="driver-score"><strong>${item.points.toFixed(1)}</strong><small>/ ${item.weight} 分</small><i><b style="width:${risk}%;background:${scoreColor(risk)}"></b></i></span>
    </button>`;
  }).join("");
}

function escapeHtml(value) {
  return String(value ?? "").replace(/[&<>"']/g, (char) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[char]);
}

function safeExternalUrl(value) {
  try {
    const url = new URL(String(value || ""), window.location.href);
    return ["http:", "https:"].includes(url.protocol) ? escapeHtml(url.href) : "#";
  } catch {
    return "#";
  }
}

function renderStructureTiming() {
  if (!els.structureTiming) return;
  const rows = [["vix", "VIX"], ["breadth", "宽度"], ["sp500", "SPX"]].map(([id, label]) => ({
    label, date: state.data?.indicators.find((item) => item.id === id)?.date || null,
  }));
  const today = dateInTimeZone();
  const lag = rows.some(({ date }) => date && date < today);
  const sameDate = rows[0].date && rows.every(({ date }) => date === rows[0].date);
  const dates = sameDate ? `VIX / 宽度 / SPX：${rows[0].date}` : rows.map(({ label, date }) => `${label} ${date || "待核对"}`).join(" · ");
  els.structureTiming.dataset.lag = String(lag);
  els.structureTiming.textContent = `${dates}。${lag ? "部分日度输入早于纽约今日；" : "日度模型输入；"}盘中报价不计入本分。`;
}

function pulsePercent(value, digits = 2) {
  return Number.isFinite(value) ? `${value > 0 ? "+" : ""}${value.toFixed(digits)}%` : "涨跌待核对";
}

function pulseSourceName(url) {
  const host = new URL(url).hostname.replace(/^www\./, "");
  return host === "cboe.com" ? "Cboe" : host === "nasdaq.com" ? "Nasdaq" : host;
}

function renderMarketPulse() {
  if (!els.pulseStatus) return;
  const pulse = projectMarketPulse(pulseState.snapshot);
  const blocked = navigator.onLine === false || Boolean(pulseState.error);
  const reference = pulse.mode === "reference";
  const loading = Boolean(pulseState.controller);
  const usable = !blocked && (pulse.status === "current" || pulse.status === "last-close");
  const current = usable && pulse.status === "current";
  const bySymbol = new Map(pulse.quotes.map((quote) => [quote.symbol, quote]));
  const broad = { severe: "大盘急跌", pressure: "大盘承压", none: "大盘未触发急跌", unconfirmed: "大盘待核对" }[pulse.broad.level];
  const sectorSelloff = pulse.sector.flags.some((flag) => flag.symbol !== "VXSMH" && flag.level === "severe");
  const sector = { severe: sectorSelloff ? "板块急跌" : "板块波动升高", pressure: "板块承压", none: "板块未触发压力", unconfirmed: "板块待核对" }[pulse.sector.level];
  const shortDate = pulse.date?.split("-").slice(1).map(Number).join("/");
  const scope = pulse.session === "close" ? (reference ? "收盘参考" : "收盘段") : "盘中延时";
  const datedScope = shortDate ? `${shortDate} ${scope}` : scope;
  const shortStatus = navigator.onLine === false ? "离线 · 当日压力待判断"
    : pulseState.error ? "报价连接异常 · 当日压力待判断"
      : current ? `${datedScope} · ${broad} · ${sector}`
        : usable ? `${shortDate ? `${shortDate} ` : ""}最近收盘 · 当日压力待判断`
          : pulse.status === "stale" ? "历史报价 · 当日压力待判断"
            : loading ? "正在读取当日报价 · 压力待判断" : "独立行情待同步 · 可看官方报价";
  if (els.pulsePeekStatus.textContent !== shortStatus) els.pulsePeekStatus.textContent = shortStatus;
  els.pulsePeek.dataset.state = blocked ? "unavailable" : pulse.status;
  els.pulsePeek.dataset.level = current && (pulse.broad.level === "severe" || pulse.sector.level === "severe") ? "severe" : "neutral";
  for (const [symbol, target] of [["VIX", els.pulsePeekVix], ["VXSMH", els.pulsePeekVxsmh]]) {
    const row = bySymbol.get(symbol);
    const valid = usable && row?.state === pulse.status;
    target.textContent = valid ? `${symbol} ${row.value.toFixed(2)}${Number.isFinite(row.changePercent) ? ` ${pulsePercent(row.changePercent, 1)}` : ""}` : `${symbol} —`;
  }
  const checkedAt = pulse.checkedAt ? new Date(pulse.checkedAt) : null;
  const timeNote = checkedAt ? ` · 核对于 ${dateInTimeZone(checkedAt)} ${nyQuoteTime.format(checkedAt)}（纽约）` : "";
  const status = blocked ? `${shortStatus}。下方如有数值，仅为上次记录。`
    : reference && pulse.quotes.length ? `已核对记录 · 查看官方最新报价。${pulse.label}；这些数值不会自动更新。`
      : pulse.status === "unavailable" ? `${shortStatus}。缺失报价不代表市场平静。`
        : `${pulse.label}${pulse.errors.length ? " · 部分来源待核对" : ""}${loading ? " · 正在核对更新" : ""}。`;
  els.pulseStatus.textContent = `${status}${timeNote}${pulse.ruleNote ? ` ${pulse.ruleNote}` : ""}`;
  if (reference && document.activeElement === els.pulseRefresh) document.querySelector(".pulse-official a")?.focus({ preventScroll: true });
  els.pulseRefresh.hidden = reference;
  els.pulseRefresh.textContent = loading ? "正在读取报价" : pulse.mode === "feed" ? "刷新报价" : "重试读取报价";
  els.pulseRefresh.setAttribute("aria-disabled", String(loading || navigator.onLine === false));

  const judgments = [["broad", "大盘广度"], ["sector", "板块与成长"], ["volatility", "隐含波动"]].map(([kind, title]) => {
    const row = usable ? pulse[kind] : { level: "unconfirmed", label: "待判断", detail: "暂无可比较的有效报价。" };
    return `<article class="pulse-judgment" data-kind="${kind}" data-level="${escapeHtml(row.level)}"><h3>${title}</h3><strong>${escapeHtml(row.label)}</strong><p>${escapeHtml(row.detail)}</p></article>`;
  }).join("");
  if (els.pulseJudgments.innerHTML !== judgments) els.pulseJudgments.innerHTML = judgments;
  const quotes = pulseSymbols.map(([symbol, label]) => {
    const row = bySymbol.get(symbol);
    const at = row?.at ? new Date(row.at) : null;
    const session = row?.session === "regular" ? "延时报价" : row?.session === "close"
      ? reference && ["VIX", "VXSMH", "SPX"].includes(symbol) ? "延时 · 收盘段" : reference ? "常规收盘" : "收盘段"
      : "时段未确认";
    const rowState = blocked ? "unconfirmed" : row?.state || "unconfirmed";
    const qualifier = !row ? "报价暂缺" : blocked ? `${session} · 上次记录` : rowState === "stale" ? `${session} · 历史记录` : rowState === "unconfirmed" ? `${session} · 待核对` : rowState === "last-close" ? `${session} · 最近收盘` : session;
    const date = row?.date ? `<time datetime="${escapeHtml(row.at || row.date)}">${escapeHtml(row.date)}${at ? ` ${nyQuoteTime.format(at)}` : " · 时点待核对"}</time>` : "<span>观测日期待核对</span>";
    const change = row?.changePercent;
    return `<article class="pulse-quote" data-symbol="${symbol}" data-state="${rowState}"><h3>${symbol} <span>${label}</span></h3><p class="pulse-quote-reading"><strong>${Number.isFinite(row?.value) ? row.value.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 }) : "—"}</strong><span class="pulse-quote-change" data-move="${change < 0 ? "down" : change > 0 ? "up" : "flat"}" aria-label="日变化：${pulsePercent(change)}">${pulsePercent(change)}</span></p><p class="pulse-quote-time"><span>${qualifier}</span>${date}</p>${row ? `<a class="pulse-quote-source" data-focus-key="pulse-source-${symbol}" href="${safeExternalUrl(row.source)}" target="_blank" rel="noreferrer" aria-label="${symbol} 报价来源：${escapeHtml(pulseSourceName(row.source))}">${escapeHtml(pulseSourceName(row.source))} ↗</a>` : ""}</article>`;
  }).join("");
  if (els.pulseQuotes.innerHTML !== quotes) {
    const focused = els.pulseQuotes.contains(document.activeElement) ? document.activeElement : null;
    els.pulseQuotes.innerHTML = quotes;
    if (focused && document.activeElement === document.body) {
      const key = focused.dataset.focusKey;
      (els.pulseQuotes.querySelector(`[data-focus-key="${CSS.escape(key || "")}"]`) || els.pulsePeek.querySelector("a")).focus({ preventScroll: true });
    }
  }
  const errors = [...(pulseState.error ? [pulseState.error] : []), ...pulse.errors];
  const list = errors.map((error) => `<li>${escapeHtml(error)}</li>`).join("");
  const errorList = els.pulseErrors.querySelector("ul");
  const hidingFocused = !errors.length && els.pulseErrors.contains(document.activeElement);
  if (errorList.innerHTML !== list) errorList.innerHTML = list;
  els.pulseErrors.hidden = !errors.length;
  if (hidingFocused) els.pulsePeek.querySelector("a").focus({ preventScroll: true });
  renderStructureTiming();
}

async function loadMarketPulse() {
  if (!els.pulseStatus || pulseState.controller) return;
  if (navigator.onLine === false) { renderMarketPulse(); return; }
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 12_000);
  pulseState.controller = controller;
  pulseState.lastAttemptAt = Date.now();
  renderMarketPulse();
  try {
    const response = await fetch("/api/market-pulse", { signal: controller.signal, cache: "no-store" });
    if (!response.ok) throw new Error("报价接口暂不可用。");
    const snapshot = await response.json();
    if (!isMarketPulseSnapshot(snapshot)) throw new Error("报价资料格式异常。");
    if (pulseState.controller !== controller) return;
    pulseState.snapshot = snapshot;
    pulseState.error = null;
  } catch (error) {
    if (pulseState.controller !== controller) return;
    pulseState.error = controller.signal.aborted ? "报价请求超时。" : error instanceof SyntaxError ? "报价资料格式异常。" : "暂时无法读取报价。";
  } finally {
    clearTimeout(timeout);
    controller.abort();
    if (pulseState.controller === controller) {
      pulseState.controller = null;
      renderMarketPulse();
    }
  }
}

function safeTone(value) {
  return ["positive", "negative", "mixed", "good", "bad"].includes(value) ? value : "mixed";
}

function scheduleLabel(status, basis) {
  if (status === "confirmed") return "公司确认";
  if (status === "pending") return "待核对";
  if (basis === "quarterly-fallback") return "季度推算";
  return basis === "nasdaq" ? "Nasdaq 预估" : "日期预估";
}

function renderAiEarnings(rows = [], layers = [], checks = []) {
  renderEarningsChecks(rows, checks);
  const checksByTicker = new Map(checks.map((check) => [check.ticker, check]));
  els.aiChainMap.innerHTML = layers.map((layer, index) => `<article class="ai-layer-card">
    <span class="ai-layer-index">0${index + 1}</span><h3>${escapeHtml(layer.name)}</h3><p>${escapeHtml(layer.description)}</p>
    <div>${layer.tickers.map((ticker) => `<b>${escapeHtml(ticker)}</b>`).join("")}</div>
  </article>`).join("");

  els.aiCompanyGrid.innerHTML = rows.map((row) => {
    const check = checksByTicker.get(row.ticker);
    const reviewRequired = Boolean(row.reviewRequired) || check?.status === "review-required";
    const historical = Boolean(row.snapshotStale) || reviewRequired;
    const reviewStatus = reviewRequired ? "review-required" : check?.status || row.earningsReviewStatus || "unknown";
    const latestReport = row.latestReport || check?.latestReport;
    const reportPeriod = latestReport ? [latestReport.period, latestReport.periodEnd ? `期末 ${latestReport.periodEnd}` : ""].filter(Boolean).join(" · ") : "";
    const reportSource = latestReport?.source || latestReport?.url;
    const newReportLink = reviewRequired && reportSource ? `<a class="earnings-report-link" data-focus-key="new-report-${escapeHtml(row.ticker)}" aria-label="查看新发布官方报告：${escapeHtml(row.company)} ${escapeHtml(row.ticker)} ${escapeHtml(reportPeriod)}" href="${safeExternalUrl(reportSource)}" target="_blank" rel="noreferrer">查看已发布报告：${escapeHtml(reportPeriod || latestReport.title)}</a>` : "";
    const reviewNotice = reviewRequired
      ? `<div class="ai-review-notice review-required"><strong>官方新报告已发布，旧解读待复核</strong><p>本卡保留已审核的 ${escapeHtml(row.period)} 资料，暂不参与自动评分。</p>${newReportLink}</div>`
      : reviewStatus !== "no-newer-report"
        ? `<div class="ai-review-notice"><strong>最新性待核对</strong><p>当前展示已审核的 ${escapeHtml(row.period)} 资料，尚无法确认是否有更新季度报告。</p></div>` : "";
    const nextReportLabel = row.nextReportLabel || row.nextReportDate || "待官方公布";
    const scheduleConfirmed = row.nextReportStatus === "confirmed";
    const scheduleSource = row.nextReportSource ? `<a class="date-source" data-focus-key="report-date-${escapeHtml(row.ticker)}" aria-label="核对日期：${escapeHtml(row.company)} ${escapeHtml(row.ticker)} 下次财报" href="${safeExternalUrl(row.nextReportSource)}" target="_blank" rel="noreferrer">核对日期</a>` : "";
    return `<article class="ai-company-card${historical ? " snapshot-stale" : ""}" data-earnings-status="${escapeHtml(reviewStatus)}">
    <div class="ai-card-head">
      <span class="ai-layer-pill">${escapeHtml(row.layer)}</span>
      <div class="ai-snapshot-meta"><time>${escapeHtml(row.snapshotLabel || `资料截至 ${row.released}`)}</time>${reviewRequired ? '<span class="ai-stale-badge">待复核</span>' : row.snapshotStale ? '<span class="ai-stale-badge">待更新</span>' : ""}</div>
    </div>
    <div class="ai-company-title"><div><h3>${escapeHtml(row.company)}</h3><span>${escapeHtml(row.ticker)} · ${escapeHtml(row.period)}</span></div><strong>${escapeHtml(row.role)}</strong></div>
    ${reviewNotice}
    <p class="ai-impact">${escapeHtml(row.impact)}</p>
    <div class="ai-financials">
      <div><span>${historical ? "历史营收" : "营收"}</span><strong>${escapeHtml(row.revenue)}</strong></div>
      <div><span>${historical ? "历史净利润" : "净利润"}</span><strong>${escapeHtml(row.netIncome)}</strong></div>
      <div><span>${historical ? "历史" : ""}${escapeHtml(row.marginLabel || "毛利率")}</span><strong>${escapeHtml(row.grossMargin)}</strong></div>
    </div>
    <div class="ai-readout">
      <div><span>${historical ? "历史表现" : "已审核季度表现 · 研究解读"}</span><p class="assessment ${safeTone(row.resultTone)}">${escapeHtml(row.resultAssessment)}</p></div>
      <div><span>${historical ? "历史指引" : "已审核指引 · 研究解读"}</span><p class="assessment ${safeTone(row.guidanceTone)}">${escapeHtml(row.guidanceAssessment)}</p></div>
    </div>
    <div class="ai-guidance-copy"><span>${historical ? "历史公司指引" : "已审核公司指引 / 展望"}</span><p>${escapeHtml(row.guidance)}</p>${row.guidanceSource ? `<a class="date-source" data-focus-key="guidance-${escapeHtml(row.ticker)}" href="${safeExternalUrl(row.guidanceSource)}" target="_blank" rel="noreferrer">查看官方指引原文</a>` : ""}<small>${escapeHtml(row.note)}</small></div>
    <div class="ai-card-foot"><a data-focus-key="financial-${escapeHtml(row.ticker)}" aria-label="查看官方财报：${escapeHtml(row.company)} ${escapeHtml(row.ticker)} ${escapeHtml(row.period)}" href="${safeExternalUrl(row.source)}" target="_blank" rel="noreferrer">查看官方财报</a><div class="ai-next-report"><span>下次财报 <strong>${escapeHtml(nextReportLabel)}</strong></span><i class="schedule-status ${scheduleConfirmed ? "confirmed" : "estimated"}">${scheduleLabel(row.nextReportStatus, row.nextReportBasis)}</i>${scheduleSource}</div></div>
  </article>`;
  }).join("");
}

function renderEarningsChecks(rows = [], checks = []) {
  if (!els.earningsStatus) return;
  const checksByTicker = new Map(checks.map((check) => [check.ticker, check]));
  const states = rows.map((row) => {
    const check = checksByTicker.get(row.ticker);
    const status = row.reviewRequired || check?.status === "review-required" ? "review-required"
      : check?.status === "no-newer-report" || (!check && row.earningsReviewStatus === "no-newer-report") ? "no-newer-report" : "unknown";
    return { row, check, status };
  });
  const reviewCount = states.filter((item) => item.status === "review-required").length;
  const unknownCount = states.filter((item) => item.status === "unknown").length;
  let summary = els.earningsStatus.querySelector(".earnings-check-summary") || els.earningsStatus.querySelector("p");
  if (!summary) {
    summary = document.createElement("p");
    els.earningsStatus.append(summary);
  }
  summary.className = "earnings-check-summary";
  const summaryText = `官方财报发布监测：${rows.length} 家公司 · ${reviewCount} 家新报告解读待复核 · ${unknownCount} 家最新性待核对。发布监测不会自动改写财报正文。`;
  if (summary.textContent !== summaryText) summary.textContent = summaryText;
  let details = els.earningsStatus.querySelector("details");
  if (!details) {
    details = document.createElement("details");
    const label = document.createElement("summary");
    label.dataset.focusKey = "earnings-check-details";
    const list = document.createElement("ul");
    list.className = "earnings-check-list";
    details.append(label, list);
    els.earningsStatus.append(details);
  }
  details.querySelector("summary").textContent = `查看 ${rows.length} 家公司的核验状态`;
  const labels = { "review-required": "待复核", "no-newer-report": "本次未发现更新季度", unknown: "最新性待核对" };
  details.querySelector("ul").innerHTML = states.map(({ row, check, status }) => {
    const report = row.latestReport || check?.latestReport;
    const reportPeriod = report ? [report.period, report.periodEnd ? `期末 ${report.periodEnd}` : ""].filter(Boolean).join(" · ") : "";
    const source = report?.source || report?.url;
    const checkedAt = Date.parse(check?.checkedAt);
    const checkTime = Number.isFinite(checkedAt) && checkedAt <= Date.now() ? `最近成功核对 ${formatDate(check.checkedAt)}` : "最近成功核对时间未知";
    const fallback = status === "review-required" ? "官方新报告已发布，原财报解读待复核，暂不参与自动评分。"
      : status === "no-newer-report" ? `本次官方来源未发现比已审核 ${row.period} 更新的季度报告。` : "尚无法确认是否有更新季度报告。";
    return `<li data-earnings-ticker="${escapeHtml(row.ticker)}"><div class="earnings-check-heading"><strong>${escapeHtml(row.company)} · ${escapeHtml(row.ticker)}</strong><span>${labels[status]}</span></div><p>${escapeHtml(check?.message || fallback)}</p><small>${escapeHtml(checkTime)}</small>${source ? `<a class="earnings-report-link" data-focus-key="earnings-source-${escapeHtml(row.ticker)}" aria-label="查看发布监测报告：${escapeHtml(row.company)} ${escapeHtml(row.ticker)} ${escapeHtml(reportPeriod)}" href="${safeExternalUrl(source)}" target="_blank" rel="noreferrer">查看官方报告：${escapeHtml(reportPeriod || report.title)}</a>` : ""}</li>`;
  }).join("");
}

function renderReminders(rows = []) {
  const todayParts = dateInTimeZone().split("-").map(Number);
  const todayUtc = Date.UTC(todayParts[0], todayParts[1] - 1, todayParts[2]);
  els.reminderGrid.innerHTML = rows.map((row, index) => {
    const dateParts = row.date?.split("-").map(Number);
    const days = dateParts?.length === 3
      ? Math.round((Date.UTC(dateParts[0], dateParts[1] - 1, dateParts[2]) - todayUtc) / 86_400_000)
      : null;
    const companyList = row.companies?.length ? `<div class="company-reminder-list">${row.companies.map((company) => `<div class="company-reminder-item"><b>${escapeHtml(company.ticker)}</b><em>上期 ${escapeHtml(company.released)}</em><em>下期 ${escapeHtml(company.next)}</em><i class="${company.status === "confirmed" ? "confirmed" : "estimated"}">${scheduleLabel(company.status, company.basis)}</i>${company.source ? `<a data-focus-key="company-date-${escapeHtml(company.ticker)}" aria-label="核对日期：${escapeHtml(company.ticker)} 下次财报" href="${safeExternalUrl(company.source)}" target="_blank" rel="noreferrer">核对日期</a>` : ""}</div>`).join("")}</div>` : "";
    const sourceLink = !row.companies?.length && row.linkLabel ? `<a class="reminder-source" data-focus-key="calendar-${escapeHtml(row.indicatorId)}" href="${safeExternalUrl(row.source)}" target="_blank" rel="noreferrer">${escapeHtml(row.linkLabel)} <span aria-hidden="true">↗</span></a>` : "";
    const relativeLabel = days === null ? "" : days < 0 ? "日期已过" : days === 0 ? "今天" : `${days} 天后`;
    const dateLabel = row.date ? escapeHtml(row.date) : row.companies ? "逐家公司" : "待核对";
    return `<article class="reminder-card${row.companies?.length ? " company-card" : ""}">
      <span class="reminder-index">${String(index + 1).padStart(2, "0")}</span><div class="reminder-copy"><small>${escapeHtml(row.label)}</small><strong>${escapeHtml(row.event)}</strong>${sourceLink}</div>
      <time>${dateLabel}${relativeLabel ? `<b>${relativeLabel}</b>` : ""}</time>${companyList}
    </article>`;
  }).join("");
}

function renderCalendarSync(sync) {
  if (!els.calendarSyncStatus) return;
  if (!sync?.updatedAt) {
    els.calendarSyncStatus.textContent = "正在核对 BLS、Federal Reserve 与 Nasdaq 官方日程";
    return;
  }
  const sources = Object.values(sync.sources || {});
  const failed = sources.filter((source) => source?.error).length;
  const cadence = Number.isFinite(sync.refreshEveryHours) ? ` · 每 ${sync.refreshEveryHours} 小时自动核对` : "";
  const failureRetry = Number.isFinite(sync.retryAfterFailureMinutes) ? ` · 失败后每 ${sync.retryAfterFailureMinutes} 分钟重试` : cadence;
  els.calendarSyncStatus.textContent = failed
    ? `日程日期按纽约时间 · 最近核对 ${formatDate(sync.updatedAt)} · ${failed} 个来源暂不可用，已保留最近成功日程${failureRetry}`
    : `日程日期按纽约时间 · 最近核对 ${formatDate(sync.updatedAt)}${cadence}`;
}

function sparklineSvg(points) {
  const series = (points || []).filter((point) => Number.isFinite(point?.value));
  if (series.length < 2) return `<svg class="sparkline" viewBox="0 0 170 72" aria-hidden="true"><path class="line" d="M0 36 L170 36" opacity=".15"/></svg>`;
  const values = series.map((point) => point.value);
  const min = Math.min(...values);
  const max = Math.max(...values);
  const spread = max - min || 1;
  const coords = series.map((point, index) => {
    const x = (index / (series.length - 1)) * 170;
    const y = 66 - ((point.value - min) / spread) * 56;
    return [x, y];
  });
  const line = coords.map(([x, y], index) => `${index ? "L" : "M"}${x.toFixed(1)} ${y.toFixed(1)}`).join(" ");
  const area = `${line} L170 72 L0 72 Z`;
  const last = coords.at(-1);
  return `<svg class="sparkline" viewBox="0 0 170 72" preserveAspectRatio="none" aria-hidden="true"><path class="area" d="${area}"/><path class="line" d="${line}"/><circle class="end" cx="${last[0]}" cy="${last[1]}" r="2.8"/></svg>`;
}

function confidenceLabel(value) {
  return ({ high: "高可信", proxy: "代理值", manual: "人工", medium: "中可信", unavailable: "数据不足" })[value] || value;
}

function renderIndicators(data) {
  const filtered = data.indicators.filter((item) => state.filter === "全部" || item.category === state.filter);
  els.grid.innerHTML = filtered.map((item) => {
    const risk = Number.isFinite(item.risk) ? item.risk : null;
    const color = risk === null ? "#a1a39c" : scoreColor(risk);
    const chipText = item.overridden ? "人工覆盖" : risk === null ? (item.unavailableReason || "待接入") : risk >= 80 ? "严重" : risk >= 55 ? "偏高" : risk >= 30 ? "观察" : "温和";
    const index = String(data.indicators.findIndex((source) => source.id === item.id) + 1).padStart(2, "0");
    const manualCapable = manualConfig.some((config) => config.id === item.id);
    const status = ["critical", "high", "watch", "low", "unavailable"].includes(item.status) ? item.status : "unavailable";
    return `<article class="indicator-card" id="indicator-${escapeHtml(item.id)}" data-focus-key="signal-${escapeHtml(item.id)}" tabindex="-1" data-category="${escapeHtml(item.category)}">
      <div class="card-head">
        <div><span class="card-index">${index} · ${escapeHtml(item.category)} · 权重 ${escapeHtml(item.weight)}${item.id === "vix" ? " · 日度模型输入" : ""}</span><h3 class="card-title">${escapeHtml(item.title)}</h3></div>
        <span class="risk-chip ${status}">${escapeHtml(chipText)}</span>
      </div>
      <div class="card-main">
        <div><div class="metric-value">${escapeHtml(item.value)}</div><div class="metric-detail">${escapeHtml(item.detail || "")}${item.date ? ` · ${escapeHtml(item.date)}` : ""}</div></div>
        ${sparklineSvg(item.sparkline)}
      </div>
      ${item.breakdown?.length ? `<div class="metric-breakdown metric-breakdown-${Math.min(item.breakdown.length, 4)}">${item.breakdown.map((metric) => `<div><span>${escapeHtml(metric.label)}</span><strong>${escapeHtml(metric.value)}</strong><small>${escapeHtml(metric.detail)}</small></div>`).join("")}</div>` : ""}
      ${item.judgment ? `<div class="indicator-judgment ${safeTone(item.judgment.tone)}"><strong>${escapeHtml(item.judgment.label)}</strong><span>${escapeHtml(item.judgment.text)}</span></div>` : ""}
      <div class="score-row"><span>风险强度 ${risk === null ? "--" : Math.round(risk)}</span><div class="risk-bar"><i style="width:${risk ?? 0}%;background:${color}"></i></div><strong class="score-points">${item.points === null ? "--" : item.points.toFixed(1)} / ${item.weight}</strong></div>
      <p class="card-copy">${escapeHtml(item.description)}<br /><strong>为什么重要：</strong>${escapeHtml(item.why)}</p>
      ${manualCapable ? `<button class="manual-edit" data-focus-key="manual-${escapeHtml(item.id)}" data-manual-id="${escapeHtml(item.id)}" type="button">${item.overridden ? "修改人工数据" : "录入更准确的数据"}</button>` : ""}
      <div class="card-foot"><a class="source-link" data-focus-key="source-${escapeHtml(item.id)}" href="${safeExternalUrl(item.source?.url)}" target="_blank" rel="noreferrer">${item.overridden ? "公开参考资料（非人工判断来源）" : "查看官方数据"} · ${escapeHtml(item.source?.label)}</a><span class="cadence">${escapeHtml(item.cadence)}<span class="confidence">${escapeHtml(confidenceLabel(item.confidence))}</span></span></div>
    </article>`;
  }).join("");
}

function renderErrors(errors = []) {
  let message = els.error.querySelector(".error-message");
  if (!message) {
    message = document.createElement("p");
    message.className = "error-message";
    els.error.append(message);
  }
  let details = els.error.querySelector("details");
  const focused = document.activeElement;
  const detailsFocused = details?.contains(focused);
  const visibleErrors = errors.slice(0, 3);
  const remaining = errors.length - visibleErrors.length;
  const text = state.loadError
    ? `无法更新数据：${state.loadError}。${state.data ? "已保留上次显示的数据，" : ""}请稍后重试。`
    : errors.length ? `部分数据或研究资料仍待核对，当前显示内容可能不完整或来自缓存：${visibleErrors.join("；")}${remaining ? `；另有 ${remaining} 项详情` : ""}` : "";
  els.error.hidden = !text;
  els.error.removeAttribute("title");
  if (message.textContent !== text) message.textContent = text;
  if (!state.loadError && remaining) {
    if (!details) {
      details = document.createElement("details");
      const summary = document.createElement("summary");
      summary.dataset.focusKey = "error-details";
      details.append(summary, document.createElement("ul"));
      els.error.append(details);
    }
    // Keep the native disclosure node so polling preserves its open state and focus.
    details.hidden = false;
    const summary = details.querySelector("summary");
    const label = `查看全部 ${errors.length} 个来源详情`;
    if (summary.textContent !== label) summary.textContent = label;
    const list = details.querySelector("ul");
    if (JSON.stringify(Array.from(list.children, item => item.textContent)) !== JSON.stringify(errors)) {
      list.replaceChildren(...errors.map(error => {
        const item = document.createElement("li");
        item.textContent = error;
        return item;
      }));
    }
  } else if (details) {
    details.hidden = true;
    details.querySelector("ul").replaceChildren();
  }
  if (detailsFocused && (els.error.hidden || details.hidden)) {
    queueMicrotask(() => {
      if (document.activeElement === focused || document.activeElement === document.body) els.refresh.focus({ preventScroll: true });
    });
  }
}

function render() {
  if (!state.data) return;
  const focused = document.activeElement;
  const focusKey = focused?.dataset.focusKey;
  const data = applyOverrides(projectDashboard(state.data));
  state.displayValidity = `${dateInTimeZone()}:${data.cacheExpired}`;
  renderSummary(data);
  renderMethodology(data);
  renderSourceRevisions(data.sourceRevisions);
  renderCategories(data.categories);
  renderDrivers(data);
  renderIndicators(data);
  renderAiEarnings(data.aiEarnings, data.aiChainLayers, data.earningsChecks);
  renderReminders(data.reminders);
  renderCalendarSync(data.calendarSync);
  renderPublicationChecks(data.publicationChecks);
  const calendarErrors = Object.entries(data.calendarSync?.sources || {}).filter(([, source]) => source?.error)
    .map(([key]) => `${({ bls: "CPI / 就业", fomc: "美联储", earnings: "财报" })[key] || key}日程来源暂不可用`);
  renderErrors([...(data.errors || []), ...calendarErrors, ...(data.publicationErrors || []), ...(data.earningsErrors || [])]);
  if (focusKey && !focused.isConnected && (document.activeElement === document.body || document.activeElement === focused)) {
    const matching = document.querySelector(`[data-focus-key="${CSS.escape(focusKey)}"]`);
    const fallback = focusKey.startsWith("driver-") ? els.drivers.querySelector(".driver-item") : els.manualButton;
    const target = matching?.getClientRects().length ? matching : fallback || els.manualButton;
    target.focus({ preventScroll: true });
  }
}

function renderPublicationChecks(checks = []) {
  els.publicationStatus.hidden = checks.length === 0;
  els.publicationStatus.innerHTML = checks.length ? `<strong>宏观发布核验</strong><span>${checks.map((row) => `<a data-focus-key="publication-${escapeHtml(row.kind)}" href="${safeExternalUrl(row.releaseUrl || row.source)}" target="_blank" rel="noreferrer">${escapeHtml(row.label)}</a>：${escapeHtml(row.message)}`).join("；")}</span>` : "";
}

function renderSourceRevisions(revisions = []) {
  if (!els.sourceRevisions || !els.revisionList) return;
  const rows = Array.isArray(revisions) ? revisions.filter((row) => row && typeof row.series === "string" && typeof row.label === "string"
    && typeof row.date === "string" && Number.isFinite(row.before) && Number.isFinite(row.after) && typeof row.firstDetectedAt === "string") : [];
  const focused = els.sourceRevisions.contains(document.activeElement);
  els.sourceRevisions.hidden = rows.length === 0;
  els.sourceRevisions.querySelector("summary").textContent = `供应商历史值修订（${rows.length}条）`;
  els.revisionList.innerHTML = rows.map((row) => `<li><strong>${escapeHtml(row.label)} · ${escapeHtml(row.series)}</strong><span>观测期 ${escapeHtml(row.date)}：${escapeHtml(row.before)} → ${escapeHtml(row.after)}</span><small>首次检测 ${escapeHtml(row.firstDetectedAt)}</small></li>`).join("");
  if (!rows.length && focused) document.querySelector("#scoreMethodology > summary").focus({ preventScroll: true });
}

function validationObject(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function validationCount(value) {
  return Number.isSafeInteger(value) && value >= 0;
}

function validationTextList(value) {
  return Array.isArray(value) && value.length <= 30 && value.every((item) => typeof item === "string" && item.length <= 3000);
}

function validHistoryReport(data) {
  const history = data?.history;
  const stats = (row) => validationObject(row) && validationCount(row.n)
    && ["meanReturnPct", "meanMaxDrawdownPct", "worstMaxDrawdownPct"].every((key) => row.n === 0 ? row[key] === null || Number.isFinite(row[key]) : Number.isFinite(row[key]))
    && (row.meanMaxDrawdownPct === null || row.meanMaxDrawdownPct <= 0)
    && (row.worstMaxDrawdownPct === null || row.worstMaxDrawdownPct <= 0);
  return validationObject(data) && data.version === 1 && typeof data.scoringVersion === "string" && data.scoringVersion.length <= 80
    && typeof data.updatedAt === "string" && Number.isFinite(Date.parse(data.updatedAt))
    && validationObject(history) && history.status === "partial-diagnostic"
    && [history.from, history.to].every((date) => typeof date === "string" && Number.isFinite(Date.parse(date))) && history.from <= history.to
    && validationCount(history.scheduledSamples) && validationCount(history.scoredSamples) && history.scoredSamples <= history.scheduledSamples
    && validationObject(history.coverage) && Number.isFinite(history.coverage.min) && Number.isFinite(history.coverage.max)
    && history.coverage.min >= 0 && history.coverage.max <= 100 && history.coverage.min <= history.coverage.max
    && Number.isFinite(history.excludedWeight) && history.excludedWeight >= 0 && history.excludedWeight <= 100
    && typeof history.conclusion === "string" && history.conclusion.length <= 5000 && validationTextList(history.limitations)
    && Array.isArray(history.horizons) && history.horizons.length === 2
    && new Set(history.horizons.map((row) => row?.tradingDays)).size === 2
    && history.horizons.every((row) => validationObject(row) && [21, 63].includes(row.tradingDays) && validationCount(row.samples)
      && stats(row.baseline) && row.baseline.n === row.samples && Array.isArray(row.bands) && row.bands.length <= 10
      && row.bands.every((band) => stats(band) && typeof band.label === "string" && band.label.length <= 80));
}

function validForwardReport(data) {
  const date = (value) => value === null || (typeof value === "string" && Number.isFinite(Date.parse(value)));
  return validationObject(data) && data.version === 1 && ["awaiting-outcomes", "descriptive-only"].includes(data.status)
    && validationCount(data.observedSamples) && date(data.firstObservationDate) && date(data.lastObservationDate)
    && (data.generatedAt === null ? data.observedSamples === 0 : typeof data.generatedAt === "string" && Number.isFinite(Date.parse(data.generatedAt))) && validationTextList(data.limitations)
    && (data.benchmark === undefined || (validationObject(data.benchmark) && (data.benchmark.error == null || (typeof data.benchmark.error === "string" && data.benchmark.error.length <= 3000))))
    && Array.isArray(data.outcomes) && data.outcomes.length === 2 && new Set(data.outcomes.map((row) => row?.tradingDays)).size === 2
    && data.outcomes.every((row) => validationObject(row) && [21, 63].includes(row.tradingDays)
      && validationCount(row.samples) && validationCount(row.immatureSamples)
      && (row.unavailableScoreSamples === undefined || validationCount(row.unavailableScoreSamples))
      && row.samples + row.immatureSamples + (row.unavailableScoreSamples || 0) <= data.observedSamples
      && ["meanReturnPercent", "meanDrawdownPercent", "worstDrawdownPercent"].every((key) => row[key] === null || Number.isFinite(row[key])));
}

function historicalPercent(value, samples) {
  return samples === 0 || !Number.isFinite(value) ? "—" : `${value > 0 ? "+" : ""}${value.toFixed(2)}%`;
}

function historyStatsCells(row) {
  return `<td>${row.n}</td><td>${historicalPercent(row.meanReturnPct, row.n)}</td><td>${historicalPercent(row.meanMaxDrawdownPct, row.n)}</td><td>${historicalPercent(row.worstMaxDrawdownPct, row.n)}</td>`;
}

function renderHistoryReport(data) {
  const history = data.history;
  const columns = '<th scope="col">样本</th><th scope="col">平均收益</th><th scope="col">平均最大回撤</th><th scope="col">最差最大回撤</th>';
  els.modelHistory.innerHTML = `<h3>历史检验：部分指标诊断</h3>
    <p class="validation-coverage"><strong>${history.scoredSamples} / ${history.scheduledSamples} 个计划检验样本可评分</strong><span>有效权重覆盖 ${history.coverage.min}–${history.coverage.max}%</span><strong>${history.excludedWeight}% 权重未纳入本次诊断</strong></p>
    <p class="validation-note">${escapeHtml(history.from)} 至 ${escapeHtml(history.to)} · 评分模型 ${escapeHtml(data.scoringVersion)} · 资料更新 ${escapeHtml(data.updatedAt.slice(0, 10))}</p>
    <p>${escapeHtml(history.conclusion)}</p>
    <p class="validation-caution">以下统计仅描述这一批可评分样本，不能用于校准完整十二项模型、风险阈值或个人仓位。低分不保证未来回撤更小。</p>
    <div class="validation-table-wrap" tabindex="0" aria-label="历史诊断总体统计，可横向滚动"><table class="validation-table"><caption>同一批可评分样本的后续表现 · 描述统计</caption><thead><tr><th scope="col">后续交易日</th>${columns}</tr></thead><tbody>${history.horizons.map((row) => `<tr><th scope="row">${row.tradingDays} 日</th>${historyStatsCells(row.baseline)}</tr>`).join("")}</tbody></table></div>
    <details class="validation-bands"><summary>按风险分档查看描述统计</summary>${history.horizons.map((row) => `<div class="validation-table-wrap" tabindex="0" aria-label="后续 ${row.tradingDays} 交易日分档统计，可横向滚动"><table class="validation-table"><caption>后续 ${row.tradingDays} 交易日 · 无样本的分档显示 —</caption><thead><tr><th scope="col">风险分档</th>${columns}</tr></thead><tbody>${row.bands.map((band) => `<tr><th scope="row">${escapeHtml(band.label)}</th>${historyStatsCells(band)}</tr>`).join("")}</tbody></table></div>`).join("")}</details>
    <ul class="validation-limitations">${history.limitations.map((text) => `<li>${escapeHtml(text)}</li>`).join("")}</ul><p><a href="/model-validation.json">查看历史诊断汇总数据</a> · <a href="https://github.com/closedoor/kk-us-equity-radar/blob/main/reports/history-validation-2019-2025.json" target="_blank" rel="noreferrer">查看完整历史检验记录</a></p>`;
}

function renderForwardReport(data) {
  const benchmarkError = data.benchmark?.error;
  const pending = data.outcomes.some((row) => row.immatureSamples > 0);
  const unavailable = data.outcomes.some((row) => row.unavailableScoreSamples > 0);
  const noMature = data.outcomes.every((row) => row.samples === 0);
  const caution = data.observedSamples === 0
    ? "尚未积累前瞻观察样本，未来的可评分记录需等待结果成熟；这不表示收益或回撤为 0。"
    : pending ? "尚有样本等待对应期限的价格观察成熟；这不表示收益或回撤为 0。"
      : noMature && unavailable ? "当前没有可计算的成熟样本；无有效评分的记录不会因继续等待而自动纳入。这不表示收益或回撤为 0。"
        : noMature ? "当前没有可计算的成熟样本，结果状态仍待核对；这不表示收益或回撤为 0。"
          : "已成熟样本仅用于描述性观察，尚不能据此校准模型或仓位。";
  els.forwardValidation.innerHTML = `<h3>前瞻记录：${benchmarkError ? "基准价格待核验" : data.status === "awaiting-outcomes" ? "等待结果成熟" : "描述性观察"}</h3>
    <p>已记录 <strong>${data.observedSamples}</strong> 个观察样本${data.observedSamples && data.firstObservationDate && data.lastObservationDate ? ` · ${escapeHtml(data.firstObservationDate)} 至 ${escapeHtml(data.lastObservationDate)}` : ""}。</p>
    ${benchmarkError ? `<p class="validation-caution">基准价格暂不可用，结果计数待核验；不将本次计数作为正常成熟进度或零收益。${escapeHtml(benchmarkError)}</p>` : `<ul class="validation-outcomes">${data.outcomes.map((row) => {
      const excluded = row.unavailableScoreSamples || 0;
      const unknown = data.observedSamples - row.samples - row.immatureSamples - excluded;
      return `<li><strong>后续 ${row.tradingDays} 交易日</strong><span>${row.samples} 个已成熟 · ${row.immatureSamples} 个等待观察${excluded ? ` · ${excluded} 个无有效评分，不纳入` : ""}${unknown ? ` · ${unknown} 个结果状态待核对` : ""}</span></li>`;
    }).join("")}</ul><p class="validation-caution">${caution}</p>`}
    <ul class="validation-limitations">${data.limitations.map((text) => `<li>${escapeHtml(text)}</li>`).join("")}</ul><p class="validation-note">${data.generatedAt ? `记录生成 ${escapeHtml(data.generatedAt.slice(0, 10))}` : "尚无前瞻记录生成时间"} · <a href="/forward-validation.json">查看前瞻汇总数据</a> · <a href="https://github.com/closedoor/kk-us-equity-radar/tree/main/evidence/forward" target="_blank" rel="noreferrer">查看完整前瞻记录</a></p>`;
}

async function loadValidationReport(url, target, validate, renderReport, label) {
  if (!target) return;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 6000);
  try {
    const response = await fetch(url, { signal: controller.signal, cache: "no-store" });
    if (!response.ok) throw new Error("report unavailable");
    const data = await response.json();
    if (!validate(data)) throw new Error("invalid report");
    renderReport(data);
    target.dataset.state = "available";
  } catch {
    target.dataset.state = "unavailable";
    target.textContent = `${label}资料待核验：暂时无法读取或格式异常。行情和评分仍独立展示。`;
  } finally {
    clearTimeout(timer);
    controller.abort();
  }
}

let validationLoad = null;
function loadValidationReports() {
  if (validationLoad) return validationLoad;
  validationLoad = Promise.allSettled([
    loadValidationReport("/model-validation.json", els.modelHistory, validHistoryReport, renderHistoryReport, "历史检验"),
    loadValidationReport("/forward-validation.json", els.forwardValidation, validForwardReport, renderForwardReport, "前瞻记录"),
  ]).finally(() => { validationLoad = null; });
  return validationLoad;
}

function renderInitialState() {
  const failed = Boolean(state.loadError);
  els.verdict.textContent = failed ? "连接失败" : "正在同步数据";
  els.verdictDescription.textContent = failed ? "暂时无法读取数据，请稍后重试。" : "正在同步首批数据，完成后自动显示。";
  els.scoreGauge.setAttribute("aria-label", "综合结构风险分暂不可用");
  els.gauge.style.visibility = "hidden";
  els.marker.hidden = true;
  els.actionLabel.textContent = "等待有效数据";
  els.actionDetail.textContent = els.verdictDescription.textContent;
  els.calendarSyncStatus.textContent = failed ? "日程尚未同步" : "正在核对日程";
}

let activeLoad = null;
let retryTimer = null;
let pollAttempts = 0;
let failureAttempts = 0;

function scheduleRetry(delay) {
  clearTimeout(retryTimer);
  retryTimer = setTimeout(() => {
    retryTimer = null;
    if (document.visibilityState === "visible" && navigator.onLine !== false) loadData();
  }, delay);
}

function loadData(force = false) {
  if (activeLoad) return activeLoad;
  const refreshHadFocus = document.activeElement === els.refresh;
  clearTimeout(retryTimer);
  retryTimer = null;
  activeLoad = (async () => {
    let retryDelay = null;
    els.refresh.classList.add("loading");
    els.refresh.disabled = true;
    els.refresh.setAttribute("aria-busy", "true");
    setLiveStatus(force ? "正在抓取最新数据" : "正在更新数据");
    try {
      const { payload, warming } = await requestDashboard(`/api/dashboard${force ? "?refresh=1" : ""}`);
      state.loadError = null;
      state.syncPending = warming || Boolean(payload.refreshing);
      failureAttempts = 0;
      if (warming) {
        if (state.data) render();
        else {
          renderInitialState();
          setLiveStatus("正在同步首批数据");
          renderErrors();
        }
      } else {
        state.data = payload;
        state.lastLoadedAt = Date.now();
        els.loading.hidden = true;
        els.loading.replaceChildren();
        render();
      }
      if (state.syncPending) retryDelay = [2500, 5000, 10000, 15000][Math.min(pollAttempts++, 3)];
      else pollAttempts = 0;
    } catch (error) {
      state.loadError = error.message;
      if (state.data) render();
      else renderInitialState();
      setLiveStatus(navigator.onLine === false ? "网络已断开" : "连接失败", "error");
      els.loading.hidden = true;
      els.loading.replaceChildren();
      renderErrors();
      retryDelay = [15000, 30000, 60000][Math.min(failureAttempts++, 2)];
    } finally {
      els.refresh.classList.remove("loading");
      els.refresh.disabled = false;
      els.refresh.removeAttribute("aria-busy");
      if (refreshHadFocus && document.activeElement === document.body) els.refresh.focus({ preventScroll: true });
      activeLoad = null;
      if (retryDelay !== null) scheduleRetry(retryDelay);
    }
  })();
  loadValidationReports();
  return activeLoad;
}

function buildManualFields(focusId = null) {
  els.manualFields.innerHTML = "";
  for (const config of manualConfig) {
    const fragment = document.querySelector("#manualFieldTemplate").content.cloneNode(true);
    const field = fragment.querySelector(".manual-field");
    const risk = fragment.querySelector(".manual-risk");
    const note = fragment.querySelector(".manual-note");
    field.dataset.id = config.id;
    fragment.querySelector(".manual-label").textContent = config.label;
    fragment.querySelector(".manual-help").textContent = config.help;
    risk.setAttribute("aria-label", `${config.label}风险值`);
    note.setAttribute("aria-label", `${config.label}备注`);
    risk.value = state.overrides[config.id]?.risk ?? "";
    note.value = state.overrides[config.id]?.note ?? "";
    const override = state.overrides[config.id];
    const review = manualReviewInfo(override);
    fragment.querySelector(".manual-reviewed-at").textContent = !override ? "尚未录入" : review.unknownDate ? "确认日期未知" : `上次确认 ${dateInTimeZone(new Date(override.updatedAt), Intl.DateTimeFormat().resolvedOptions().timeZone)} · ${review.ageDays} 天前`;
    fragment.querySelector(".manual-reconfirm").hidden = !override;
    fragment.querySelector(".manual-reconfirm-input").setAttribute("aria-label", `重新确认${config.label}仍有效`);
    if (focusId === config.id) field.dataset.focus = "true";
    els.manualFields.append(fragment);
  }
}

let manualReturnFocus = null;

function openManual(focusId = null) {
  manualReturnFocus = document.activeElement;
  manualDraft = { ...state.overrides };
  buildManualFields(focusId);
  els.manualDialog.showModal();
  if (focusId) setTimeout(() => els.manualFields.querySelector(`[data-id="${focusId}"] .manual-risk`)?.focus(), 50);
}

els.refresh.addEventListener("click", () => {
  loadData(true);
  loadMarketPulse();
});
els.pulseRefresh?.addEventListener("click", () => loadMarketPulse());
els.manualButton.addEventListener("click", () => openManual());
els.reviewManual.addEventListener("click", () => openManual(manualConfig.find(({ id }) => state.overrides[id] && manualReviewInfo(state.overrides[id]).needsReview)?.id));
els.closeManual.addEventListener("click", () => els.manualDialog.close());
els.manualDialog.addEventListener("close", () => {
  // Native close events are queued: an earlier one can arrive after a rapid
  // reopen. Leave the current dialog session and its return target intact.
  if (els.manualDialog.open || !manualReturnFocus) return;
  const key = manualReturnFocus?.dataset.focusKey;
  const target = key ? document.querySelector(`[data-focus-key="${CSS.escape(key)}"]`) : manualReturnFocus;
  if (target?.isConnected && target.getClientRects().length) target.focus({ preventScroll: true });
  else els.manualButton.focus({ preventScroll: true });
  manualReturnFocus = null;
});
els.filters.addEventListener("click", (event) => {
  const button = event.target.closest("button[data-filter]");
  if (!button) return;
  state.filter = button.dataset.filter;
  els.filters.querySelectorAll("button").forEach((item) => {
    const active = item === button;
    item.classList.toggle("active", active);
    item.setAttribute("aria-pressed", String(active));
  });
  render();
});
els.grid.addEventListener("click", (event) => {
  const button = event.target.closest("[data-manual-id]");
  if (button) openManual(button.dataset.manualId);
});
els.drivers.addEventListener("click", (event) => {
  const button = event.target.closest("[data-driver-id]");
  if (!button) return;
  state.filter = button.dataset.driverCategory;
  els.filters.querySelectorAll("button").forEach((item) => {
    const active = item.dataset.filter === state.filter;
    item.classList.toggle("active", active);
    item.setAttribute("aria-pressed", String(active));
  });
  render();
  requestAnimationFrame(() => {
    const signal = document.getElementById(`indicator-${button.dataset.driverId}`);
    if (!signal) return;
    if (event.detail === 0) signal?.focus({ preventScroll: true });
    const headerHeight = document.querySelector(".topbar").getBoundingClientRect().height;
    window.scrollTo({ top: window.scrollY + signal.getBoundingClientRect().top - headerHeight - 16, behavior: matchMedia("(prefers-reduced-motion: reduce)").matches ? "instant" : "smooth" });
  });
});
els.manualForm.addEventListener("submit", (event) => {
  event.preventDefault();
  if (!els.manualForm.reportValidity()) return;
  const fields = Array.from(els.manualFields.querySelectorAll(".manual-field"), (field) => ({
    id: field.dataset.id,
    riskText: field.querySelector(".manual-risk").value.trim(),
    note: field.querySelector(".manual-note").value.trim(),
    reconfirmed: field.querySelector(".manual-reconfirm-input").checked,
  }));
  // Read again at submit time: another tab's storage event may still be queued.
  // The helper also preserves this page's changes from failed storage writes.
  const persisted = loadOverrides();
  state.overrides = mergeManualOverrides({ current: state.overrides, draft: manualDraft, fields, persisted, lastPersisted: lastPersistedOverrides });
  if (persisted !== undefined) lastPersistedOverrides = persisted;
  const saved = saveOverrides();
  els.manualDialog.close();
  render();
  showStorageResult(saved);
});
els.clearManual.addEventListener("click", () => {
  state.overrides = {};
  manualDraft = {};
  showStorageResult(saveOverrides(), true);
  buildManualFields();
  render();
});

function refreshAfterInactivity() {
  if (document.visibilityState !== "visible") return;
  revalidateDisplay();
  if (activeLoad || navigator.onLine === false) return;
  const inactiveFor = Date.now() - state.lastLoadedAt;
  if (!state.lastLoadedAt || state.loadError || state.syncPending || state.data?.stale || crossedMarketDay() || inactiveFor >= 15 * 60 * 1000) loadData();
}

function crossedMarketDay() {
  return state.lastLoadedAt && dateInTimeZone(new Date(state.lastLoadedAt)) !== dateInTimeZone();
}

function revalidateDisplay() {
  if (state.data && state.displayValidity !== `${dateInTimeZone()}:${cacheExpired(state.data)}`) render();
}

document.addEventListener("visibilitychange", () => {
  refreshAfterInactivity();
  if (document.visibilityState !== "visible") return;
  renderMarketPulse();
  if (!pulseState.snapshot || pulseState.error || (pulseState.snapshot.mode !== "reference" && Date.now() - pulseState.lastAttemptAt >= PULSE_INTERVAL_MS)) loadMarketPulse();
});
window.addEventListener("online", () => {
  refreshAfterInactivity();
  if (document.visibilityState === "visible") loadMarketPulse();
});
window.addEventListener("offline", () => {
  const pulseRequest = pulseState.controller;
  pulseState.controller = null;
  pulseRequest?.abort();
  pulseState.error = "网络已断开。";
  renderMarketPulse();
  state.loadError = "网络已断开";
  render();
  if (!state.data) {
    renderInitialState();
    setLiveStatus("网络已断开", "error");
  }
  renderErrors();
});
window.addEventListener("storage", (event) => {
  if ((event.key !== null && event.key !== "bearRadarOverrides") || event.storageArea !== localStorage) return;
  const persisted = loadOverrides();
  if (persisted === undefined) return;
  state.overrides = mergeManualOverrides({ current: state.overrides, draft: state.overrides, fields: [], persisted, lastPersisted: lastPersistedOverrides });
  lastPersistedOverrides = persisted;
  const synchronized = manualConfig.every(({ id }) => {
    const current = state.overrides[id];
    const saved = persisted[id];
    return current === saved || (current && saved && current.risk === saved.risk && current.note === saved.note && current.updatedAt === saved.updatedAt);
  });
  if (synchronized) showStorageResult(true);
  render();
});

setInterval(() => {
  revalidateDisplay();
  if (document.visibilityState === "visible") renderMarketPulse();
  if (crossedMarketDay()) refreshAfterInactivity();
}, 60_000);

trackTopbarHeight();
loadData();
loadMarketPulse();
setInterval(() => {
  if (document.visibilityState === "visible" && navigator.onLine !== false && pulseState.snapshot?.mode !== "reference" && Date.now() - pulseState.lastAttemptAt >= PULSE_INTERVAL_MS) loadMarketPulse();
}, PULSE_INTERVAL_MS);
setInterval(() => {
  if (document.visibilityState === "visible" && navigator.onLine !== false) loadData();
}, 15 * 60 * 1000);
