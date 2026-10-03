import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { projectDashboard, shouldReplaceDashboard, MAX_MARKET_CACHE_AGE_MS, isDashboardSnapshot } from "./public/dashboard-state.js";
import { INDICATOR_WEIGHTS, SCORING_VERSION } from "./public/risk-model.js";

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
  assert.equal(after.coverage, 5);
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
  assert.equal(after.coverage, 85);
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

test("old cached weights and inconsistent points migrate without changing source freshness", () => {
  const data = sample();
  data.indicators.forEach((row) => { row.points = 999; });
  const projected = projectDashboard(data, now);
  assert.equal(projected.generatedAt, data.generatedAt);
  assert.equal(projected.scoringVersion, SCORING_VERSION);
  assert.equal(projected.methodology.version, SCORING_VERSION);
  assert.equal(projected.coverage, 90);
  for (const row of projected.indicators) {
    assert.equal(row.weight, INDICATOR_WEIGHTS[row.id]);
    assert.equal(row.points, row.available ? row.risk * row.weight / 100 : null);
  }
  assert.equal(projectDashboard(projected, now).score, projected.score);
  assert.equal(data.indicators[0].points, 999);
});

test("structurally broken disk caches are rejected before API rendering", () => {
  assert.equal(isDashboardSnapshot(sample()), true);
  for (const data of [null, {}, { ...sample(), indicators: null }, { ...sample(), indicators: [{}] }, { ...sample(), generatedAt: "invalid" }]) {
    assert.equal(isDashboardSnapshot(data), false);
  }
});

test("overnight projections cannot show a passed macro date as the next event", () => {
  const data = sample();
  data.reminders = [{ label: "CPI", date: "2026-09-06", event: "CPI", scheduleStatus: "confirmed" }];
  const before = projectDashboard(data, Date.parse("2026-09-07T03:59:00Z"));
  const after = projectDashboard(data, Date.parse("2026-09-07T04:01:00Z"));
  assert.equal(before.reminders[0].date, "2026-09-06");
  assert.equal(after.reminders[0].date, null);
  assert.equal(after.reminders[0].scheduleStatus, "pending");
  assert.match(after.reminders[0].event, /待.*下一期/);
  assert.equal(data.reminders[0].date, "2026-09-06");
});

test("company cards and reminders agree when an earnings date or estimate passes", () => {
  const data = sample();
  data.aiEarnings[0] = { ...data.aiEarnings[0], nextReportDate: "2026-09-06", nextReportStatus: "confirmed", nextReportLabel: "2026-09-06", snapshotValidThrough: "2026-09-06" };
  data.aiEarnings[1] = { ...data.aiEarnings[1], nextReportDate: null, nextReportEstimatedDate: "2026-09-06", nextReportLabel: "预计 2026-09-06 前后", nextReportStatus: "estimated" };
  data.reminders = [{ date: null, companies: data.aiEarnings.slice(0, 2).map((row) => ({ ticker: row.ticker, next: row.nextReportLabel, status: row.nextReportStatus })) }];
  const after = projectDashboard(data, Date.parse("2026-09-07T04:01:00Z"));
  for (let index = 0; index < 2; index += 1) {
    assert.equal(after.aiEarnings[index].nextReportDate, null);
    assert.equal(after.aiEarnings[index].nextReportStatus, "pending");
    assert.equal(after.reminders[0].companies[index].next, after.aiEarnings[index].nextReportLabel);
    assert.equal(after.reminders[0].companies[index].status, "pending");
  }
  assert.equal(after.aiEarnings[0].snapshotStale, true);
});

test("calendar expiry follows New York midnight across daylight saving and year-end", () => {
  for (const [date, before, after] of [
    ["2026-03-08", "2026-03-09T03:59:00Z", "2026-03-09T04:01:00Z"],
    ["2026-11-01", "2026-11-02T04:59:00Z", "2026-11-02T05:01:00Z"],
    ["2026-12-31", "2027-01-01T04:59:00Z", "2027-01-01T05:01:00Z"],
  ]) {
    const data = { ...sample(), generatedAt: before, reminders: [{ date, label: "CPI", event: "CPI" }] };
    assert.equal(projectDashboard(data, Date.parse(before)).reminders[0].date, date);
    assert.equal(projectDashboard(data, Date.parse(after)).reminders[0].date, null);
  }
});
