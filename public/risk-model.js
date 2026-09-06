const clamp = (value) => Math.min(100, Math.max(0, value));
const round = (value, digits = 1) => Number.isFinite(value) ? Math.round(value * 10 ** digits) / 10 ** digits : null;

export function computeScores(indicators, context = {}) {
  const available = indicators.filter((item) => item.available && Number.isFinite(item.risk) && Number.isFinite(item.points) && Number.isFinite(item.weight) && item.weight > 0);
  const availableWeight = available.reduce((sum, item) => sum + item.weight, 0);
  const rawPoints = available.reduce((sum, item) => sum + item.points, 0);
  const baseScore = availableWeight ? (rawPoints / availableWeight) * 100 : null;
  const subset = (ids) => {
    const items = available.filter((item) => ids.includes(item.id));
    const weight = items.reduce((sum, item) => sum + item.weight, 0);
    return weight ? (items.reduce((sum, item) => sum + item.points, 0) / weight) * 100 : null;
  };
  const stagflationIds = ["oil", "inflation", "fed", "rates"];
  const stagflationScore = subset(stagflationIds);
  const recessionScore = subset(["unemployment", "payrolls", "credit", "earningsBreadth"]);
  const marketBreakScore = subset(["vix", "breadth", "sp500"]);
  const regimeScores = [stagflationScore, recessionScore, marketBreakScore].filter(Number.isFinite);
  const dominantRegimeScore = regimeScores.length ? Math.max(...regimeScores) : null;
  const stagflationHighCount = available.filter((item) => stagflationIds.includes(item.id) && item.risk >= 60).length;
  const macroSynergyUplift = stagflationHighCount >= 4 ? 10 : stagflationHighCount >= 3 ? 7 : 0;
  const marketAvailable = ["sp500", "breadth"].every((id) => available.some((item) => item.id === id));
  const fragileHighUplift = marketAvailable
    && Number.isFinite(context.drawdownPercent) && context.drawdownPercent >= 0 && context.drawdownPercent < 5
    && Number.isFinite(context.breadthRiskPercent) && context.breadthRiskPercent >= 20 ? 4 : 0;
  const riskUplift = macroSynergyUplift + fragileHighUplift;
  const score = Number.isFinite(baseScore)
    ? Number.isFinite(dominantRegimeScore)
      ? clamp(baseScore * 0.70 + dominantRegimeScore * 0.30 + riskUplift)
      : clamp(baseScore)
    : null;
  return {
    available,
    availableWeight,
    coverage: availableWeight,
    rawPoints: round(rawPoints, 2),
    baseScore: round(baseScore),
    score: round(score),
    heatScore: round(stagflationScore),
    stagflationScore: round(stagflationScore),
    recessionScore: round(recessionScore),
    marketBreakScore: round(marketBreakScore),
    dominantRegimeScore: round(dominantRegimeScore),
    riskUplift,
    confirmationScore: round(subset(["vix", "sp500", "credit", "breadth", "earningsBreadth"])),
  };
}

export function actionFor(score) {
  if (!Number.isFinite(score)) return { key: "unavailable", label: "数据不足：暂不提供仓位动作", detail: "等待有效数据后再判断风险，不把缺失数据误判为低风险。" };
  if (score <= 20) return { key: "add", label: "风险较低：可考虑分批增加风险敞口", detail: "适合按既定资产配置逐步投入，不代表短期不会回调。" };
  if (score <= 40) return { key: "hold", label: "正常波动：以持有和再平衡为主", detail: "不追涨，也不因单项噪声急于减仓，等待风险是否跨指标扩散。" };
  if (score <= 60) return { key: "caution", label: "黄色警戒：保持仓位，暂停加仓", detail: "当前不支持全面卖出；保留现金，优先降低高估值、高波动或带杠杆仓位，等待信用、盈利或市场宽度改善。" };
  if (score <= 75) return { key: "reduce", label: "橙色警报：考虑降低高波动仓位", detail: "风险链已明显共振，重点控制回撤、杠杆与流动性。" };
  return { key: "defend", label: "红色警报：优先防守与控制回撤", detail: "系统性风险较高，应优先处理杠杆和流动性暴露。" };
}
