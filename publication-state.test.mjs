import test from "node:test";
import assert from "node:assert/strict";
import { PUBLICATION_SOURCES, isPublicationSchedule, applyPublicationChecks } from "./public/publication-state.js";
import { computeScores, actionFor, INDICATOR_WEIGHTS } from "./public/risk-model.js";

const now = Date.parse("2026-11-05T16:00:00Z");
const checkedAt = "2026-11-05T15:00:00Z";
const publishedAt = "2026-11-04T13:30:00Z";
function proof(kind, edits = {}) {
  return { period: "2026-10", publishedAt, checkedAt, source: PUBLICATION_SOURCES[kind], error: null, ...edits };
}
function schedule(edits = {}) {
  return { version: 1, sources: { cpi: proof("cpi"), employment: proof("employment"), ...edits } };
}
function indicators(edits = {}) {
  return Object.entries(INDICATOR_WEIGHTS).map(([id, weight]) => ({
    id, title: id, weight, date: "2026-10-01", risk: 40, points: weight * 0.4,
    available: true, status: "watch", value: `observed ${id}`, detail: "original source value", ...edits[id],
  }));
}
function disabled(result) {
  return result.indicators.filter((item) => !item.available).map((item) => item.id).sort();
}

test("publication schedules require canonical sources, paired proof fields and valid calendar timestamps", () => {
  assert.equal(isPublicationSchedule(schedule()), true);
  assert.equal(isPublicationSchedule({ version: 1, sources: { cpi: null, employment: null } }), true);
  assert.equal(isPublicationSchedule(schedule({ cpi: proof("cpi", { period: null, publishedAt: null, error: "source unavailable" }) })), true);
  assert.equal(isPublicationSchedule({ ...schedule(), attemptedAt: checkedAt }), true);
  assert.equal(isPublicationSchedule(schedule({ cpi: proof("cpi", { attemptedAt: checkedAt, error: "retry failed" }) })), true);
  assert.equal(isPublicationSchedule(schedule({ cpi: proof("cpi", { checkedAt: "2026-11-05T23:00:00+08:00" }) })), true);
  const badSchedules = [null, [], {}, { version: "1", sources: schedule().sources }, { ...schedule(), sources: [] },
    { ...schedule(), sources: { cpi: null } }, { ...schedule(), sources: { ...schedule().sources, other: null } },
    { ...schedule(), attemptedAt: "not a timestamp" }];
  const badRecords = [false, [], "unknown", {}, proof("cpi", { source: "https://example.com/cpi" }),
    proof("cpi", { error: {} }), proof("cpi", { period: "2026-13" }), proof("cpi", { period: "2026-1" }),
    proof("cpi", { period: ["2026-10"] }), proof("cpi", { period: null }), proof("cpi", { publishedAt: null }),
    proof("cpi", { period: null, publishedAt: null, error: null }), proof("cpi", { period: null, publishedAt: null, error: " " }),
    proof("cpi", { checkedAt: "2026-02-30T12:00:00Z" }), proof("cpi", { publishedAt: "2026-11-04" }),
    proof("cpi", { publishedAt: "2026-11-04T24:00:00Z" }), proof("cpi", { checkedAt: "2026-11-04T12:00:00Z" }),
    proof("cpi", { attemptedAt: {} }), proof("cpi", { attemptedAt: null }),
    proof("cpi", { period: "0000-01" }), proof("cpi", { period: "2026-12" }),
    proof("cpi", { attemptedAt: "2026-11-05T14:59:00Z" })];
  for (const value of badSchedules) assert.equal(isPublicationSchedule(value), false);
  for (const value of badRecords) assert.equal(isPublicationSchedule(schedule({ cpi: value })), false);
});

test("matching observations retain all indicators and report both official checks", () => {
  const input = indicators();
  const result = applyPublicationChecks(input, schedule(), now);
  assert.deepEqual(result.indicators, input);
  assert.deepEqual(result.checks.map((row) => [row.kind, row.status]), [["cpi", "current"], ["employment", "current"]]);
  assert.deepEqual(result.errors, []);
  assert.ok(result.checks.every((row) => row.period === "2026-10" && row.publishedAt === publishedAt && row.checkedAt === checkedAt && row.label && row.message));
});

