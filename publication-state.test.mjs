import test from "node:test";
import assert from "node:assert/strict";
import { PUBLICATION_SOURCES, isPublicationSchedule, applyPublicationChecks } from "./public/publication-state.js";
import { computeScores, actionFor, INDICATOR_WEIGHTS } from "./public/risk-model.js";

const now = Date.parse("2026-11-05T16:00:00Z");
const checkedAt = "2026-11-05T15:00:00Z";
const publishedAt = "2026-11-04T13:30:00Z";
function proof(kind, edits = {}) {
  return { period: "2026-10", publishedAt, checkedAt, source: PUBLICATION_SOURCES[kind], error: null,
    ...(kind === "pce" ? { releaseUrl: "https://www.bea.gov/news/2026/personal-income-and-outlays-october-2026" } : {}), ...edits };
}
function schedule(edits = {}) {
  return { version: 1, sources: { cpi: proof("cpi"), employment: proof("employment"), pce: proof("pce"), ...edits } };
}
function indicators(edits = {}) {
  return Object.entries(INDICATOR_WEIGHTS).map(([id, weight]) => ({
    id, title: id, weight, date: "2026-10-01", risk: 40, points: weight * 0.4,
    ...(id === "inflation" ? { inputDates: { headlinePce: "2026-10-01", corePce: "2026-10-01" } } : {}),
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

test("matching observations retain all indicators and report all three official checks", () => {
  const input = indicators();
  const result = applyPublicationChecks(input, schedule(), now);
  assert.deepEqual(result.indicators, input);
  assert.deepEqual(result.checks.map((row) => [row.kind, row.status]), [["cpi", "current"], ["employment", "current"], ["pce", "current"]]);
  assert.deepEqual(result.errors, []);
  assert.ok(result.checks.every((row) => row.period === "2026-10" && row.publishedAt === publishedAt && row.checkedAt === checkedAt && row.label && row.message));
});

test("FRED periods newer than a saved official lower bound remain valid and are disclosed", () => {
  const input = indicators({ inflation: { date: "2026-11-01", inputDates: { corePce: "2026-11-01" } }, unemployment: { date: "2026-11-01" }, payrolls: { date: "2026-11-01" } });
  const result = applyPublicationChecks(input, schedule(), now);
  assert.deepEqual(disabled(result), []);
  assert.deepEqual(result.checks.map((row) => row.status), ["source-ahead", "source-ahead", "source-ahead"]);
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
    assert.deepEqual(result.indicators, input); assert.equal(result.checks.length, 3); assert.ok(result.errors.length > 0);
  }
  const empty = applyPublicationChecks(input, { version: 1, sources: { cpi: null, employment: null } }, now);
  assert.deepEqual(empty.indicators, input); assert.equal(empty.checks.length, 3); assert.equal(empty.errors.length, 3);
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
  assert.deepEqual(disabled(result), []); assert.ok(result.checks.slice(0, 2).every((row) => row.status === "unavailable"));
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

test("PCE sources extend version one while preserving old two-source schedules", () => {
  assert.equal(PUBLICATION_SOURCES.pce, "https://www.bea.gov/data/personal-consumption-expenditures-price-index");
  const legacy = { version: 1, sources: { cpi: proof("cpi"), employment: proof("employment") } };
  for (const value of [legacy, schedule(), schedule({ pce: null })]) assert.equal(isPublicationSchedule(value), true);
  for (const sources of [{ pce: proof("pce") }, { cpi: null, pce: null }, { employment: null, pce: null },
    { ...schedule().sources, extra: null }]) assert.equal(isPublicationSchedule({ version: 1, sources }), false);
  const failed = proof("pce", { period: null, publishedAt: null, error: "BEA unavailable" });
  delete failed.releaseUrl;
  assert.equal(isPublicationSchedule(schedule({ pce: failed })), true);
  const result = applyPublicationChecks(indicators(), legacy, now);
  assert.deepEqual(disabled(result), []);
  assert.equal(result.checks.find((row) => row.kind === "pce").status, "unavailable");
  assert.match(result.errors.join(" "), /PCE.*尚未核实/);
  const inherited = { version: 1, sources: Object.assign(Object.create({ pce: proof("pce") }), legacy.sources) };
  assert.equal(applyPublicationChecks(indicators(), inherited, now).checks.find((row) => row.kind === "pce").status, "unavailable");
});

test("PCE proof links require the exact BEA dated route, matching report period and New York publication year", () => {
  const valid = proof("pce");
  assert.equal(isPublicationSchedule(schedule({ pce: valid })), true);
  const inheritedUrl = Object.assign(Object.create({ releaseUrl: valid.releaseUrl }), valid); delete inheritedUrl.releaseUrl;
  assert.equal(isPublicationSchedule(schedule({ pce: inheritedUrl })), false);
  const crossYear = proof("pce", { period: "2026-12", publishedAt: "2027-01-29T13:30:00Z", checkedAt: "2027-01-29T14:00:00Z",
    releaseUrl: "https://www.bea.gov/news/2027/personal-income-and-outlays-december-2026" });
  assert.equal(isPublicationSchedule(schedule({ pce: crossYear })), true);
  const nyYear = proof("pce", { period: "2026-12", publishedAt: "2027-01-01T00:30:00Z", checkedAt: "2027-01-01T01:00:00Z",
    releaseUrl: "https://www.bea.gov/news/2026/personal-income-and-outlays-december-2026" });
  assert.equal(isPublicationSchedule(schedule({ pce: nyYear })), true);
  const badUrls = [undefined, null, {}, "https://example.com/news/2026/personal-income-and-outlays-october-2026",
    "http://www.bea.gov/news/2026/personal-income-and-outlays-october-2026",
    "https://bea.gov/news/2026/personal-income-and-outlays-october-2026",
    "https://www.bea.gov.evil.test/news/2026/personal-income-and-outlays-october-2026",
    "https://www.bea.gov@evil.test/news/2026/personal-income-and-outlays-october-2026",
    "https://www.bea.gov/news/2026/personal-income-and-outlays-october-2026/",
    "https://www.bea.gov/news/2026/personal-income-and-outlays-october-2026?x=1",
    "https://www.bea.gov/news/2026/personal-income-and-outlays-october-2026#data",
    "https://www.bea.gov/news/2026/personal-income-and-outlays-oct-2026",
    "https://www.bea.gov/news/2026/personal-income-and-outlays-OCTOBER-2026",
    "https://www.bea.gov/news/2026/personal-income-and-outlays-september-2026",
    "https://www.bea.gov/news/2026/personal-income-and-outlays-october-2025",
    "https://www.bea.gov/news/2025/personal-income-and-outlays-october-2026",
    "https://www.bea.gov/news/2026/personal-income-and-outlays-%6fctober-2026"];
  for (const releaseUrl of badUrls) assert.equal(isPublicationSchedule(schedule({ pce: proof("pce", { releaseUrl }) })), false, String(releaseUrl));
  assert.equal(isPublicationSchedule(schedule({ pce: { ...nyYear, releaseUrl: "https://www.bea.gov/news/2027/personal-income-and-outlays-december-2026" } })), false);
  const failed = proof("pce", { period: null, publishedAt: null, error: "offline", releaseUrl: "https://evil.test/release" });
  assert.equal(isPublicationSchedule(schedule({ pce: failed })), false);
});

test("a lagging core PCE input removes its four true dependencies and can pause the aggregate score", () => {
  const input = indicators({ inflation: { inputDates: { headlinePce: "2026-10-01", corePce: "2026-09-01" } },
    earningsBreadth: { available: false, risk: null, points: null, status: "unavailable" } });
  const original = structuredClone(input);
  const result = applyPublicationChecks(input, schedule(), now);
  const check = result.checks.find((row) => row.kind === "pce");
  assert.equal(check.status, "lagging");
  assert.equal(check.releaseUrl, proof("pce").releaseUrl);
  assert.match(result.errors.join(" "), /PCE.*核心 PCE.*2026-09/);
  assert.deepEqual(disabled(result), ["earningsBreadth", "fed", "inflation", "payrolls", "unemployment"]);
  assert.equal(computeScores(input).coverage, 90);
  const model = computeScores(result.indicators);
  assert.equal(model.coverage, 57); assert.equal(model.score, null);
  assert.deepEqual(input, original);
  assert.deepEqual(applyPublicationChecks(result.indicators, schedule(), now), result);
  for (const row of result.indicators.filter((item) => !item.available && item.id !== "earningsBreadth")) {
    assert.equal(row.risk, null); assert.equal(row.points, null);
    assert.equal(row.value, original.find((item) => item.id === row.id).value);
    assert.equal(row.detail, original.find((item) => item.id === row.id).detail);
  }
});

test("headline PCE dates do not create false scoring dependencies and core PCE dates outrank legacy display text", () => {
  const input = indicators({ inflation: { inputDates: { headlinePce: "2026-08-01", corePce: "2026-10-01" },
    breakdown: [{ label: "核心 PCE", detail: "2026 年 8 月 · 三个月年化" }] } });
  const result = applyPublicationChecks(input, schedule(), now);
  assert.deepEqual(disabled(result), []);
  assert.equal(result.checks.find((row) => row.kind === "pce").status, "current");
  const ahead = applyPublicationChecks(indicators({ inflation: { inputDates: { corePce: "2026-11-01", headlinePce: null } } }), schedule(), now);
  assert.deepEqual(disabled(ahead), []);
  assert.equal(ahead.checks.find((row) => row.kind === "pce").status, "source-ahead");
});

test("only a unique strict legacy core PCE month may replace an absent structured date", () => {
  for (const detail of ["2026 年 9 月", "2026 年 09 月 · 三个月年化 3.0%", "2026 年 9 月 ·"] ) {
    const result = applyPublicationChecks(indicators({ inflation: { inputDates: {}, breakdown: [{ label: "核心 PCE", detail }] } }), schedule(), now);
    assert.equal(result.checks.find((row) => row.kind === "pce").status, "lagging", detail);
    assert.deepEqual(disabled(result), ["fed", "inflation", "payrolls", "unemployment"]);
  }
  const withoutInputDates = indicators(); delete withoutInputDates.find((row) => row.id === "inflation").inputDates;
  withoutInputDates.find((row) => row.id === "inflation").breakdown = [{ label: "核心 PCE", detail: "2026 年 9 月" }];
  assert.equal(applyPublicationChecks(withoutInputDates, schedule(), now).checks.find((row) => row.kind === "pce").status, "lagging");
  const cases = [
    { inputDates: { corePce: null }, breakdown: [{ label: "核心 PCE", detail: "2026 年 9 月" }] },
    { inputDates: null, breakdown: [{ label: "核心 PCE", detail: "2026 年 9 月" }] },
    { inputDates: { corePce: "invalid" }, breakdown: [{ label: "核心 PCE", detail: "2026 年 9 月" }] },
    { inputDates: { corePce: "2026-02-30" }, breakdown: [{ label: "核心 PCE", detail: "2026 年 9 月" }] },
    { inputDates: {}, breakdown: [{ label: "核心 PCE", detail: "2026 年 9 月" }, { label: "核心 PCE", detail: "2026 年 9 月" }] },
    { inputDates: {}, breakdown: [{ label: "整体 PCE", detail: "2026 年 9 月" }] },
    ...["2026 年 13 月", "1899 年 9 月", "2026 年 0 月", "资料截至 2026 年 9 月", "2026 年 9 月 extra", "2026 年 9 月·three", "2026 年 9 月 ·three\nextra", "2026-09"].map((detail) => ({ inputDates: {}, breakdown: [{ label: "核心 PCE", detail }] })),
  ];
  for (const edits of cases) {
    const result = applyPublicationChecks(indicators({ inflation: edits }), schedule(), now);
    assert.deepEqual(disabled(result), [], JSON.stringify(edits));
    const check = result.checks.find((row) => row.kind === "pce");
    assert.equal(check.status, "unavailable"); assert.match(check.message, /未知日期不作为额外剔除依据/);
  }
});

test("PCE unknown and future evidence stays non-destructive, while a failed recheck keeps its known lower bound", () => {
  const input = indicators({ inflation: { inputDates: { corePce: "2026-09-01" } } });
  const failedWithoutProof = proof("pce", { period: null, publishedAt: null, error: "BEA offline" }); delete failedWithoutProof.releaseUrl;
  for (const pce of [null, failedWithoutProof,
    proof("pce", { publishedAt: "2026-11-05T16:00:01Z", checkedAt: "2026-11-05T16:00:01Z" }),
    proof("pce", { checkedAt: "2026-11-05T16:01:01Z" }),
    proof("pce", { period: "2026-12", publishedAt: "2027-01-29T13:30:00Z", checkedAt: "2027-01-29T14:00:00Z",
      releaseUrl: "https://www.bea.gov/news/2027/personal-income-and-outlays-december-2026" }),
  ]) {
    const result = applyPublicationChecks(input, schedule({ pce }), now);
    assert.deepEqual(disabled(result), []); assert.equal(result.checks.find((row) => row.kind === "pce").status, "unavailable");
  }
  const pce = proof("pce", { error: "BEA offline", attemptedAt: "2026-11-05T15:59:00Z" });
  const result = applyPublicationChecks(input, schedule({ pce }), now);
  const check = result.checks.find((row) => row.kind === "pce");
  assert.deepEqual(disabled(result), ["fed", "inflation", "payrolls", "unemployment"]);
  assert.equal(check.checkedAt, checkedAt); assert.match(check.message, /本次复核失败/); assert.match(result.errors.join(" "), /BEA offline/);
});
