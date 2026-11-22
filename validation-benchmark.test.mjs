import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { projectDashboard } from "./public/dashboard-state.js";
import { equityCloseMinute } from "./public/us-equity-session.js";

const cli = fileURLToPath(new URL("./scripts/capture-evidence.mjs", import.meta.url));
const fixture = JSON.parse(await readFile(new URL("./dashboard-cache.json", import.meta.url)));
const firstAt = "2026-11-05T22:30:00Z";
const laterAt = "2026-12-18T22:30:00Z";
const full = ["observation_date,SP500"];
for (let ms = Date.parse("2026-11-04"); ms <= Date.parse("2026-12-18"); ms += 86_400_000) {
  const day = new Date(ms).toISOString().slice(0, 10);
  if (equityCloseMinute(day)) full.push(day + "," + (5000 + full.length));
}
async function replay(t) {
  const dir = await mkdtemp(path.join(tmpdir(), "radar-validation-benchmark-"));
  t.after(() => rm(dir, { force: true, recursive: true }));
  const summary = path.join(dir, "summary.json");
  const preload = path.join(dir, "replay.mjs");
  return async (at, csv, valid = true) => {
    const data = projectDashboard({ ...fixture, generatedAt: at }, Date.parse(at));
    Object.assign(data, { refreshing: false, validationReference: { series: "SP500", date: "2026-11-04", close: 5001 } });
    if (!valid) { for (const row of data.indicators) Object.assign(row, { available: false, risk: null }); Object.assign(data, { coverage: 0, score: null }); }
    await writeFile(preload, `const D=Date, n=D.parse(${JSON.stringify(at)}); globalThis.Date=class extends D {
      constructor(...a){ super(...(a.length?a:[n])); } static now(){return n;}
    };globalThis.fetch=async url => {
      if (String(url).includes("/api/dashboard")) return new Response(${JSON.stringify(JSON.stringify(data))});
      if (String(url).includes("/fredgraph.csv")) return new Response(${JSON.stringify(csv)},{status:${csv ? 200 : 503}});
      throw new Error("Unexpected test URL");
    };`);
    execFileSync(process.execPath, ["--import", preload, cli, "--url", "https://test.example/api/dashboard", "--attempts", "1",
      "--output-dir", path.join(dir, "records"), "--summary", summary, "--ledger-output", path.join(dir, "ledger.json")], { timeout: 10_000 });
    return JSON.parse(await readFile(summary));
  };
}

test("a truncated or mislabeled successful response cannot erase a previously verified forward outcome", async (t) => {
  const run = await replay(t);
  await run(firstAt, full.slice(0, 3).join("\n"));
  const good = await run(laterAt, full.join("\n"));
  assert.equal(good.outcomes[0].samples, 1);
  assert.equal(good.benchmark.error, null);
  for (const csv of [full.slice(0, 2).join("\n"), full.join("\n").replace("SP500", "VIXCLS"),
    [full[0], ...full.slice(-5)].join("\n")]) {
    const bad = await run(laterAt, csv);
    assert.equal(bad.retainedResults, true);
    assert.ok(bad.benchmark.error);
    assert.equal(bad.evaluatedAt, good.evaluatedAt);
    assert.deepEqual(bad.outcomes[0].outcomes, good.outcomes[0].outcomes);
  }
  const revised = await run(laterAt, full.join("\n").replace(/2026-11-06,\d+/, "2026-11-06,5100"));
  assert.equal(revised.retainedResults, false);
  assert.equal(revised.benchmark.error, null);
  assert.notEqual(revised.outcomes[0].meanReturnPercent, good.outcomes[0].meanReturnPercent);
  const missing = await run("2026-12-21T22:30:00Z", "", false);
  assert.equal(missing.observedSamples, 3);
  assert.ok(missing.outcomes.every(row => row.unavailableScoreSamples === 1));
  const added = await run("2026-12-22T22:30:00Z", "");
  assert.equal(added.observedSamples, 4);
  assert.ok(added.outcomes.every(row => row.unknownSamples === 1
    && row.samples + row.immatureSamples + row.unavailableScoreSamples + row.unknownSamples === added.observedSamples));
});

test("repeated first-ever benchmark outages cannot be presented as retained successful evaluations", async (t) => {
  const run = await replay(t);
  for (let i = 0; i < 2; i++) {
    const summary = await run(firstAt, "");
    assert.equal(summary.retainedResults, false);
    assert.equal(summary.evaluatedAt, null);
    assert.ok(summary.benchmark.error);
    assert.ok(summary.outcomes.every(h => !h.immatureSamples && h.unknownSamples === 1));
  }
});
