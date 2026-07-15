const state = {
  data: null,
  filter: "全部",
  overrides: loadOverrides(),
};

const els = {
  score: document.querySelector("#scoreValue"),
  gauge: document.querySelector("#gaugeProgress"),
  marker: document.querySelector("#bandMarker"),
  verdict: document.querySelector("#verdictLabel"),
  verdictDescription: document.querySelector("#verdictDescription"),
  verdictDot: document.querySelector("#verdictDot"),
  coverage: document.querySelector("#coverageValue"),
  updated: document.querySelector("#updatedValue"),
  scoreDelta: document.querySelector("#scoreDelta"),
  baseScore: document.querySelector("#baseScoreValue"),
  heat: document.querySelector("#heatValue"),
  recession: document.querySelector("#recessionValue"),
  uplift: document.querySelector("#upliftValue"),
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
  actionLabel: document.querySelector("#actionLabel"),
  actionDetail: document.querySelector("#actionDetail"),
  actionCallout: document.querySelector("#actionCallout"),
  aiChainMap: document.querySelector("#aiChainMap"),
  aiCompanyGrid: document.querySelector("#aiCompanyGrid"),
  reminderGrid: document.querySelector("#reminderGrid"),
};

const manualConfig = [
  { id: "aiEarnings", label: "AI 产业链财报风险", help: "当云资本开支、芯片指引或库存出现新变化时，可调整风险值。" },
  { id: "earningsBreadth", label: "标普盈利下调广度", help: "用未来 12 个月 EPS 修正广度替换企业利润周期代理。" },
];

function loadOverrides() {
  try { return JSON.parse(localStorage.getItem("bearRadarOverrides") || "{}"); }
  catch { return {}; }
}

function saveOverrides() {
  localStorage.setItem("bearRadarOverrides", JSON.stringify(state.overrides));
}

function clamp(value, min = 0, max = 100) {
  return Math.min(max, Math.max(min, value));
}

function riskMeta(score) {
  if (score > 75) return { label: "红色警报", color: "#cc3a2d", description: "系统性回撤风险已经很高，优先检查流动性、信用事件和盈利下修。" };
  if (score > 60) return { label: "橙色警报", color: "#e46e31", description: "综合市场风险明显上升，信用、盈利与价格趋势需要逐项核查。" };
  if (score > 40) return { label: "黄色警戒", color: "#d8a232", description: "市场开始脆弱，宏观、信用或盈利压力正在形成共振。" };
  if (score > 20) return { label: "正常波动", color: "#a9a348", description: "存在局部压力，但尚未形成跨通胀、信用、盈利和价格的全面恶化。" };
  return { label: "健康、风险较低", color: "#4b9b67", description: "目前没有看到多条风险链同步恶化，但低分不代表短期不会回调。" };
}

function computeScores(indicators) {
  const available = indicators.filter((item) => item.available && Number.isFinite(item.points));
  const availableWeight = available.reduce((sum, item) => sum + item.weight, 0);
  const rawPoints = available.reduce((sum, item) => sum + item.points, 0);
  const baseScore = availableWeight ? (rawPoints / availableWeight) * 100 : 0;
  const confirmationIds = new Set(["vix", "sp500", "credit", "breadth", "earningsBreadth"]);
  const confirmationItems = available.filter((item) => confirmationIds.has(item.id));
  const confirmationWeight = confirmationItems.reduce((sum, item) => sum + item.weight, 0);
  const confirmationPoints = confirmationItems.reduce((sum, item) => sum + item.points, 0);
  const subset = (ids) => {
    const items = available.filter((item) => ids.includes(item.id));
    const weight = items.reduce((sum, item) => sum + item.weight, 0);
    return weight ? (items.reduce((sum, item) => sum + item.points, 0) / weight) * 100 : null;
  };
  const stagflationScore = subset(["oil", "inflation", "fed", "rates"]);
  const recessionScore = subset(["unemployment", "payrolls", "credit", "earningsBreadth"]);
  const marketBreakScore = subset(["vix", "breadth", "sp500"]);
  const dominantRegimeScore = Math.max(...[stagflationScore, recessionScore, marketBreakScore].filter(Number.isFinite));
  const stagflationHighCount = indicators.filter((item) => ["oil", "inflation", "fed", "rates"].includes(item.id) && Number(item.risk) >= 60).length;
  const macroSynergyUplift = stagflationHighCount >= 4 ? 10 : stagflationHighCount >= 3 ? 7 : 0;
  const breadthRisk = indicators.find((item) => item.id === "breadth")?.risk;
  const spRisk = indicators.find((item) => item.id === "sp500")?.risk;
  const fragileHighUplift = Number(spRisk) >= 12 && Number(spRisk) <= 25 && Number(breadthRisk) >= 20 ? 4 : 0;
  const riskUplift = macroSynergyUplift + fragileHighUplift;
  const score = Number.isFinite(dominantRegimeScore) ? clamp(baseScore * 0.70 + dominantRegimeScore * 0.30 + riskUplift) : baseScore;
  return {
    available,
    availableWeight,
    rawPoints,
    baseScore,
    score,
    stagflationScore,
    recessionScore,
    marketBreakScore,
    dominantRegimeScore,
    riskUplift,
    confirmationScore: confirmationWeight ? (confirmationPoints / confirmationWeight) * 100 : 0,
  };
}

