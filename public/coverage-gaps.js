import { MIN_SCORE_COVERAGE } from "./risk-model.js";

const cpiNotice = "https://www.bls.gov/cpi/notices/2026/12m-changes-202610.htm";

// Read the inputs *after* publication checks, expiry and local overrides, just as the score does.
export function explainCoverage(indicators) {
  const groups = new Map();
  let covered = 0, missing = 0;
  for (const item of indicators) {
    if (item.available && Number.isFinite(item.risk)) { covered += item.weight; continue; }
    const reason = item.unavailableReason?.trim() || "所需数据不全";
    if (!groups.has(reason)) groups.set(reason, { reason, weight: 0, items: [] });
    const group = groups.get(reason);
    group.weight += item.weight;
    missing += item.weight;
    // A status string such as "政策区间待同步" is not an observed rate, even if it has a date.
    const date = item.date, value = String(item.value ?? "").trim();
    const datedReading = typeof date === "string" && /^\d{4}-\d{2}-\d{2}$/.test(date)
      && Number.isFinite(Date.parse(date)) && new Date(date).toISOString().slice(0, 10) === date
      && value !== reason && /\d/.test(value);
    group.items.push({ id: item.id, title: item.title, weight: item.weight, reading: datedReading ? { value, date } : null });
  }
  const cpi = indicators.find(item => item.id === "inflation");
  const cpiGap = groups.get("CPI 同比缺基期");
  if (cpiGap) {
    cpiGap.explanation = "模型计算通胀压力需要 CPI 同比；下列政策或就业指标若也使用这项压力，就会一起暂停计分。";
    if (cpi?.date === "2026-10-01" && cpi.unavailableReason === cpiGap.reason && /2025-10\s*基期/.test(cpi.detail || "")) {
      cpiGap.explanation = "2025 年 10 月缺少同比基期，无法算出 2026 年 10 月整体 CPI 同比。通胀、政策和就业规则都用到这项输入，所以有些指标已有本期读数，仍不能计分。";
      cpiGap.source = cpiNotice;
    }
  }
  return { covered, missing, threshold: MIN_SCORE_COVERAGE, shortfall: Math.max(0, MIN_SCORE_COVERAGE - covered),
    groups: [...groups.values()].sort((a, b) => b.weight - a.weight) };
}
