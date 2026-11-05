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

test("revision metadata cannot introduce malformed nested display values", () => {
  const row = { series: "PAYEMS", label: "非农就业", date: "2026-08-01", before: 150000, after: 150010, firstDetectedAt: "2026-09-06T11:00:00Z" };
  assert.equal(isDashboardSnapshot({ ...sample(), sourceRevisions: [row] }), true);
  for (const changed of [{ label: { toString: null } }, { before: "150000" }, { after: null }, { series: [] }, { date: "2026-02-31" }, { firstDetectedAt: "invalid" }]) {
    assert.equal(isDashboardSnapshot({ ...sample(), sourceRevisions: [{ ...row, ...changed }] }), false);
  }
});

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

test("policy contradictions in saved observations stop only policy scoring and remain idempotent", () => {
  const original = sample();
  original.errors = ["test market source warning"];
  const control = projectDashboard(original, now);
  for (const [lowerDate, upperDate, lowerValue, upperValue] of [
    ["2026-09-03", "2026-09-04", "3.5%", "3.25%"],
    ["2026-09-04", "2026-09-03", "3%", "3.75%"],
    ["2026-09-04", "2026-09-04", "4%", "3.75%"],
  ]) {
    for (const initiallyAvailable of [true, false]) {
      const data = structuredClone(original);
      const fed = data.indicators.find((row) => row.id === "fed");
      fed.available = initiallyAvailable;
      if (!initiallyAvailable) { fed.risk = null; fed.points = null; }
      fed.value = `${lowerValue}–${upperValue}`;
      fed.detail = "当前联邦基金目标区间；下次会议 待官方公布；2 年期 3.75%";
      fed.breakdown = [
        { label: "政策目标下限", value: lowerValue, detail: lowerDate },
        { label: "政策目标上限", value: upperValue, detail: upperDate },
      ];
      const projected = projectDashboard(data, now);
      const policy = projected.indicators.find((row) => row.id === "fed");
      assert.equal(policy.available, false);
      assert.equal(policy.risk, null);
      assert.equal(policy.points, null);
      assert.equal(policy.judgment, null);
      assert.equal(projected.coverage, control.coverage - INDICATOR_WEIGHTS.fed);
      assert.ok(!policy.value.includes("%–"));
      assert.doesNotMatch(policy.detail, /当前联邦基金目标区间/);
      assert.deepEqual(policy.breakdown, fed.breakdown);
      assert.deepEqual(projected.indicators.filter((row) => row.id !== "fed"), control.indicators.filter((row) => row.id !== "fed"));
      assert.equal(projected.errors.length, 2);
      assert.equal(projected.errors[0], "test market source warning");
      assert.match(projected.errors[1], /目标区间.*(?:同步|无效)/);
      assert.deepEqual(projectDashboard(projected, now), projected);
      assert.equal(fed.value, `${lowerValue}–${upperValue}`, "Projection mutated its source snapshot");
    }
  }
});

test("valid zero policy bounds and legacy snapshots without complete bound evidence remain compatible", () => {
  const baseline = sample();
  for (const breakdown of [
    undefined,
    [{ label: "政策目标下限", value: "0%", detail: "2026-09-04" }],
    [{ label: "政策目标下限", value: "0%", detail: "2026-09-04" }, { label: "政策目标上限", value: "0.25%", detail: "2026-09-04" }],
  ]) {
    const data = structuredClone(baseline);
    data.indicators.find((row) => row.id === "fed").breakdown = breakdown;
    const projected = projectDashboard(data, now);
    assert.equal(projected.indicators.find((row) => row.id === "fed").available, true);
    assert.equal(projected.coverage, 90);
    assert.deepEqual(projected.errors, baseline.errors);
  }
});