test("FRED periods newer than a saved official lower bound remain valid and are disclosed", () => {
  const input = indicators({ inflation: { date: "2026-11-01" }, unemployment: { date: "2026-11-01" }, payrolls: { date: "2026-11-01" } });
  const result = applyPublicationChecks(input, schedule(), now);
  assert.deepEqual(disabled(result), []);
  assert.deepEqual(result.checks.map((row) => row.status), ["source-ahead", "source-ahead"]);
  assert.deepEqual(result.errors, []);
});

test("a lagging CPI common period disables all four inputs that depend on inflation", () => {
  const input = indicators({ inflation: { date: "2026-09-01" } });
  const result = applyPublicationChecks(input, schedule(), now);
  assert.deepEqual(disabled(result), ["fed", "inflation", "payrolls", "unemployment"]);
  assert.equal(result.checks[0].status, "lagging");
  assert.match(result.errors.join(" "), /CPI.*2026-10.*2026-09/);
  for (const row of result.indicators.filter((item) => !item.available)) {
    assert.equal(row.risk, null); assert.equal(row.points, null); assert.equal(row.status, "unavailable");
    assert.equal(row.unavailableReason, "官方新期待同步");
    assert.equal(row.value, `observed ${row.id}`); assert.equal(row.detail, "original source value");
    assert.equal(row.date, input.find((original) => original.id === row.id).date);
  }
});

test("employment checks distinguish UNRATE and PAYEMS and only propagate the affected dependencies", () => {
  const cases = [
    [{ unemployment: { date: "2026-09-01" } }, ["fed", "unemployment"]],
    [{ payrolls: { date: "2026-09-01" } }, ["fed", "payrolls"]],
    [{ unemployment: { date: "2026-09-01" }, payrolls: { date: "2026-09-01" } }, ["fed", "payrolls", "unemployment"]],
    [{ unemployment: { date: "2026-09-01" }, payrolls: { date: "2026-11-01" } }, ["fed", "unemployment"]],
  ];
  for (const [edits, expected] of cases) {
    const result = applyPublicationChecks(indicators(edits), schedule(), now);
    assert.deepEqual(disabled(result), expected);
    assert.equal(result.checks[1].status, "lagging");
  }
});

test("Sahm component metadata is not mistaken for the headline unemployment observation", () => {
  const input = indicators({ unemployment: { sahmDate: "2026-08-01", breakdown: [{ label: "Sahm", date: "2026-08-01" }] } });
  const result = applyPublicationChecks(input, schedule(), now);
  assert.deepEqual(disabled(result), []);
  assert.equal(result.checks[1].status, "current");
});

test("publication-based exclusions can pause the overall score below sixty percent coverage", () => {
  const input = indicators({ inflation: { date: "2026-09-01" }, earningsBreadth: { available: false, risk: null, points: null, status: "unavailable" } });
  const before = computeScores(input);
  const result = applyPublicationChecks(input, schedule(), now);
  const after = computeScores(result.indicators);
  assert.equal(before.coverage, 90); assert.ok(Number.isFinite(before.score));
  assert.equal(after.coverage, 57); assert.equal(after.score, null);
  assert.equal(actionFor(after.score, after.coverage).key, "unavailable");
});

test("future release timestamps, check timestamps and future reference months cannot remove existing scores", () => {
  const input = indicators({ inflation: { date: "2026-09-01" } });
  for (const record of [
    proof("cpi", { publishedAt: "2026-11-05T16:00:01Z", checkedAt: "2026-11-05T16:00:01Z" }),
    proof("cpi", { checkedAt: "2026-11-05T16:01:01Z" }),
    proof("cpi", { period: "2026-12", publishedAt: "2027-01-06T13:30:00Z", checkedAt: "2027-01-06T14:00:00Z" }),
  ]) {
    const result = applyPublicationChecks(input, schedule({ cpi: record }), now);
    assert.deepEqual(result.indicators, input);
    assert.equal(result.checks[0].status, "unavailable");
    assert.match(result.errors.join(" "), /未来/);
  }
  const atGrace = applyPublicationChecks(input, schedule({ cpi: proof("cpi", { checkedAt: "2026-11-05T16:01:00Z" }) }), now);
  assert.equal(atGrace.checks[0].status, "lagging");
});

