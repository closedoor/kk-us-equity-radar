import test from "node:test";
import { createHash } from "node:crypto";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { mkdtemp, readFile, writeFile, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { execFile } from "node:child_process";
import { createEvidence, evaluateEvidence as evaluate, isEvidence } from "./validation-evidence.mjs";
import { projectDashboard } from "./public/dashboard-state.js";
import { hydrateSourceLedger, updateSourceLedger } from "./source-revisions.mjs";

const capturedAt = "2026-11-05T22:30:00.000Z";
function frozenClock(at) {
  return `const NativeDate = Date, fixed = NativeDate.parse(${JSON.stringify(at)});
    globalThis.Date = class extends NativeDate { constructor(...args) { super(...(args.length ? args : [fixed])); } static now() { return fixed; } };\n`;
}
const evaluateEvidence = (records, prices, options = {}) => evaluate(records, prices, { asOf: "2026-12-01T00:00:00.000Z", ...options });
function snapshot() {
  const fixture = JSON.parse(readFileSync(new URL("./dashboard-cache.json", import.meta.url)));
  const result = projectDashboard({ ...fixture, generatedAt: capturedAt }, Date.parse(capturedAt));
  return { ...result, refreshing: false, validationReference: { series: "SP500", date: "2026-11-04", close: 5000 } };
}
const capture = (data = snapshot(), time = capturedAt) => createEvidence(data, { capturedAt: time, source: "https://kk-us-equity-radar.onrender.com/api/dashboard" });

test("evidence preserves actual observation time, numeric reference and a tamper-detecting hash", () => {
  const data = snapshot();
  const record = capture(data);
  assert.equal(record.observationDate, "2026-11-05");
  assert.equal(record.marketReference.close, 5000);
  assert.equal(record.marketReference.date, "2026-11-04");
  assert.equal(isEvidence(record), true);
  record.score = 99;
  assert.equal(isEvidence(record), false);
  assert.equal(data.validationReference.close, 5000);
});

test("unpublished, expired, manual and unfinished observations cannot enter automatic evidence", () => {
  for (const change of [
    data => { data.refreshing = true; },
    data => { data.generatedAt = "2026-11-04T22:30:00.000Z"; },
    data => { data.generatedAt = "2026-11-05T23:30:00.000Z"; },
    data => { data.indicators[0].overridden = true; },
    data => { data.indicators[0].confidence = "manual"; },
    data => { data.validationReference.date = "2026-11-06"; },
    data => { delete data.validationReference; },
    data => { data.validationReference.close = 0; },
    data => { data.validationReference.date = "2026-11-01"; }, // Sunday cannot have a cash index close
    data => { data.indicators.find(row => row.available).date = null; },
  ]) {
    const data = snapshot(); change(data);
    assert.throws(() => capture(data));
  }
});

test("an unavailable manual-data placeholder remains a valid automatic sample", () => {
  const data = snapshot();
  const row = data.indicators.find(row => row.id === "earningsBreadth");
  assert.equal(row.available, false);
  row.confidence = "manual";
  assert.equal(isEvidence(capture(data)), true);
});

const prices = [
  ["2026-11-04", 80], ["2026-11-05", 90], ["2026-11-06", 100],
  ["2026-11-09", 120], ["2026-11-10", 90], ["2026-11-11", 110],
].map(([date, value]) => ({ date, value }));

test("evaluation starts after capture and counts actual price observations, excluding a stale reference close", () => {
  const result = evaluateEvidence([capture()], prices, { horizons: [2] });
  const outcome = result.outcomes[0].outcomes[0];
  assert.equal(outcome.entryDate, "2026-11-06");
  assert.equal(outcome.exitDate, "2026-11-10");
  assert.ok(Math.abs(outcome.returnPercent + 10) < 1e-9);
  assert.equal(outcome.drawdownPercent, 25);
});

test("unmatured outcomes stay unknown and do not become zero-return successes", () => {
  const result = evaluateEvidence([capture()], prices, { horizons: [21, 63] });
  assert.equal(result.status, "awaiting-outcomes");
  assert.equal(result.observedSamples, 1);
  for (const row of result.outcomes) {
    assert.equal(row.samples, 0);
    assert.equal(row.immatureSamples, 1);
    assert.equal(row.meanReturnPercent, null);
    assert.equal(row.worstDrawdownPercent, null);
  }
});

test("future prices and future capture timestamps cannot fabricate mature outcomes", () => {
  assert.throws(() => evaluate([capture()], prices, { horizons: [2], asOf: "2026-11-05T23:00:00.000Z" }), /Future benchmark/);
  assert.throws(() => evaluate([capture()], [], { asOf: "2026-11-05T20:00:00.000Z" }), /Future evidence/);
});

test("an inconsistent score cannot become the first immutable observation", () => {
  const data = snapshot();
  assert.ok(Number.isFinite(data.score) && data.score !== 99);
  for (const score of [99, null, "unavailable"]) assert.throws(() => capture({ ...data, score }), /Inconsistent/);
  assert.throws(() => capture({ ...data, scoringVersion: "9.0.0" }), /Unsupported/);
  const { sha256, ...tampered } = capture(data);
  tampered.score = 99;
  assert.equal(isEvidence({ ...tampered, sha256: createHash("sha256").update(JSON.stringify(tampered)).digest("hex") }), false);
});

test("inconsistent coverage cannot be persisted as immutable evidence", () => {
  const data = snapshot();
  data.coverage += 1;
  assert.throws(() => capture(data), /Inconsistent/);
});

test("duplicate dates cannot inflate samples and conflicting benchmark values are rejected", () => {
  const record = capture();
  assert.equal(evaluateEvidence([record, record], [...prices, prices[2]], { horizons: [1] }).observedSamples, 1);
  assert.throws(() => evaluateEvidence([record], [...prices, { ...prices[2], value: 101 }]), /Conflicting/);
});

test("model versions are identified and cannot silently be pooled when a version is selected", () => {
  const { sha256, ...legacy } = capture();
  delete legacy.scoringContext;
  legacy.scoringVersion = "4.6.0";
  const other = { ...legacy, sha256: createHash("sha256").update(JSON.stringify(legacy)).digest("hex") };
  const result = evaluateEvidence([capture(), other], prices, { horizons: [1], scoringVersion: "4.7.0" });
  assert.deepEqual(result.scoringVersions, ["4.7.0"]);
  assert.equal(result.observedSamples, 1);
  assert.throws(() => evaluateEvidence([capture(), other], prices), /Select one/);
});

test("New York dates around UTC midnight and DST determine the observation day", () => {
  const data = snapshot();
  data.generatedAt = "2026-11-06T01:00:00.000Z";
  assert.equal(capture(data, data.generatedAt).observationDate, "2026-11-05");
  data.generatedAt = "2026-03-10T03:59:00.000Z";
  data.validationReference.date = "2026-03-06";
  data.indicators.forEach(row => { if (row.date > "2026-03-08") row.date = "2026-03-06"; });
  assert.equal(capture(data, data.generatedAt).observationDate, "2026-03-09");
});

test("new captures require an actual completed NYSE session, including the half-day close", () => {
  for (const at of ["2026-11-21T23:00:00Z", "2026-11-26T22:30:00Z", "2026-11-25T20:59:59Z", "2026-11-27T17:59:59Z", "2029-01-09T22:00:00Z"]) {
    const data = snapshot(); data.generatedAt = at;
    assert.throws(() => capture(data, at), /session|calendar/i, at);
  }
  const data = snapshot();
  data.generatedAt = "2026-11-27T18:00:00Z";
  const record = capture(data, data.generatedAt);
  assert.equal(record.capturePolicy, "nyse-post-close-v1");
  assert.equal(isEvidence(record), true);
  data.generatedAt = "2026-11-27T17:59:59Z";
  assert.throws(() => capture(data, "2026-11-27T18:10:00Z"), /snapshot.*close/i);
  data.generatedAt = "2026-11-24T22:15:00Z";
  assert.throws(() => capture(data, "2026-11-25T21:30:00Z"), /snapshot.*close/i);
  const old = JSON.parse(readFileSync(new URL("./evidence/forward/2026-11-05_model-4.7.0.json", import.meta.url)));
  assert.equal(isEvidence(old), true, "genuine prior-cadence observation remains readable");
});

test("missing expected entry, interior or exit closes cannot shift the horizon to a later date", () => {
  for (const missing of ["2026-11-06", "2026-11-09", "2026-11-10"]) {
    const m = evaluateEvidence([capture()], prices.filter(row => row.date !== missing), { horizons: [2] }).outcomes[0];
    assert.equal(m.samples, 0, missing);
    assert.equal(m.incompleteBenchmarkSamples, 1, missing);
    assert.equal(m.immatureSamples, 0, missing);
    assert.equal(m.meanReturnPercent, null, missing);
  }
});

test("Thanksgiving is excluded and an early-close benchmark is not known at 12:59 NY time", () => {
  const data = snapshot();
  const at = "2026-11-24T22:30:00Z"; data.generatedAt = at;
  const record = capture(data, at);
  const pts = [{date:"2026-11-25",value:100}, {date:"2026-11-27",value:90}];
  const before = (rows, time) => evaluate([record], rows, {horizons:[1],asOf:time}).outcomes[0];
  assert.throws(() => before(pts, "2026-11-27T17:59:59Z"), /close|future/i);
  assert.equal(before(pts.slice(0,1), "2026-11-27T17:59:59Z").immatureSamples, 1);
  assert.equal(before(pts, "2026-11-27T18:00:00Z").outcomes[0].exitDate, "2026-11-27");
  assert.throws(() => before([...pts,{date:"2026-11-26",value:130}], "2026-11-27T18:01:00Z"), /session|closed/i);
});

test("insufficient coverage remains unavailable instead of being evaluated as a calm score", () => {
  const data = snapshot();
  data.indicators.forEach(row => { row.available = false; row.risk = null; row.points = null; });
  data.coverage = 0; data.score = null;
  const result = evaluateEvidence([capture(data)], prices, { horizons: [1] });
  assert.equal(result.outcomes[0].samples, 0);
  assert.equal(result.outcomes[0].unavailableScoreSamples, 1);
});

test("a missing market reference is recorded explicitly without excluding a real source-outage day", () => {
  const data = snapshot();
  data.validationReference = null;
  const record = capture(data);
  assert.equal(isEvidence(record), true);
  assert.equal(record.marketReference, null);
});

test("a holiday or pre-close CLI invocation skips without fetching or writing any files", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "radar-closed-capture-"));
  try {
    const preload = path.join(dir, "clock.mjs");
    const args = ["--import", preload, new URL("./scripts/capture-evidence.mjs", import.meta.url).pathname,
      "--attempts", "1", "--output-dir", path.join(dir, "records"), "--summary", path.join(dir, "summary.json"), "--ledger-output", path.join(dir, "seed.json")];
    for (const [time, date, reason] of [
      ["2026-11-26T22:30:00Z", "2026-11-26", "closed-session"],
      ["2026-11-27T17:59:59Z", "2026-11-27", "before-session-close"],
      ["2026-11-21T22:30:00Z", "2026-11-21", "closed-session"],
    ]) {
      await writeFile(preload, frozenClock(time) + "globalThis.fetch = () => { throw Error('No network permitted'); };");
      const { stdout } = await promisify(execFile)(process.execPath, args, { timeout: 5000 });
      assert.deepEqual(JSON.parse(stdout), { saved: false, skipped: reason, observationDate: date });
      assert.deepEqual(await readdir(dir), ["clock.mjs"]);
    }
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test("the capture CLI preserves its first immutable daily record across repeated runs", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "radar-evidence-cli-"));
  try {
    const data = snapshot();
    data.generatedAt = capturedAt;
    data.sourceLedger = hydrateSourceLedger({ version: 1, sources: { PAYEMS: { checkedAt: data.generatedAt,
      points: [{ date: "2026-09-01", value: 150000 }] } }, revisions: [] });
    const preload = path.join(dir, "fetch.mjs");
    await writeFile(preload, frozenClock(capturedAt) + `globalThis.fetch = async url => {
      if (String(url).includes('/api/dashboard')) return new Response(${JSON.stringify(JSON.stringify(data))});
      if (String(url).includes('/fredgraph.csv')) return new Response('observation_date,SP500\\n2026-11-04,5000');
      throw Error('Unexpected test network request');
    };`);
    const args = ["--import", preload, new URL("./scripts/capture-evidence.mjs", import.meta.url).pathname,
      "--url", "https://unit.test/api/dashboard", "--attempts", "1", "--output-dir", path.join(dir, "records"), "--summary", path.join(dir, "summary.json"), "--ledger-output", path.join(dir, "seed.json")];
    const run = () => promisify(execFile)(process.execPath, args, { timeout: 10000 });
    const first = JSON.parse((await run()).stdout);
    assert.equal(first.saved, true);
    assert.equal(first.ledgerSaved, true);
    const names = await readdir(path.join(dir, "records"));
    assert.equal(names.length, 1);
    const file = path.join(dir, "records", names[0]);
    const contents = await readFile(file, "utf8");
    const second = JSON.parse((await run()).stdout);
    assert.equal(second.saved, false);
    assert.equal(await readFile(file, "utf8"), contents);
    const summary = JSON.parse(await readFile(path.join(dir, "summary.json"), "utf8"));
    assert.equal(summary.observedSamples, 1);
    assert.equal(summary.outcomes[0].samples, 0);
    data.sourceLedger = updateSourceLedger(data.sourceLedger, { PAYEMS: [{ date: "2026-09-01", value: 150010 }] }, "2026-11-05T22:30:01.000Z").ledger;
    await writeFile(preload, frozenClock("2026-11-05T22:30:02.000Z") + `globalThis.fetch = async url => {
      if (String(url).includes('/api/dashboard')) return new Response(${JSON.stringify(JSON.stringify(data))});
      throw Error('test benchmark outage');
    };`);
    await run();
    const failedSummary = JSON.parse(await readFile(path.join(dir, "summary.json"), "utf8"));
    assert.equal(failedSummary.retainedResults, true);
    assert.equal(failedSummary.evaluatedAt, summary.evaluatedAt);
    assert.deepEqual(failedSummary.outcomes, summary.outcomes);
    assert.match(failedSummary.benchmark.error, /benchmark outage/);
    assert.equal(await readFile(file, "utf8"), contents);
    const checkpoint = JSON.parse(await readFile(path.join(dir, "seed.json"), "utf8"));
    assert.equal(checkpoint.sources.PAYEMS.points[0].value, 150010);
    assert.equal(checkpoint.revisions.length, 1);
  } finally { await rm(dir, { recursive: true, force: true }); }
});