test("cache replacement cannot retain coverage earned by contradictory policy bounds", () => {
  const current = sample();
  current.indicators.find((row) => row.id === "fed").breakdown = [
    { label: "政策目标下限", value: "4%", detail: "2026-09-04" },
    { label: "政策目标上限", value: "3.75%", detail: "2026-09-04" },
  ];
  const next = sample();
  Object.assign(next.indicators.find((row) => row.id === "vix"), { available: false, risk: null, points: null });
  next.errors = ["test missing VIX"];
  const projectedNext = projectDashboard(next, now);
  assert.equal(shouldReplaceDashboard(current, projectedNext, now), false, "The unverified old cache reproduces the original retention path");
  assert.equal(projectedNext.coverage, 85);
  assert.equal(shouldReplaceDashboard(projectDashboard(current, now), projectedNext, now), true);
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

test("PCE input dates distinguish valid unknown components from malformed structured metadata", () => {
  for (const inputDates of [
    undefined,
    { headlinePce: "2026-08-01", corePce: "2026-08-01" },
    { headlinePce: null, corePce: null },
    { headlinePce: "2026-08-01", corePce: null },
  ]) {
    const data = sample();
    if (inputDates !== undefined) data.indicators.find((row) => row.id === "inflation").inputDates = inputDates;
    assert.equal(isDashboardSnapshot(data), true);
  }
  for (const inputDates of [
    null, [], "2026-08-01", {}, { corePce: "2026-08-01" },
    { headlinePce: "2026-08-01", corePce: "2026-02-30" },
    { headlinePce: "2026-13-01", corePce: "2026-08-01" },
    { headlinePce: "2026-08-01", corePce: {} },
    { headlinePce: "2026-08-01", corePce: "2026-08-01", extra: "2026-08-01" },
  ]) {
    const data = sample();
    data.indicators.find((row) => row.id === "inflation").inputDates = inputDates;
    assert.equal(isDashboardSnapshot(data), false, JSON.stringify(inputDates));
  }
});

test("numeric validation references cannot accept malformed prices, dates, or benchmark identities", () => {
  for (const validationReference of [undefined, null, { series: "SP500", date: "2026-09-04", close: 5000 }]) {
    const data = sample();
    if (validationReference !== undefined) data.validationReference = validationReference;
    assert.equal(isDashboardSnapshot(data), true);
  }
  for (const validationReference of [
    [], "5000", {}, { series: "SP500", date: "2026-02-30", close: 5000 },
    { series: "VIX", date: "2026-09-04", close: 5000 },
    ...[0, -1, NaN, Infinity, "5000", null, {}].map((close) => ({ series: "SP500", date: "2026-09-04", close })),
  ]) {
    const data = sample();
    data.validationReference = validationReference;
    assert.equal(isDashboardSnapshot(data), false);
  }
});

test("earnings evidence must be structurally valid before a dashboard cache can be hydrated", () => {
  const record = {
    checkedAt: "2026-08-01T12:00:00Z", attemptedAt: "2026-08-01T12:00:00Z", error: null,
    reports: [{ period: "FY2026 Q4", periodEnd: "2026-06-30", publishedAt: "2026-07-30T12:00:00Z",
      source: "https://www.sec.gov/Archives/edgar/data/789019/000078901926000001/msft-20260630.htm", form: "10-K", title: "MSFT annual report" }],
  };
  const schedule = { version: 1, sources: { MSFT: record } };
  for (const earningsSchedule of [undefined, null, { version: 1, sources: {} }, schedule]) {
    const data = sample();
    if (earningsSchedule !== undefined) data.earningsSchedule = earningsSchedule;
    assert.equal(isDashboardSnapshot(data), true);
  }
  const malformed = [[], {}, { version: 2, sources: {} }, { version: 1, sources: [] }, { version: 1, sources: { UNKNOWN: record } }];
  for (const edit of [
    (value) => { value.sources.MSFT.reports = "reports"; },
    (value) => { value.sources.MSFT.checkedAt = "not a timestamp"; },
    (value) => { value.sources.MSFT.error = {}; },
    (value) => { value.sources.MSFT.reports[0].periodEnd = "2026-02-30"; },
    (value) => { value.sources.MSFT.reports[0].publishedAt = "2026-08-02T12:00:00Z"; },
    (value) => { value.sources.MSFT.reports[0].source = "https://example.com/report"; },
    (value) => { value.sources.MSFT.reports[0].title = {}; },
  ]) { const value = structuredClone(schedule); edit(value); malformed.push(value); }
  for (const earningsSchedule of malformed) {
    const data = sample(); data.earningsSchedule = earningsSchedule;
    assert.equal(isDashboardSnapshot(data), false);
  }
});

test("snapshots require the complete signal board and unambiguous availability", () => {
  const broken = [];
  const mutate = (edit) => { const data = sample(); edit(data); broken.push(data); };
  mutate((data) => { data.indicators.pop(); });
  mutate((data) => { data.indicators[0].id = "unknown-signal"; });
  mutate((data) => { data.indicators[0].id = ["oil"]; });
  mutate((data) => { data.indicators[0].id = { toString: "oil" }; });
  mutate((data) => { data.indicators[0].available = "false"; });
  mutate((data) => { data.indicators[0].available = false; });
  mutate((data) => { data.indicators[0].category = "missing-category"; });
  mutate((data) => { data.categories = []; });
  mutate((data) => { data.aiEarnings[1].ticker = data.aiEarnings[0].ticker; });
  for (const data of broken) assert.equal(isDashboardSnapshot(data), false);
  assert.equal(isDashboardSnapshot(sample()), true);
  const oldPoints = sample();
  oldPoints.indicators.forEach((row) => { row.points = 999; });
  assert.equal(isDashboardSnapshot(oldPoints), true);
  assert.equal(projectDashboard(oldPoints, now).score, projectDashboard(sample(), now).score);
});

test("nested display and financial fields cannot bypass snapshot validation", () => {
  const edits = [
    (data) => { data.aiEarnings[0].guidanceTone = { toString: null }; },
    (data) => { data.aiEarnings[0].source = { toString: null }; },
    (data) => { data.aiEarnings[0].snapshotStale = "false"; },
    (data) => { data.refreshing = "false"; },
    (data) => { data.dataQualityVersion = "1"; },
    (data) => { data.indicators[0].value = { toString: null }; },
    (data) => { data.indicators[0].source.label = []; },
    (data) => { data.indicators[0].judgment = { tone: {}, label: "bad" }; },
    (data) => { data.indicators[0].breakdown = [{ label: {}, value: "0" }]; },
    (data) => { data.calendarSync = { updatedAt: "invalid", sources: {} }; },
    (data) => { data.calendarSync.sources.bls = { error: {} }; },
    (data) => { data.calendarSchedule.earnings.NVDA = { date: "2026-11-18", timing: { toString: null } }; },
    (data) => { data.calendarSchedule.sources.bls = { mode: { toString: null } }; },
    (data) => { data.calendarSchedule.fomc[0].startDate = "2026-02-31"; },
    (data) => { data.calendarSchedule.cpi[0].period = {}; },
    (data) => { data.calendarSchedule.pastEarnings.NVDA = "not-a-date"; },
    (data) => { data.reminders[0].event = { toString: null }; },
  ];
  for (const edit of edits) {
    const data = sample();
    edit(data);
    assert.equal(isDashboardSnapshot(data), false, edit.toString());
  }
  assert.equal(isDashboardSnapshot(sample()), true);
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
