import { EQUITY_OPEN_MINUTE, equityCloseMinute, matchesEquitySession, previousEquitySession } from "./us-equity-session.js";

const MINUTE = 60_000;
const SYMBOLS = new Set(["SPX", "VIX", "VXSMH", "SMH", "QQQ", "RSP"]);
const SESSIONS = new Set(["regular", "close", "unconfirmed"]);
const MODES = new Set(["reference", "feed"]);
const nyClock = new Intl.DateTimeFormat("en-US", {
  timeZone: "America/New_York", year: "numeric", month: "2-digit", day: "2-digit",
  hourCycle: "h23", hour: "2-digit", minute: "2-digit", second: "2-digit",
});

export const MARKET_PULSE_THRESHOLDS = Object.freeze({
  broadSevere: Object.freeze({ SPX: -3, RSP: -2 }),
  broadPressure: Object.freeze({ SPX: -2, RSP: -1.5 }),
  sectorSevere: Object.freeze({ SMH: -5, QQQ: -4 }),
  sectorPressure: Object.freeze({ SMH: -3, QQQ: -2.5 }),
  regularMaxAgeMinutes: 45,
  regularMaxSkewMinutes: 30,
  closeMaxSkewMinutes: 15,
});
const RULE_NOTE = "按经验阈值提示已观察到的下跌与波动，未经回测校准；不调整综合风险分。";

function validDate(date) {
  return typeof date === "string" && /^\d{4}-\d{2}-\d{2}$/.test(date)
    && Number.isFinite(Date.parse(date)) && new Date(date).toISOString().slice(0, 10) === date;
}

function validTime(at) {
  return typeof at === "string" && /^\d{4}-\d{2}-\d{2}T(?:[01]\d|2[0-3]):[0-5]\d:[0-5]\d(?:\.\d{1,3})?(?:Z|[+-](?:[01]\d|2[0-3]):[0-5]\d)$/.test(at)
    && validDate(at.slice(0, 10)) && Number.isFinite(Date.parse(at));
}

function localTime(time) {
  const parts = Object.fromEntries(nyClock.formatToParts(time).map(({ type, value }) => [type, value]));
  const date = `${parts.year}-${parts.month}-${parts.day}`;
  return { date, minutes: Number(parts.hour) * 60 + Number(parts.minute) + Number(parts.second) / 60 };
}

function validSource(source) {
  if (typeof source !== "string") return false;
  try {
    const url = new URL(source);
    return url.protocol === "https:" && !url.username && !url.password;
  } catch { return false; }
}

export function isMarketPulseSnapshot(snapshot) {
  if (!snapshot || typeof snapshot !== "object" || Array.isArray(snapshot)
    || !Array.isArray(snapshot.quotes) || !Array.isArray(snapshot.errors)
    || !snapshot.errors.every((error) => typeof error === "string")
    || (snapshot.mode !== undefined && !MODES.has(snapshot.mode))
    || (snapshot.checkedAt === null ? snapshot.quotes.length !== 0 : !validTime(snapshot.checkedAt))) return false;
  const seen = new Set();
  for (const quote of snapshot.quotes) {
    if (!quote || typeof quote !== "object" || !SYMBOLS.has(quote.symbol) || seen.has(quote.symbol)
      || !SESSIONS.has(quote.session) || !validSource(quote.source)
      || (quote.changePercent !== null && (!Number.isFinite(quote.changePercent) || quote.changePercent <= -100))) return false;
    const unconfirmed = quote.session === "unconfirmed";
    if ((!unconfirmed || quote.value !== null) && (!Number.isFinite(quote.value) || quote.value <= 0)) return false;
    if ((!unconfirmed || quote.date !== null) && !validDate(quote.date)) return false;
    if ((!unconfirmed || quote.at !== null) && !validTime(quote.at)) return false;
    if (quote.at !== null && quote.date !== null && localTime(Date.parse(quote.at)).date !== quote.date) return false;
    seen.add(quote.symbol);
  }
  return true;
}

function aligned(left, right) {
  if (!left || !right || left.date !== right.date || left.session !== right.session) return false;
  const maxSkew = left.session === "close" ? MARKET_PULSE_THRESHOLDS.closeMaxSkewMinutes : MARKET_PULSE_THRESHOLDS.regularMaxSkewMinutes;
  return Math.abs(Date.parse(left.at) - Date.parse(right.at)) <= maxSkew * MINUTE;
}

const hasChange = (quote) => Number.isFinite(quote?.changePercent);
const pct = (value) => `${value > 0 ? "+" : ""}${value.toFixed(2)}%`;
const prefixFor = (status) => status === "last-close" ? "上次收盘：" : "";

