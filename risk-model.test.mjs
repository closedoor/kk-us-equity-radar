import test from "node:test";
import assert from "node:assert/strict";
import { computeScores, actionFor, INDICATOR_WEIGHTS, normalizeIndicator } from "./public/risk-model.js";

const item = (id, risk, weight = 10, extra = {}) => ({ id, risk, weight, points: risk * weight / 100, available: true, ...extra });
const full = (risks = {}, missing = []) => Object.entries(INDICATOR_WEIGHTS)
  .map(([id, weight]) => item(id, risks[id] ?? 0, weight, { available: !missing.includes(id) }));

test("production weights stay at 100 and reduce reliance on qualitative AI snapshots", () => {
  assert.equal(Object.values(INDICATOR_WEIGHTS).reduce((sum, weight) => sum + weight, 0), 100);
  assert.equal(INDICATOR_WEIGHTS.aiEarnings, 5);
  assert.equal(INDICATOR_WEIGHTS.credit, 15);
  assert.equal(INDICATOR_WEIGHTS.breadth, 10);
});

test("a lone VIX observation cannot stand in for an entire market regime", () => {
  const model = computeScores(full({ vix: 100 }, ["breadth", "sp500", "earningsBreadth"]));
  const market = model.regimes.find((row) => row.id === "marketBreak");
  assert.equal(market.observedScore, 100);
  assert.equal(market.score, null);
  assert.equal(market.availableCount, 1);
  assert.equal(model.regimeUplift, 0);
  assert.equal(model.score, model.baseScore);
});

test("regime confirmation requires both multiple signals and sufficient planned weight", () => {
  const two = computeScores(full({ vix: 100, sp500: 100 }, ["breadth"]));
  assert.equal(two.regimes.find((row) => row.id === "marketBreak").eligible, false);
  const supported = computeScores(full({ breadth: 100, sp500: 100 }, ["vix"]));
  const market = supported.regimes.find((row) => row.id === "marketBreak");
  assert.equal(market.eligible, true);
  assert.equal(market.coverage, 77.3);
  assert.ok(supported.regimeUplift > 0);
  assert.ok(supported.regimeUplift < (100 - supported.baseScore) * 0.3);
});

test("regime adjustments can increase risk but never dilute the base score", () => {
  const model = computeScores(full({ aiEarnings: 100 }));
  assert.equal(model.baseScore, 5);
  assert.equal(model.regimeUplift, 0);
  assert.equal(model.score, 5);
});

test("risk and weight are authoritative even when stored points are contradictory", () => {
  const rows = full().map((row) => ({ ...row, points: row.weight }));
  const model = computeScores(rows);
  assert.equal(model.rawPoints, 0);
  assert.equal(model.score, 0);
  assert.ok(model.available.every((row) => row.points === 0));
  assert.equal(rows[0].points, rows[0].weight);
  assert.equal(normalizeIndicator(item("credit", 50, 15, { points: 99 })).points, 7.5);
});

test("invalid risks are excluded rather than generating negative or inflated scores", () => {
  for (const risk of [-1, 101, NaN, Infinity, null]) {
    const model = computeScores([item("oil", risk, 60)]);
    assert.equal(model.availableWeight, 0);
    assert.equal(model.score, null);
  }
});

test("each risk input is monotone over the full range with fixed availability", () => {
  for (const id of Object.keys(INDICATOR_WEIGHTS)) {
    let previous = -1;
    for (let risk = 0; risk <= 100; risk += 1) {
      const model = computeScores(full({ oil: 60, inflation: 60, fed: 60, [id]: risk }));
      assert.ok(model.score >= previous, `${id} fell at ${risk}`);
      previous = model.score;
    }
  }
});

test("all 4096 missing-data combinations preserve coverage and evidence guards", () => {
  const ids = Object.keys(INDICATOR_WEIGHTS);
  for (let mask = 0; mask < 2 ** ids.length; mask += 1) {
    const missing = ids.filter((id, index) => mask & (1 << index));
    const model = computeScores(full(Object.fromEntries(ids.map((id, index) => [id, index % 2 ? 100 : 60])), missing));
    const coverage = ids.filter((id) => !missing.includes(id)).reduce((sum, id) => sum + INDICATOR_WEIGHTS[id], 0);
    assert.equal(model.coverage, coverage);
    assert.equal(Number.isFinite(model.score), coverage >= 60);
    if (model.score !== null) assert.ok(model.score >= model.baseScore && model.score <= 100);
    for (const regime of model.regimes) {
      if (regime.availableCount < 2 || regime.coverage < 60) {
        assert.equal(regime.score, null);
        assert.equal(regime.uplift, 0);
      }
    }
  }
});

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
