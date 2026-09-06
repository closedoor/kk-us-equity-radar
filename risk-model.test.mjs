import test from "node:test";
import assert from "node:assert/strict";
import { computeScores, actionFor } from "./public/risk-model.js";

const item = (id, risk, weight = 10, extra = {}) => ({ id, risk, weight, points: risk * weight / 100, available: true, ...extra });

test("high-price fragility depends on actual drawdown even below the 200-day average", () => {
  const indicators = [item("sp500", 40), item("breadth", 30)];
  const context = { drawdownPercent: 3, breadthRiskPercent: 30 };
  assert.equal(computeScores(indicators, context).riskUplift, 4);
  assert.equal(computeScores(indicators, { ...context, drawdownPercent: 5 }).riskUplift, 0);
  assert.equal(computeScores(indicators, { ...context, breadthRiskPercent: 19.99 }).riskUplift, 0);
});

test("unavailable indicators cannot contribute to either synergy adjustment", () => {
  const indicators = [item("oil", 80), item("inflation", 80), item("fed", 80, 10, { available: false }), item("sp500", 20, 7, { available: false }), item("breadth", 30)];
  assert.equal(computeScores(indicators, { drawdownPercent: 1, breadthRiskPercent: 30 }).riskUplift, 0);
});

test("manual data reuses the same model and zero is a valid risk", () => {
  const indicators = [item("oil", 80, 30), item("inflation", 80, 30), item("fed", 80, 30)];
  const before = computeScores(indicators);
  const after = computeScores([...indicators, item("earningsBreadth", 0)]);
  assert.equal(before.riskUplift, 7);
  assert.equal(after.availableWeight, 100);
  assert.ok(after.score < before.score);
});

test("empty data stays unavailable and all numeric outputs are finite or null", () => {
  const model = computeScores([item("oil", 80, 5, { available: false })]);
  assert.equal(model.score, null);
  assert.equal(model.dominantRegimeScore, null);
  assert.equal(actionFor(model.score).key, "unavailable");
  assert.ok(Object.values(model).every((value) => typeof value !== "number" || Number.isFinite(value)));
});

test("score and action use the same displayed rounding at alert boundaries", () => {
  const model = computeScores([item("oil", 40.04, 60)]);
  assert.equal(model.score, 40);
  assert.equal(actionFor(model.score).key, "hold");
  for (const [score, key] of [[20, "add"], [20.1, "hold"], [40.1, "caution"], [60.1, "reduce"], [75.1, "defend"]]) {
    assert.equal(actionFor(score).key, key);
  }
});

test("less than 60 percent coverage cannot produce an aggregate score or allocation prompt", () => {
  const partial = computeScores([item("oil", 0, 59)]);
  assert.equal(partial.baseScore, 0);
  assert.equal(partial.score, null);
  assert.equal(actionFor(partial.score, partial.coverage).key, "unavailable");
  assert.equal(computeScores([item("oil", 0, 60)]).score, 0);
});

test("scores remain bounded when both adjustments are active", () => {
  const indicators = ["oil", "inflation", "fed", "rates", "breadth", "sp500"].map((id) => item(id, 100));
  const model = computeScores(indicators, { drawdownPercent: 1, breadthRiskPercent: 100 });
  assert.equal(model.riskUplift, 14);
  assert.equal(model.score, 100);
});
