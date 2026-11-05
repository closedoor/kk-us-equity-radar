const clamp = (value) => Math.min(100, Math.max(0, value));
const round = (value, digits = 1) => Number.isFinite(value) ? Math.round(value * 10 ** digits) / 10 ** digits : null;
export const MIN_SCORE_COVERAGE = 60;
export const MIN_REGIME_COVERAGE = 60;
export const SCORING_VERSION = "4.7.0";
export const SCORING_NOTE = "基础分按有效权重归一化；风险链至少有两项有效信号且覆盖本组 60% 权重，才可向上修正。主导修正为风险链高于基础分的差值 × 30% × 本组覆盖率，再加入最多 14 分共振修正，总分上限 100。规则评分并非下跌概率；历史诊断仅覆盖部分自动指标，完整模型及仓位阈值尚未验证。";
export const INDICATOR_WEIGHTS = Object.freeze({
  oil: 5, inflation: 10, fed: 10, rates: 10, vix: 5,
  unemployment: 8, payrolls: 5, aiEarnings: 5, credit: 15,
  earningsBreadth: 10, breadth: 10, sp500: 7,
});
const REGIMES = [
  { id: "stagflation", label: "滞胀 / 政策压力", ids: ["oil", "inflation", "fed", "rates"] },
  { id: "recession", label: "衰退 / 信用压力", ids: ["unemployment", "payrolls", "credit", "earningsBreadth"] },
  { id: "marketBreak", label: "市场确认", ids: ["vix", "breadth", "sp500"] },
];

export function normalizeIndicator(item) {
  const available = item.available === true && Number.isFinite(item.risk) && item.risk >= 0 && item.risk <= 100
    && Number.isFinite(item.weight) && item.weight > 0;
  return { ...item, available, risk: available ? item.risk : null, points: available ? item.risk * item.weight / 100 : null };
}

export function computeScores(indicators, context = {}) {
  const available = indicators.map(normalizeIndicator).filter((item) => item.available);
  const availableWeight = available.reduce((sum, item) => sum + item.weight, 0);
  const rawPoints = available.reduce((sum, item) => sum + item.points, 0);
  const baseScore = availableWeight ? (rawPoints / availableWeight) * 100 : null;
  const subset = (ids) => {
    const items = available.filter((item) => ids.includes(item.id));
    const weight = items.reduce((sum, item) => sum + item.weight, 0);
    return weight ? (items.reduce((sum, item) => sum + item.points, 0) / weight) * 100 : null;
  };
  const regimes = REGIMES.map(({ id, label, ids }) => {
    const items = available.filter((item) => ids.includes(item.id));
    const totalWeight = ids.reduce((sum, key) => sum + INDICATOR_WEIGHTS[key], 0);
    const weight = items.reduce((sum, item) => sum + item.weight, 0);
    const coverage = Math.min(100, weight / totalWeight * 100);
    const observedScore = subset(ids);
    const eligible = items.length >= 2 && coverage >= MIN_REGIME_COVERAGE;
    return { id, label, observedScore: round(observedScore), score: eligible ? round(observedScore) : null,
      availableCount: items.length, availableWeight: weight, totalWeight, coverage: round(coverage), eligible,
      uplift: eligible && Number.isFinite(baseScore) ? Math.max(0, observedScore - baseScore) * 0.3 * coverage / 100 : 0 };
  });
  // Choose the strongest supported contribution, not an incomplete group's raw maximum.
  const dominant = regimes.filter((row) => row.eligible)
    .sort((a, b) => b.uplift - a.uplift || b.score - a.score)[0];
  const dominantRegimeScore = dominant?.score ?? null;
  const regimeUplift = dominant?.uplift ?? 0;
  const [stagflationScore, recessionScore, marketBreakScore] = regimes.map((row) => row.score);
  const stagflationIds = REGIMES[0].ids;
  const stagflationHighCount = available.filter((item) => stagflationIds.includes(item.id) && item.risk >= 60).length;
  const macroSynergyUplift = stagflationHighCount >= 4 ? 10 : stagflationHighCount >= 3 ? 7 : 0;
  const marketAvailable = ["sp500", "breadth"].every((id) => available.some((item) => item.id === id));
  const fragileHighUplift = marketAvailable
    && Number.isFinite(context.drawdownPercent) && context.drawdownPercent >= 0 && context.drawdownPercent < 5
    && Number.isFinite(context.breadthRiskPercent) && context.breadthRiskPercent >= 20 ? 4 : 0;
  const riskUplift = macroSynergyUplift + fragileHighUplift;
  const score = Number.isFinite(baseScore) ? clamp(baseScore + regimeUplift + riskUplift) : null;
  return {
    available,
    availableWeight,
    coverage: availableWeight,
    rawPoints: round(rawPoints, 2),
    baseScore: round(baseScore),
    score: availableWeight >= MIN_SCORE_COVERAGE ? round(score) : null,
    heatScore: round(stagflationScore),
    stagflationScore: round(stagflationScore),
    recessionScore: round(recessionScore),
    marketBreakScore: round(marketBreakScore),
    dominantRegimeScore: round(dominantRegimeScore),
    dominantRegime: dominant?.id ?? null,
    regimeUplift: round(regimeUplift),
    regimes: regimes.map((row) => ({ ...row, uplift: round(row.uplift) })),
    scoringVersion: SCORING_VERSION,
    riskUplift,
    confirmationScore: round(subset(["vix", "sp500", "credit", "breadth", "earningsBreadth"])),
  };
}

export function actionFor(score, coverage = 0) {
  if (!Number.isFinite(score)) return { key: "unavailable", label: "数据不足：等待有效证据", detail: `有效数据覆盖率为 ${coverage}%，达到 ${MIN_SCORE_COVERAGE}% 后恢复综合评分。` };
  if (score <= 20) return { key: "add", label: "低分区间：核对信用与盈利资料是否完整", detail: "检查缺失指标和发布日期，继续观察风险来源；低分不能排除随后发生较大回撤。" };
  if (score <= 40) return { key: "hold", label: "常态区间：观察压力是否跨指标扩散", detail: "对照就业、信用和市场宽度，区分单项变化与多条风险链同时恶化。" };
  if (score <= 60) return { key: "caution", label: "警戒区间：复核主要风险链", detail: "查看前三项贡献及其数据期，核实通胀、政策或盈利压力是否得到信用与价格信号支持。" };
  if (score <= 75) return { key: "reduce", label: "高分区间：优先核对信用与流动性压力", detail: "检查利差、就业与市场确认是否同向，并排查数据缺失或发布不同步带来的分数变化。" };
  return { key: "defend", label: "极高分区间：逐项核查压力证据", detail: "优先核对信用事件、融资条件及价格趋势。规则高分需要证据复核，不能直接转换成下跌概率或仓位指令。" };
}