function actionFor(score) {
  if (score <= 20) return { key: "add", label: "风险较低：可考虑分批增加风险敞口", detail: "适合按既定资产配置逐步投入，不代表短期不会回调。" };
  if (score <= 40) return { key: "hold", label: "正常波动：以持有和再平衡为主", detail: "不追涨，也不因单项噪声急于减仓，等待风险是否跨指标扩散。" };
  if (score <= 60) return { key: "caution", label: "黄色警戒：保持仓位，暂停加仓", detail: "当前不支持全面卖出；保留现金，优先降低高估值、高波动或带杠杆仓位，等待信用、盈利或市场宽度改善。" };
  if (score <= 75) return { key: "reduce", label: "橙色警报：考虑降低高波动仓位", detail: "风险链已明显共振，重点控制回撤、杠杆与流动性。" };
  return { key: "defend", label: "红色警报：优先防守与控制回撤", detail: "系统性风险较高，应优先处理杠杆和流动性暴露。" };
}

function applyOverrides(data) {
  const indicators = data.indicators.map((item) => {
    const override = state.overrides[item.id];
    if (!override || !Number.isFinite(Number(override.risk))) return { ...item };
    const risk = clamp(Number(override.risk));
    return {
      ...item,
      risk,
      points: Math.round((risk / 100) * item.weight * 100) / 100,
      value: `${risk}/100`,
      detail: override.note || "人工风险判断",
      date: new Date().toISOString().slice(0, 10),
      status: risk >= 80 ? "critical" : risk >= 55 ? "high" : risk >= 30 ? "watch" : "low",
      confidence: "manual",
      available: true,
      overridden: true,
    };
  });
  const model = computeScores(indicators);
  const categories = data.categories.map((category) => {
    const items = model.available.filter((item) => item.category === category.name);
    const weight = items.reduce((sum, item) => sum + item.weight, 0);
    const points = items.reduce((sum, item) => sum + item.points, 0);
    return { ...category, weight, score: weight ? (points / weight) * 100 : null };
  });
  return { ...data, indicators, ...model, coverage: model.availableWeight, categories, heatScore: model.stagflationScore, action: actionFor(model.score) };
}

