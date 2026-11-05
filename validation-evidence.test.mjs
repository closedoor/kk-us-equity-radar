import test from "node:test";
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
  const data = snapshot();
  data.scoringVersion = "4.8.0";
  const result = evaluateEvidence([capture(), capture(data)], prices, { horizons: [1], scoringVersion: "4.7.0" });
  assert.deepEqual(result.scoringVersions, ["4.7.0"]);
  assert.equal(result.observedSamples, 1);
  assert.throws(() => evaluateEvidence([capture(), capture(data)], prices), /Select one/);
});

test("New York dates around UTC midnight and DST determine the observation day", () => {
  const data = snapshot();
  data.generatedAt = "2026-11-06T01:00:00.000Z";
  assert.equal(capture(data, data.generatedAt).observationDate, "2026-11-05");
  data.generatedAt = "2026-03-09T03:59:00.000Z";
  data.validationReference.date = "2026-03-06";
  data.indicators.forEach(row => { if (row.date > "2026-03-08") row.date = "2026-03-06"; });
  assert.equal(capture(data, data.generatedAt).observationDate, "2026-03-08");
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

test("the capture CLI preserves its first immutable daily record across repeated runs", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "radar-evidence-cli-"));
  try {
    const data = snapshot();
    data.generatedAt = new Date().toISOString();
    data.sourceLedger = hydrateSourceLedger({ version: 1, sources: { PAYEMS: { checkedAt: data.generatedAt,
      points: [{ date: "2026-09-01", value: 150000 }] } }, revisions: [] });
    const preload = path.join(dir, "fetch.mjs");
    await writeFile(preload, `globalThis.fetch = async url => {
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
    data.sourceLedger = updateSourceLedger(data.sourceLedger, { PAYEMS: [{ date: "2026-09-01", value: 150010 }] }, new Date().toISOString()).ledger;
    await writeFile(preload, `globalThis.fetch = async url => {
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
