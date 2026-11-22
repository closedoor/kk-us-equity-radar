import { INDICATOR_WEIGHTS, MIN_SCORE_COVERAGE } from './risk-model.js';
import { equityCloseMinute, previousEquitySession, EQUITY_OPEN_MINUTE } from './us-equity-session.js';

const names = { oil: '原油', inflation: '通胀', fed: '美联储政策', rates: '美债利率', vix: 'VIX', unemployment: '失业率', payrolls: '非农就业', aiEarnings: 'AI 财报', credit: '信用利差与信贷', earningsBreadth: '盈利预期', breadth: '市场宽度', sp500: '标普 500' };
const known = id => typeof id === 'string' && Object.hasOwn(INDICATOR_WEIGHTS, id);
const day = value => typeof value === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(value) && Number.isFinite(Date.parse(value)) && new Date(value).toISOString().slice(0, 10) === value;
const numeric = (value, low, high) => Number.isFinite(value) && value >= low && value <= high;
const uniqueIds = list => Array.isArray(list) && list.length <= 12 && list.every(known) && new Set(list).size === list.length;
const nullableNum = (value, low, high) => value === null || numeric(value, low, high);
function sourceFor(row, version) {
  try {
    const u = new URL(row.sourceUrl);
    const pieces = u.pathname.split('/');
    return u.origin === 'https://github.com' && !u.username && !u.password && pieces.length === 8 && pieces.slice(1, 4).join('/') === 'closedoor/kk-us-equity-radar/blob' && /^(main|[a-f0-9]{40})$/.test(pieces[4]) && pieces.slice(5).join('/') === `evidence/forward/${row.date}_model-${version}.json` ? u.origin + u.pathname : null;
  } catch { return null; }
}
const nyTime = new Intl.DateTimeFormat('en-GB', {timeZone:'America/New_York',year:'numeric',month:'2-digit',day:'2-digit',hour:'2-digit',minute:'2-digit',hourCycle:'h23'});
function recordedTime(row) {
  const t = row.capturedAt;
  if (typeof t !== 'string' || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(t)
    || !Number.isFinite(Date.parse(t)) || new Date(t).toISOString() !== t) return null;
  const v = Object.fromEntries(nyTime.formatToParts(new Date(t)).map(({type,value})=>[type,value]));
  if ([v.year,v.month,v.day].join('-') !== row.date) return null;
  const minutes = Number(v.hour)*60 + Number(v.minute), close = equityCloseMinute(row.date);
  const phase = close === null ? null : close === 0 ? '休市日' : minutes < EQUITY_OPEN_MINUTE ? '盘前' : minutes < close ? '盘中' : '收盘后';
  return {clock:v.hour+':'+v.minute, phase};
}
export function observationTiming(row) {
  const at=recordedTime(row);
  if (!at) return null; // A pre-upgrade API did not expose sampling times or benchmark dates.
  const reference = row.referenceDate == null ? '标普基准收盘日未知。' : '标普基准收盘日：'+row.referenceDate+'。';
  return '纽约 '+at.clock+' 采集'+(at.phase?'（'+at.phase+'）':'')+'。'+reference+
    (at.phase==='盘前' || at.phase==='盘中' ? '这份快照未覆盖当日收盘。':'');
}
export function hasInterveningSession(from,to) {
  if (!day(from) || !day(to) || !equityCloseMinute(from) || !equityCloseMinute(to)) return false;
  const previous = previousEquitySession(to);
  return previous !== null && from < previous;
}
export function isScoreHistory(report) {
  if (report?.version !== 1 || typeof report.scoringVersion !== 'string' || !/^\d+\.\d+\.\d+$/.test(report.scoringVersion) || !Array.isArray(report.observations) || report.observations.length > 20) return false;
  return report.observations.every((row, index, rows) => {
    if (!row || !day(row.date) || (index && row.date >= rows[index - 1].date) || !numeric(row.coverage, 0, 100) || !nullableNum(row.baseScore, 0, 100) || !nullableNum(row.score, 0, 100) || (row.score !== null && row.coverage < MIN_SCORE_COVERAGE) || !sourceFor(row, report.scoringVersion)) return false;
    if (Object.hasOwn(row,'capturedAt') || Object.hasOwn(row,'referenceDate')) {
      if (!recordedTime(row) || !Object.hasOwn(row,'referenceDate') || !(row.referenceDate === null || (day(row.referenceDate) && row.referenceDate <= row.date))) return false;
    }
    const c = row.change, prev = rows[index + 1];
    const difference = (a, b) => a === null || b === null ? null : Math.round((a-b)*10) / 10;
    if (c && prev && (c.totalDelta !== difference(row.score, prev.score) || c.baseDelta !== difference(row.baseScore, prev.baseScore))) return false;
    if (c === null) return !prev;
    return c && day(c.previousDate) && c.previousDate < row.date && (!prev || prev.date === c.previousDate) && nullableNum(c.totalDelta, -100, 100) && (c.totalDelta === null || (row.score !== null && (!prev || prev.score !== null))) && nullableNum(c.baseDelta, -100, 100) && nullableNum(c.adjustmentDelta, -200, 200) && c.adjustmentDelta === difference(c.totalDelta, c.baseDelta)
      && uniqueIds(c.gained) && uniqueIds(c.lost) && !c.gained.some(id=>c.lost.includes(id))
      && (!prev || row.coverage - prev.coverage === c.gained.reduce((n,id)=>n+INDICATOR_WEIGHTS[id],0) - c.lost.reduce((n,id)=>n+INDICATOR_WEIGHTS[id],0))
      && Array.isArray(c.drivers) && c.drivers.length <= 12 && c.drivers.every(d => d && known(d.id) && numeric(d.deltaPoints, -100, 100));
  });
}
const el = (tag, text, cls) => { const n = document.createElement(tag); if (text != null) n.textContent = text; if (cls) n.className = cls; return n; };
const signed = (value, decimals = 1) => `${value > 0 ? '+' : ''}${value.toFixed(decimals)}`;
const pts = v => Number.isFinite(v) ? v.toFixed(1) : '未出分';
const namesFor = ids => ids.map(id => names[id]).join('、');
function observation(row, prev, version) {
  const article = el('article', null, 'history-reading');
  article.append(el('h3', `${row.date} · ${row.score === null ? '暂停评分' : `综合分 ${pts(row.score)}`}`));
  article.append(el('p', `有效权重 ${row.coverage}%${row.baseScore === null ? '' : ` · 基础分 ${pts(row.baseScore)}`}。${row.score === null && row.coverage < MIN_SCORE_COVERAGE ? `有效权重不足 ${MIN_SCORE_COVERAGE}%，这一天没有综合分。` : '基础分按该日有效指标计算。'}`));
  const timing = observationTiming(row);
  if (timing) article.append(el('p',timing,'validation-note'));
  const c = row.change;
  if (!c) article.append(el('p', '这是所列最早的记录，没有上一期可比较。'));
  else {
    let compare;
    if (c.totalDelta !== null) compare = `综合分${c.totalDelta === 0 ? '持平' : `变化 ${signed(c.totalDelta)} 分`}`;
    else if (prev?.score != null && row.score === null) compare = `从 ${pts(prev.score)} 分转为暂停评分`;
    else if (prev && prev.score === null && row.score !== null) compare = `恢复评分至 ${pts(row.score)} 分`;
    else compare = '无法比较综合分';
    article.append(el('p', `与上一期 ${c.previousDate} 相比：${compare}。`));
    if (hasInterveningSession(c.previousDate,row.date)) article.append(el('p','两份记录之间有交易日没有观察记录；这些变化不是单日变化。','validation-note'));
    if (c.lost.length || c.gained.length) {
      const changes = [c.lost.length ? `不再计分：${namesFor(c.lost)}` : '', c.gained.length ? `恢复计分：${namesFor(c.gained)}` : ''].filter(Boolean);
      article.append(el('p', `${changes.join('；')}。`));
    }
    const parts = [c.baseDelta === null ? '' : `基础分 ${signed(c.baseDelta)}`, c.adjustmentDelta === null ? '' : `其余修正合计 ${signed(c.adjustmentDelta)}`].filter(Boolean);
    if (parts.length) article.append(el('p', `${parts.join(' 分；')} 分。`));
    const drivers = c.drivers.filter(d => d.deltaPoints !== 0).slice(0, 3);
    if (drivers.length) {
      article.append(el('p', '对基础分变化贡献最大的指标：'));
      const list = el('ul');
      for (const d of drivers) list.append(el('li', `${names[d.id]}：${signed(d.deltaPoints, 2)} 分`));
      article.append(list);
      if (c.lost.length || c.gained.length) article.append(el('p', '覆盖变化也会调整各项贡献，不能全算作指标本身上涨或下跌。', 'validation-note'));
    }
  }
  const a = el('a', `查看 ${row.date} 原始记录 ↗`); a.href = sourceFor(row, version); a.target = '_blank'; a.rel = 'noreferrer'; article.append(a);
  return article;
}
function render(box, report, selected) {
  const rows = report.observations;
  if (!rows.length) { box.replaceChildren(el('p', '还没有保存的观察记录。')); return null; }
  const latest = rows[0], scored = rows.find(r => r.score !== null);
  const intro = el('p', latest.score === null ? `最近记录 ${latest.date} 暂停评分。${scored ? `所列记录中，上一次有综合分是 ${scored.date}（${pts(scored.score)} 分）。` : '所列记录均未出分。'}` : `最近记录 ${latest.date}：综合分 ${pts(latest.score)}，有效权重 ${latest.coverage}%。`, 'history-latest');
  const label = el('label', '查看观察日'); label.htmlFor = 'scoreHistoryDate';
  const select = el('select'); select.id = label.htmlFor;
  for (const row of rows) { const opt = el('option', `${row.date} · ${row.score === null ? '暂停评分' : `${pts(row.score)} 分`}`); opt.value = row.date; select.append(opt); }
  const picker = el('div', null, 'history-picker'); picker.append(label, select);
  const details = el('div');
  const show = () => { const i = select.selectedIndex; details.replaceChildren(observation(rows[i], rows[i + 1], report.scoringVersion)); };
  if (rows.some(r => r.date === selected)) select.value = selected;
  if (latest.score === null && scored) { const jump = el('button', '查看上一次有分的记录', 'text-button'); jump.type = 'button'; jump.addEventListener('click', () => { select.value = scored.date; show(); select.focus(); }); picker.append(jump); }
  select.addEventListener('change', show); show();
  box.replaceChildren(intro, picker, details); return select;
}
function init() {
  const panel = document.getElementById('scoreHistory'), box = document.getElementById('scoreHistoryContent'), retry = document.getElementById('retryScoreHistory');
  if (!panel || !box || !retry) return;
  const feedback = el('p', '', 'validation-note'); feedback.setAttribute('role', 'status'); feedback.hidden = true; retry.before(feedback);
  let inFlight = false, lastCheck = 0, signature = '', picker;
  async function load(force = false) {
    if (!panel.open || inFlight || (!force && signature && Date.now() - lastCheck < 15 * 60_000)) return;
    inFlight = true; retry.setAttribute('aria-disabled', 'true');
    const controller = new AbortController(); const timer = setTimeout(() => controller.abort(), 10_000);
    feedback.hidden = false; feedback.textContent = '正在读取观察记录…';
    try {
      const response = await fetch('/api/score-history', { signal: controller.signal, cache: 'no-cache' });
      if (!response.ok) throw new Error();
      const report = await response.json(); if (!isScoreHistory(report)) throw new Error();
      const key = JSON.stringify(report); const focus = panel.open && (document.activeElement === retry || document.activeElement === picker);
      if (key !== signature) picker = render(box, report, picker?.value);
      lastCheck = Date.now(); signature = key; feedback.textContent = ''; feedback.hidden = true;
      if (focus) (picker || panel.querySelector('summary')).focus({preventScroll:true}); retry.hidden = true;
    } catch {
      if (!signature) box.replaceChildren();
      feedback.textContent = signature ? '本次更新未成功，仍显示上次读取的记录。' : '暂时无法读取历史记录，稍后可重试。'; retry.hidden = false;
    } finally { clearTimeout(timer); inFlight = false; retry.setAttribute('aria-disabled', 'false'); }
  }
  const followHash = () => { if (location.hash === '#scoreHistory') { panel.open = true; load(); } };
  for (const a of document.querySelectorAll('a[href="#scoreHistory"]')) a.addEventListener('click', () => { panel.open = true; load(); });
  panel.addEventListener('toggle', () => { if (panel.open) load(); }); retry.addEventListener('click', () => load(true));
  window.addEventListener('hashchange', followHash); followHash(); if (panel.open) load();
}
if (typeof document !== 'undefined') init();
