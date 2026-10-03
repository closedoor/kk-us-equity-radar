const clamp = (value) => Math.min(100, Math.max(0, value));
const round = (value, digits = 1) => Number.isFinite(value) ? Math.round(value * 10 ** digits) / 10 ** digits : null;
export const MIN_SCORE_COVERAGE = 60;
export const MIN_REGIME_COVERAGE = 60;
export const SCORING_VERSION = "4.7.0";
export const SCORING_NOTE = "基础分按有效权重归一化；风险链至少有两项有效信号且覆盖本组 60% 权重，才可向上修正。主导修正为风险链高于基础分的差值 × 30% × 本组覆盖率，再加入最多 14 分共振修正，总分上限 100。规则评分并非下跌概率，权重尚未经过完整历史回测。";
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
  if (!Number.isFinite(score)) return { key: "unavailable", label: "数据不足：暂不提供仓位动作", detail: `有效数据覆盖率为 ${coverage}%，达到 ${MIN_SCORE_COVERAGE}% 后恢复综合评分。` };
  if (score <= 20) return { key: "add", label: "风险较低：可考虑分批增加风险敞口", detail: "适合按既定资产配置逐步投入，不代表短期不会回调。" };
  if (score <= 40) return { key: "hold", label: "正常波动：以持有和再平衡为主", detail: "不追涨，也不因单项噪声急于减仓，等待风险是否跨指标扩散。" };
  if (score <= 60) return { key: "caution", label: "黄色警戒：保持仓位，暂停加仓", detail: "当前不支持全面卖出；保留现金，优先降低高估值、高波动或带杠杆仓位，等待信用、盈利或市场宽度改善。" };
  if (score <= 75) return { key: "reduce", label: "橙色警报：考虑降低高波动仓位", detail: "风险链已明显共振，重点控制回撤、杠杆与流动性。" };
  return { key: "defend", label: "红色警报：优先防守与控制回撤", detail: "系统性风险较高，应优先处理杠杆和流动性暴露。" };
}