test("unknown and malformed publication information is visible without silently excluding valid data", () => {
  const input = indicators({ inflation: { date: "2026-09-01" } });
  for (const value of [{}, [], { ...schedule(), version: 2 }, schedule({ cpi: proof("cpi", { period: {} }) })]) {
    const result = applyPublicationChecks(input, value, now);
    assert.deepEqual(result.indicators, input); assert.equal(result.checks.length, 2); assert.ok(result.errors.length > 0);
  }
  const empty = applyPublicationChecks(input, { version: 1, sources: { cpi: null, employment: null } }, now);
  assert.deepEqual(empty.indicators, input); assert.equal(empty.checks.length, 2); assert.equal(empty.errors.length, 2);
  const failed = applyPublicationChecks(input, schedule({ cpi: proof("cpi", { period: null, publishedAt: null, error: "request timed out" }) }), now);
  assert.deepEqual(failed.indicators, input); assert.match(failed.errors.join(" "), /request timed out/);
  for (const nowMs of [NaN, Infinity, 1e100, "2026-11-05"]) {
    const badClock = applyPublicationChecks(input, schedule(), nowMs);
    assert.deepEqual(badClock.indicators, input); assert.ok(badClock.errors.length > 0);
  }
});

test("a failed recheck preserves a previously confirmed official lower bound", () => {
  const input = indicators({ inflation: { date: "2026-09-01" } });
  const value = schedule({ cpi: proof("cpi", { error: "BLS temporarily unavailable", attemptedAt: "2026-11-05T15:59:00Z" }) });
  const result = applyPublicationChecks(input, value, now);
  assert.equal(result.checks[0].status, "lagging");
  assert.deepEqual(disabled(result), ["fed", "inflation", "payrolls", "unemployment"]);
  assert.equal(result.checks[0].checkedAt, checkedAt);
  assert.match(result.checks[0].message, /最后成功/);
  assert.match(result.errors.join(" "), /本次复核失败/);
  const current = applyPublicationChecks(indicators(), value, now);
  assert.equal(current.checks[0].status, "current"); assert.deepEqual(disabled(current), []);
  assert.ok(current.errors.some((message) => message.includes("BLS temporarily unavailable")));
});

test("unknown observation dates are not turned into lagging data, while known lag is still enforced", () => {
  const input = indicators({ inflation: { date: null }, unemployment: { date: "2026-02-30" } });
  const result = applyPublicationChecks(input, schedule(), now);
  assert.deepEqual(disabled(result), []); assert.ok(result.checks.every((row) => row.status === "unavailable"));
  const mixed = applyPublicationChecks(indicators({ unemployment: { date: null }, payrolls: { date: "2026-09-01" } }), schedule(), now);
  assert.deepEqual(disabled(mixed), ["fed", "payrolls"]); assert.equal(mixed.checks[1].status, "lagging");
});

test("old snapshots remain compatible, calls are idempotent, and frozen inputs are never mutated", () => {
  const input = indicators({ inflation: { date: "2026-09-01" } });
  for (const omitted of [undefined, null]) {
    const result = applyPublicationChecks(input, omitted, now);
    assert.equal(result.indicators, input); assert.deepEqual(result.checks, []); assert.deepEqual(result.errors, []);
  }
  const value = schedule(); const expectedInput = structuredClone(input); const expectedSchedule = structuredClone(value);
  function freeze(object) { if (object && typeof object === "object") { Object.values(object).forEach(freeze); Object.freeze(object); } return object; }
  freeze(input); freeze(value);
  const once = applyPublicationChecks(input, value, now);
  const twice = applyPublicationChecks(once.indicators, value, now);
  assert.deepEqual(twice, once); assert.deepEqual(input, expectedInput); assert.deepEqual(value, expectedSchedule);
});
