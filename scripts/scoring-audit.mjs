import assert from "node:assert/strict";
import { computeScores, INDICATOR_WEIGHTS } from "../public/risk-model.js";

const oldWeights = { ...INDICATOR_WEIGHTS, aiEarnings: 10, credit: 12, breadth: 8 };
const scenarios = [
  { name: "All signals calm", risks: {}, defaultRisk: 0 },
  { name: "All signals critical", risks: {}, defaultRisk: 100 },
  { name: "Macro pressure", risks: { oil: 80, inflation: 80, fed: 80, rates: 80 } },
  { name: "Recession and credit", risks: { unemployment: 80, payrolls: 80, credit: 80, earningsBreadth: 80 } },
  { name: "Broad market stress", risks: { vix: 80, breadth: 80, sp500: 80 } },
  { name: "Credit shock", risks: { credit: 100 } },
  { name: "AI-only deterioration", risks: { aiEarnings: 100 } },
  { name: "Isolated VIX; other market signals missing", risks: { vix: 100 }, defaultRisk: 0, missing: ["breadth", "sp500", "earningsBreadth"] },
  { name: "VIX and index; breadth missing", risks: { vix: 100, sp500: 100 }, defaultRisk: 0, missing: ["breadth"] },
  { name: "AI snapshots only", risks: { aiEarnings: 100 }, missing: Object.keys(INDICATOR_WEIGHTS).filter((id) => id !== "aiEarnings") },
];

function rows(scenario, weights) {
  return Object.entries(weights).map(([id, weight]) => {
    const risk = scenario.risks[id] ?? scenario.defaultRisk ?? 10;
    return { id, weight, risk, points: risk * weight / 100, available: !scenario.missing?.includes(id) };
  });
}

function legacyScore(indicators) {
  const available = indicators.filter((row) => row.available);
  const weight = available.reduce((sum, row) => sum + row.weight, 0);
  if (weight < 60) return null;
  const base = available.reduce((sum, row) => sum + row.points, 0) / weight * 100;
  const groups = [["oil", "inflation", "fed", "rates"], ["unemployment", "payrolls", "credit", "earningsBreadth"], ["vix", "breadth", "sp500"]];
  const scores = groups.map((ids) => {
    const items = available.filter((row) => ids.includes(row.id));
    const total = items.reduce((sum, row) => sum + row.weight, 0);
    return total ? items.reduce((sum, row) => sum + row.points, 0) / total * 100 : null;
  }).filter(Number.isFinite);
  const highMacro = available.filter((row) => groups[0].includes(row.id) && row.risk >= 60).length;
  const synergy = highMacro >= 4 ? 10 : highMacro >= 3 ? 7 : 0;
  return Math.round(Math.min(100, base * 0.7 + Math.max(...scores) * 0.3 + synergy) * 10) / 10;
}

const results = scenarios.map((scenario) => {
  const current = computeScores(rows(scenario, INDICATOR_WEIGHTS));
  return { scenario: scenario.name, oldModel: legacyScore(rows(scenario, oldWeights)),
    weightsOnly: legacyScore(rows(scenario, INDICATOR_WEIGHTS)), currentModel: current.score,
    currentBase: current.baseScore, coverage: current.coverage };
});
assert.equal(results[0].currentModel, 0);
assert.equal(results[1].currentModel, 100);
assert.equal(results[7].currentModel, results[7].currentBase);
assert.equal(results[8].currentModel, results[8].currentBase);
assert.equal(results[9].currentModel, null);
console.table(results);
console.log("Synthetic sensitivity checks only; this is not a historical backtest or a probability calibration.");