function broadStatus(quotes, status) {
  const spx = quotes.find((row) => row.symbol === "SPX");
  const rsp = quotes.find((row) => row.symbol === "RSP");
  const prefix = prefixFor(status);
  if (!hasChange(spx) || !hasChange(rsp) || !aligned(spx, rsp)) {
    const spxDecline = hasChange(spx) && spx.changePercent <= MARKET_PULSE_THRESHOLDS.broadPressure.SPX;
    return { level: "unconfirmed", label: spxDecline ? `${prefix}标普下跌 · 扩散待确认` : "大盘扩散待核对",
      detail: spxDecline ? `SPX ${pct(spx.changePercent)}；没有可比较的同日、同时段等权报价。` : "需核对同一纽约日期和时段的 SPX 与 RSP 涨跌幅。",
      date: spx?.date ?? rsp?.date ?? null, session: spx?.session ?? rsp?.session ?? null };
  }
  const severe = spx.changePercent <= MARKET_PULSE_THRESHOLDS.broadSevere.SPX && rsp.changePercent <= MARKET_PULSE_THRESHOLDS.broadSevere.RSP;
  const pressure = spx.changePercent <= MARKET_PULSE_THRESHOLDS.broadPressure.SPX && rsp.changePercent <= MARKET_PULSE_THRESHOLDS.broadPressure.RSP;
  const concentrated = spx.changePercent <= MARKET_PULSE_THRESHOLDS.broadPressure.SPX && !pressure;
  const label = severe ? "大盘急跌 · 等权同步下跌" : pressure ? "大盘共同承压" : concentrated ? "标普下跌 · 未确认广泛扩散" : "未触发大盘共同下跌阈值";
  return { level: severe ? "severe" : pressure ? "pressure" : "none", label: `${prefix}${label}`,
    detail: `SPX ${pct(spx.changePercent)} · RSP ${pct(rsp.changePercent)}。RSP 跟踪标普 500 等权指数。`, date: spx.date, session: spx.session };
}

function sectorStatus(quotes, status) {
  const flags = [];
  let checked = 0;
  for (const symbol of ["SMH", "QQQ"]) {
    const row = quotes.find((quote) => quote.symbol === symbol);
    if (!hasChange(row)) continue;
    checked += 1;
    const severe = row.changePercent <= MARKET_PULSE_THRESHOLDS.sectorSevere[symbol];
    if (severe || row.changePercent <= MARKET_PULSE_THRESHOLDS.sectorPressure[symbol]) {
      const name = symbol === "SMH" ? "半导体" : "纳指成长";
      flags.push({ symbol, level: severe ? "severe" : "pressure", label: `${name}${severe ? "急跌" : "承压"} ${pct(row.changePercent)}`, date: row.date, session: row.session });
    }
  }
  const vxsmh = quotes.find((row) => row.symbol === "VXSMH");
  if (vxsmh) {
    if (vxsmh.value >= 45 || vxsmh.value < 35 || hasChange(vxsmh)) checked += 1;
    if (vxsmh.value >= 45 || (vxsmh.value >= 35 && hasChange(vxsmh) && vxsmh.changePercent >= 20)) {
      flags.push({ symbol: "VXSMH", level: vxsmh.value >= 45 ? "severe" : "pressure", label: `半导体隐含波动升高 ${vxsmh.value.toFixed(2)}`, date: vxsmh.date, session: vxsmh.session });
    }
  }
  // Each alert concerns one independently usable instrument. A no-alert
  // summary of all three, however, needs a comparable set of observations.
  const sectorRows = quotes.filter((row) => ["SMH", "QQQ", "VXSMH"].includes(row.symbol));
  const complete = checked === 3 && sectorRows.every((row) => sectorRows.every((other) => aligned(row, other)));
  const level = flags.some((flag) => flag.level === "severe") ? "severe" : flags.length ? "pressure" : complete ? "none" : "unconfirmed";
  const label = flags.length ? `${prefixFor(status)}行业与成长压力` : complete ? `${prefixFor(status)}未触发行业压力阈值` : "行业压力待核对";
  const detail = flags.length ? flags.map((flag) => flag.label).join(" · ") : complete ? "SMH、QQQ 与 VXSMH 均有可比较数据。" : "行业报价不齐或时点不一致，暂不能确认整体压力。";
  return { level, label, detail, flags };
}