function formatDate(date) {
  if (!date) return "--";
  return new Intl.DateTimeFormat("zh-CN", { month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", hour12: false }).format(new Date(date));
}

function scoreColor(score) {
  return riskMeta(score).color;
}

function renderSummary(data) {
  const score = Math.round(data.score * 10) / 10;
  const meta = riskMeta(score);
  const circumference = 2 * Math.PI * 103;
  els.score.textContent = score.toFixed(1);
  els.gauge.style.strokeDasharray = `${circumference}`;
  els.gauge.style.strokeDashoffset = `${circumference * (1 - score / 100)}`;
  els.gauge.style.stroke = meta.color;
  els.marker.style.left = `calc(${clamp(score)}% - 1px)`;
  els.verdict.textContent = meta.label;
  els.verdictDescription.textContent = Number(data.stagflationScore) === Number(data.dominantRegimeScore)
    ? "滞胀与政策约束正在形成共振，但信用和就业尚未确认系统性危机。"
    : meta.description;
  els.verdictDot.style.background = meta.color;
  els.coverage.textContent = `${data.coverage}%`;
  els.updated.textContent = formatDate(data.generatedAt);
  els.scoreDelta.textContent = `12 项权重合计 100%`;
  els.baseScore.textContent = Number.isFinite(data.baseScore) ? data.baseScore.toFixed(1) : "--";
  els.heat.textContent = Number.isFinite(data.heatScore) ? data.heatScore.toFixed(1) : "--";
  els.recession.textContent = Number.isFinite(data.recessionScore) ? data.recessionScore.toFixed(1) : "--";
  els.uplift.textContent = Number.isFinite(data.riskUplift) ? `+${data.riskUplift.toFixed(0)}` : "--";
  els.liveText.textContent = data.cache ? "已连接 · 缓存数据" : "已连接 · 最新数据";
  els.actionLabel.textContent = data.action?.label || "等待数据";
  els.actionDetail.textContent = data.action?.detail || "";
  els.actionCallout.dataset.action = data.action?.key || "hold";
}

function renderCategories(categories) {
  els.categories.innerHTML = categories.map((category) => {
    const value = Number.isFinite(category.score) ? Math.round(category.score) : null;
    return `<article class="category-item">
      <div class="category-top"><span>${category.name}</span><strong>${value ?? "--"}</strong></div>
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
    ? `前三项共贡献 ${driverPoints.toFixed(1)} 分，占当前风险总点数的 ${share}%。点击可直接定位到信号详情。`
    : "暂无可用信号，请稍后刷新数据。";
  els.drivers.innerHTML = drivers.map((item, index) => {
    const risk = Number.isFinite(item.risk) ? Math.round(item.risk) : 0;
    return `<button class="driver-item" type="button" data-driver-id="${item.id}" data-driver-category="${item.category}">
      <span class="driver-rank">0${index + 1}</span>
      <span class="driver-copy"><small>${item.category}</small><strong>${item.title}</strong><span>${item.detail || item.description}</span></span>
      <span class="driver-score"><strong>${item.points.toFixed(1)}</strong><small>/ ${item.weight} 分</small><i><b style="width:${risk}%;background:${scoreColor(risk)}"></b></i></span>
    </button>`;
  }).join("");
}

function escapeHtml(value) {
  return String(value ?? "").replace(/[&<>"']/g, (char) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[char]);
}

function renderAiEarnings(rows = [], layers = []) {
  els.aiChainMap.innerHTML = layers.map((layer, index) => `<article class="ai-layer-card">
    <span class="ai-layer-index">0${index + 1}</span><h3>${escapeHtml(layer.name)}</h3><p>${escapeHtml(layer.description)}</p>
    <div>${layer.tickers.map((ticker) => `<b>${escapeHtml(ticker)}</b>`).join("")}</div>
  </article>`).join("");

  els.aiCompanyGrid.innerHTML = rows.map((row) => `<article class="ai-company-card">
    <div class="ai-card-head">
      <span class="ai-layer-pill">${escapeHtml(row.layer)}</span>
      <time>${escapeHtml(row.released)}</time>
    </div>
    <div class="ai-company-title"><div><h3>${escapeHtml(row.company)}</h3><span>${escapeHtml(row.ticker)} · ${escapeHtml(row.period)}</span></div><strong>${escapeHtml(row.role)}</strong></div>
    <p class="ai-impact">${escapeHtml(row.impact)}</p>
    <div class="ai-financials">
      <div><span>营收</span><strong>${escapeHtml(row.revenue)}</strong></div>
      <div><span>净利润</span><strong>${escapeHtml(row.netIncome)}</strong></div>
      <div><span>毛利率</span><strong>${escapeHtml(row.grossMargin)}</strong></div>
    </div>
    <div class="ai-readout">
      <div><span>本季表现</span><p class="assessment ${escapeHtml(row.resultTone)}">${escapeHtml(row.resultAssessment)}</p></div>
      <div><span>下一期判断</span><p class="assessment ${escapeHtml(row.guidanceTone)}">${escapeHtml(row.guidanceAssessment)}</p></div>
    </div>
    <div class="ai-guidance-copy"><span>公司指引</span><p>${escapeHtml(row.guidance)}</p><small>${escapeHtml(row.note)}</small></div>
    <div class="ai-card-foot"><a href="${escapeHtml(row.source)}" target="_blank" rel="noreferrer">查看官方财报</a><span>下次财报 <strong>${escapeHtml(row.nextReportDate || row.nextReportLabel)}</strong></span></div>
  </article>`).join("");
}

function renderReminders(rows = []) {
  const today = new Date();
  const todayUtc = Date.UTC(today.getFullYear(), today.getMonth(), today.getDate());
  els.reminderGrid.innerHTML = rows.map((row, index) => {
    const dateParts = row.date?.split("-").map(Number);
    const days = dateParts?.length === 3
      ? Math.round((Date.UTC(dateParts[0], dateParts[1] - 1, dateParts[2]) - todayUtc) / 86_400_000)
      : null;
    const companyList = row.companies?.length ? `<div class="company-reminder-list">${row.companies.map((company) => `<span><b>${escapeHtml(company.ticker)}</b><em>上期 ${escapeHtml(company.released)}</em><em>下期 ${escapeHtml(company.next)}</em><i class="${company.status === "confirmed" ? "confirmed" : "estimated"}">${company.status === "confirmed" ? "已确认" : "预计窗口"}</i></span>`).join("")}</div>` : "";
    const sourceLink = !row.companies?.length && row.linkLabel ? `<a class="reminder-source" href="${escapeHtml(row.source)}" target="_blank" rel="noreferrer">${escapeHtml(row.linkLabel)} <span aria-hidden="true">↗</span></a>` : "";
    const relativeLabel = days === null ? "" : days < 0 ? "已公布" : days === 0 ? "今天" : `${days} 天后`;
    return `<article class="reminder-card${row.companies?.length ? " company-card" : ""}">
      <span class="reminder-index">${String(index + 1).padStart(2, "0")}</span><div class="reminder-copy"><small>${escapeHtml(row.label)}</small><strong>${escapeHtml(row.event)}</strong>${sourceLink}</div>
      <time>${row.date ? escapeHtml(row.date) : "逐家公司"}${relativeLabel ? `<b>${relativeLabel}</b>` : ""}</time>${companyList}
    </article>`;
  }).join("");
}

function sparklineSvg(points) {
  if (!points || points.length < 2) return `<svg class="sparkline" viewBox="0 0 170 72" aria-hidden="true"><path class="line" d="M0 36 L170 36" opacity=".15"/></svg>`;
  const values = points.map((point) => point.value);
  const min = Math.min(...values);
  const max = Math.max(...values);
  const spread = max - min || 1;
  const coords = points.map((point, index) => {
    const x = (index / (points.length - 1)) * 170;
    const y = 66 - ((point.value - min) / spread) * 56;
    return [x, y];
  });
  const line = coords.map(([x, y], index) => `${index ? "L" : "M"}${x.toFixed(1)} ${y.toFixed(1)}`).join(" ");
  const area = `${line} L170 72 L0 72 Z`;
  const last = coords.at(-1);
  return `<svg class="sparkline" viewBox="0 0 170 72" preserveAspectRatio="none" aria-hidden="true"><path class="area" d="${area}"/><path class="line" d="${line}"/><circle class="end" cx="${last[0]}" cy="${last[1]}" r="2.8"/></svg>`;
}

function confidenceLabel(value) {
  return ({ high: "高可信", proxy: "代理值", manual: "人工", medium: "中可信" })[value] || value;
}

function renderIndicators(data) {
  const filtered = data.indicators.filter((item) => state.filter === "全部" || item.category === state.filter);
  els.grid.innerHTML = filtered.map((item) => {
    const risk = Number.isFinite(item.risk) ? item.risk : null;
    const color = risk === null ? "#a1a39c" : scoreColor(risk);
    const chipText = item.overridden ? "人工覆盖" : risk === null ? "待接入" : risk >= 80 ? "严重" : risk >= 55 ? "偏高" : risk >= 30 ? "观察" : "温和";
    const index = String(data.indicators.findIndex((source) => source.id === item.id) + 1).padStart(2, "0");
    const manualCapable = manualConfig.some((config) => config.id === item.id);
    return `<article class="indicator-card" id="indicator-${item.id}" data-category="${item.category}">
      <div class="card-head">
        <div><span class="card-index">${index} · ${item.category} · 权重 ${item.weight}</span><h3 class="card-title">${item.title}</h3></div>
        <span class="risk-chip ${item.status}">${chipText}</span>
      </div>
      <div class="card-main">
        <div><div class="metric-value">${item.value}</div><div class="metric-detail">${item.detail || ""}${item.date ? ` · ${item.date}` : ""}</div></div>
        ${sparklineSvg(item.sparkline)}
      </div>
      ${item.breakdown?.length ? `<div class="metric-breakdown metric-breakdown-${Math.min(item.breakdown.length, 4)}">${item.breakdown.map((metric) => `<div><span>${escapeHtml(metric.label)}</span><strong>${escapeHtml(metric.value)}</strong><small>${escapeHtml(metric.detail)}</small></div>`).join("")}</div>` : ""}
      ${item.judgment ? `<div class="indicator-judgment ${escapeHtml(item.judgment.tone)}"><strong>${escapeHtml(item.judgment.label)}</strong><span>${escapeHtml(item.judgment.text)}</span></div>` : ""}
      <div class="score-row"><span>风险强度 ${risk === null ? "--" : Math.round(risk)}</span><div class="risk-bar"><i style="width:${risk ?? 0}%;background:${color}"></i></div><strong class="score-points">${item.points === null ? "--" : item.points.toFixed(1)} / ${item.weight}</strong></div>
      <p class="card-copy">${item.description}<br /><strong>为什么重要：</strong>${item.why}</p>
      ${manualCapable ? `<button class="manual-edit" data-manual-id="${item.id}" type="button">${item.overridden ? "修改人工数据" : "录入更准确的数据"}</button>` : ""}
      <div class="card-foot"><a class="source-link" href="${item.source.url}" target="_blank" rel="noreferrer">查看官方数据 · ${escapeHtml(item.source.label)}</a><span class="cadence">${item.cadence}<span class="confidence">${confidenceLabel(item.confidence)}</span></span></div>
    </article>`;
  }).join("");
}

function renderErrors(errors = []) {
  if (!errors.length) { els.error.hidden = true; return; }
  els.error.hidden = false;
  els.error.textContent = `部分数据源暂时不可用，页面已使用可用数据计算并降低覆盖率：${errors.join("；")}`;
}

function render() {
  if (!state.data) return;
  const data = applyOverrides(state.data);
  renderSummary(data);
  renderCategories(data.categories);
  renderDrivers(data);
  renderIndicators(data);
  renderAiEarnings(data.aiEarnings, data.aiChainLayers);
  renderReminders(data.reminders);
  renderErrors(data.errors);
}

async function loadData(force = false) {
  els.refresh.classList.add("loading");
  els.liveText.textContent = "正在更新数据";
  try {
    const response = await fetch(`/api/dashboard${force ? "?refresh=1" : ""}`);
    const payload = await response.json();
    if (response.status === 202 && payload.warming) {
      els.liveText.textContent = "正在同步首批数据";
      setTimeout(() => loadData(), 2500);
      return;
    }
    if (!response.ok) throw new Error(payload.detail || payload.error || "数据请求失败");
    state.data = payload;
    els.loading.hidden = true;
    els.loading.replaceChildren();
    render();
  } catch (error) {
    els.liveText.textContent = "连接失败";
    els.loading.hidden = true;
    els.loading.replaceChildren();
    els.error.hidden = false;
    els.error.textContent = `无法更新数据：${error.message}。请确认本地服务可以访问互联网后重试。`;
  } finally {
    els.refresh.classList.remove("loading");
  }
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
    risk.value = state.overrides[config.id]?.risk ?? "";
    note.value = state.overrides[config.id]?.note ?? "";
    if (focusId === config.id) field.dataset.focus = "true";
    els.manualFields.append(fragment);
  }
}

function openManual(focusId = null) {
  buildManualFields(focusId);
  els.manualDialog.showModal();
  if (focusId) setTimeout(() => els.manualFields.querySelector(`[data-id="${focusId}"] .manual-risk`)?.focus(), 50);
}

els.refresh.addEventListener("click", () => loadData(true));
els.manualButton.addEventListener("click", () => openManual());
els.filters.addEventListener("click", (event) => {
  const button = event.target.closest("button[data-filter]");
  if (!button) return;
  state.filter = button.dataset.filter;
  els.filters.querySelectorAll("button").forEach((item) => item.classList.toggle("active", item === button));
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
  els.filters.querySelectorAll("button").forEach((item) => item.classList.toggle("active", item.dataset.filter === state.filter));
  render();
  requestAnimationFrame(() => document.querySelector(`#indicator-${button.dataset.driverId}`)?.scrollIntoView({ behavior: "smooth", block: "center" }));
});
els.manualForm.addEventListener("submit", (event) => {
  if (event.submitter?.value === "cancel") return;
  event.preventDefault();
  const next = { ...state.overrides };
  els.manualFields.querySelectorAll(".manual-field").forEach((field) => {
    const riskText = field.querySelector(".manual-risk").value.trim();
    const note = field.querySelector(".manual-note").value.trim();
    if (riskText === "") delete next[field.dataset.id];
    else next[field.dataset.id] = { risk: clamp(Number(riskText)), note };
  });
  state.overrides = next;
  saveOverrides();
  els.manualDialog.close();
  render();
});
els.clearManual.addEventListener("click", () => {
  state.overrides = {};
  saveOverrides();
  buildManualFields();
  render();
});

loadData();
setInterval(() => loadData(), 15 * 60 * 1000);
