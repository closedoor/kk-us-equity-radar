import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { projectDashboard, shouldReplaceDashboard, MAX_MARKET_CACHE_AGE_MS, isDashboardSnapshot } from "./public/dashboard-state.js";

const fixture = JSON.parse(readFileSync(new URL("./dashboard-cache.json", import.meta.url)));
const now = Date.parse("2026-09-06T12:00:00Z");
function sample() {
  const data = structuredClone(fixture);
  data.generatedAt = new Date(now).toISOString();
  data.aiEarnings = data.aiEarnings.map((row) => ({ ...row, released: "2026-08-01", snapshotStale: false, snapshotValidThrough: "2026-10-01" }));
  return data;
}

test("market caches stop scoring at 24 hours while independent financial reports remain visible", () => {
  const data = sample();
  const before = projectDashboard(data, now + MAX_MARKET_CACHE_AGE_MS - 1);
  const after = projectDashboard(data, now + MAX_MARKET_CACHE_AGE_MS);
  assert.equal(before.cacheExpired, false);
  assert.equal(after.cacheExpired, true);
  assert.equal(after.coverage, 10);
  assert.equal(after.score, null);
  assert.equal(after.action.key, "unavailable");
  assert.ok(after.indicators.filter((item) => item.id !== "aiEarnings").every((item) => !item.available));
  assert.equal(data.indicators.find((item) => item.id === "oil").available, true);
});

test("invalid and future cache timestamps are unusable", () => {
  for (const generatedAt of [null, "invalid", "2026-09-07T12:00:00Z"]) {
    assert.equal(projectDashboard({ ...sample(), generatedAt }, now).cacheExpired, true);
  }
});

test("passing a report date immediately updates the AI indicator, coverage and score without a market fetch", () => {
  const data = sample();
  data.aiEarnings = data.aiEarnings.map((row, index) => ({ ...row, snapshotValidThrough: index < 6 ? "2026-09-06" : "2026-10-01" }));
  const before = projectDashboard(data, Date.parse("2026-09-07T03:59:00Z"));
  const after = projectDashboard(data, Date.parse("2026-09-07T04:01:00Z"));
  assert.equal(before.coverage, 90);
  assert.equal(after.coverage, 80);
  assert.equal(after.aiEarnings.filter((row) => row.snapshotStale).length, 6);
  assert.equal(after.indicators.find((row) => row.id === "aiEarnings").available, false);
  assert.equal(after.indicators.find((row) => row.id === "aiEarnings").value, "2 / 8 家");
  assert.equal(projectDashboard(after, Date.parse("2026-09-07T04:01:00Z")).score, after.score);
});

test("a poor refresh cannot displace a recent good cache but can replace an expired one", () => {
  const good = sample();
  const poor = { ...sample(), coverage: 20, errors: ["source unavailable"] };
  assert.equal(shouldReplaceDashboard(good, poor, now + 1000), false);
  assert.equal(shouldReplaceDashboard(good, poor, now + MAX_MARKET_CACHE_AGE_MS), true);
  assert.equal(shouldReplaceDashboard(null, poor, now), true);
  assert.equal(shouldReplaceDashboard(good, { ...poor, errors: [] }, now), true);
});

test("structurally broken disk caches are rejected before API rendering", () => {
  assert.equal(isDashboardSnapshot(sample()), true);
  for (const data of [null, {}, { ...sample(), indicators: null }, { ...sample(), indicators: [{}] }, { ...sample(), generatedAt: "invalid" }]) {
    assert.equal(isDashboardSnapshot(data), false);
  }
});