function volatilityStatus(quotes, status) {
  const vix = quotes.find((row) => row.symbol === "VIX");
  if (!vix) return { level: "unconfirmed", label: "波动待核对", detail: "暂无可确认的 VIX 报价。" };
  const elevated = vix.value >= 30 || (vix.value >= 25 && hasChange(vix) && vix.changePercent >= 20);
  const watch = vix.value >= 25;
  return { level: elevated ? "elevated" : watch ? "watch" : "none",
    label: `${prefixFor(status)}${elevated ? "隐含波动明显升高" : watch ? "隐含波动偏高" : "VIX 未触发波动阈值"}`,
    detail: `VIX ${vix.value.toFixed(2)}${hasChange(vix) ? ` · 较前收 ${pct(vix.changePercent)}` : " · 涨跌幅待核对"}。波动单列，不用于判定下跌广度。` };
}

export function projectMarketPulse(snapshot, now = Date.now()) {
  const clock = typeof now === "number" ? now : now instanceof Date ? now.getTime() : typeof now === "string" ? Date.parse(now) : NaN;
  const nowValid = Number.isFinite(clock) && Number.isFinite(new Date(clock).getTime());
  const today = nowValid ? localTime(clock) : null;
  const schemaValid = isMarketPulseSnapshot(snapshot);
  const mode = schemaValid ? snapshot.mode ?? null : null;
  const timeValid = nowValid && schemaValid && (snapshot.checkedAt === null || Date.parse(snapshot.checkedAt) <= clock);
  const raw = schemaValid ? snapshot.quotes : [];
  const checked = Date.parse(snapshot?.checkedAt);
  const todayClose = today && equityCloseMinute(today.date);
  const prior = today && previousEquitySession(today.date);
  const beforeNextSession = today && todayClose !== null && (todayClose === 0 || today.minutes < EQUITY_OPEN_MINUTE);
  const canUseIntraday = today && matchesEquitySession(today.date, today.minutes, "regular");
  const equityCloseToday = timeValid && raw.some((row) => ["SPX", "RSP", "SMH", "QQQ"].includes(row.symbol)
    && row.session === "close" && row.date === today.date && Date.parse(row.at) <= checked
    && matchesEquitySession(row.date, localTime(Date.parse(row.at)).minutes, "close"));
  const quotes = raw.map((quote) => {
    const timestamp = Date.parse(quote.at);
    if (!timeValid || quote.session === "unconfirmed" || timestamp > checked) return { ...quote, state: "unconfirmed" };
    const observed = localTime(timestamp);
    if (!matchesEquitySession(observed.date, observed.minutes, quote.session)) return { ...quote, state: "unconfirmed" };
    if (quote.date === today.date && (quote.session === "close" || (mode !== "reference" && !equityCloseToday && canUseIntraday
      && clock - timestamp <= MARKET_PULSE_THRESHOLDS.regularMaxAgeMinutes * MINUTE))) return { ...quote, state: "current" };
    if (quote.session === "close" && quote.date === prior && beforeNextSession) return { ...quote, state: "last-close" };
    return { ...quote, state: "stale" };
  });
  const current = quotes.filter((row) => row.state === "current");
  const priorClose = quotes.filter((row) => row.state === "last-close");
  const status = current.length ? "current" : priorClose.length ? "last-close" : quotes.some((row) => row.state === "stale") ? "stale" : "unavailable";
  const usable = current.length ? current : priorClose;
  const anchor = usable.find((row) => row.symbol === "SPX") || usable.find((row) => row.symbol === "RSP") || usable[0];
  const label = status === "current" ? anchor.session === "close" ? mode === "reference" ? "当日收盘参考" : "当日收盘段行情" : "常规交易时段报价"
    : status === "last-close" ? "最近核实收盘 · 非当前盘中" : status === "stale" ? mode === "reference" ? "历史参考报价 · 今日缺数" : "当前时段报价待更新" : "行情待核对";
  const errors = schemaValid ? [...snapshot.errors] : snapshot == null ? [] : ["行情响应格式异常"];
  if (today && todayClose === null) errors.push("纽约交易日历未覆盖此日期，当日判断暂停");
  if (schemaValid && nowValid && !timeValid) errors.push("行情核对时间在未来");
  return { status, label, mode, today: today?.date ?? null,
    date: anchor?.date ?? quotes.map((row) => row.date).filter((date) => date && today && date <= today.date).sort().at(-1) ?? null,
    session: anchor?.session ?? null, checkedAt: schemaValid ? snapshot.checkedAt : null, errors, quotes,
    broad: broadStatus(usable, status), sector: sectorStatus(usable, status), volatility: volatilityStatus(usable, status), ruleNote: RULE_NOTE };
}
