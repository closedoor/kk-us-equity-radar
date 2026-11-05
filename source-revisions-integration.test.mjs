import test from "node:test";
import assert from "node:assert/strict";
import { cp, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { once } from "node:events";
import { spawn } from "node:child_process";
import { isDashboardSnapshot } from "./public/dashboard-state.js";
import { updateSourceLedger } from "./source-revisions.mjs";

const project = new URL("./", import.meta.url);
const clock = "2026-11-05T16:00:00.000Z";
const cachedAt = "2026-11-05T15:55:00.000Z";
const firstDetectedAt = "2026-11-05T15:00:00.000Z";
const sample = JSON.parse(await readFile(new URL("dashboard-cache.json", project), "utf8"));
let seed = updateSourceLedger(null, { PAYEMS: [{ date: "2026-09-01", value: 159044.123456 }] }, "2026-11-04T15:00:00.000Z").ledger;
seed = updateSourceLedger(seed, { PAYEMS: [{ date: "2026-09-01", value: 159045.123457 }] }, firstDetectedAt).ledger;

const preload = `
  import http from "node:http";
  const ActualDate = Date;
  globalThis.Date = class extends ActualDate {
    constructor(...args) { super(...(args.length ? args : [${JSON.stringify(clock)}])); }
    static now() { return ActualDate.parse(${JSON.stringify(clock)}); }
  };
  const listen = http.Server.prototype.listen;
  http.Server.prototype.listen = function (...args) {
    this.once("listening", () => process.send({ type: "listening", port: this.address().port }));
    return listen.apply(this, args);
  };
  // Every provider remains pending. Seed restoration must precede all refreshes.
  globalThis.fetch = (_url, { signal }) => new Promise((_resolve, reject) => {
    signal.addEventListener("abort", () => reject(new Error("test held upstream")), { once: true });
  });
`;
const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function withSeed(saved, check, { editCache = () => {}, scoreAvailable = true } = {}) {
  const dir = await mkdtemp(path.join(tmpdir(), "radar-source-seed-integration-"));
  let child;
  try {
    for (const entry of await readdir(project, { withFileTypes: true })) {
      if (entry.isFile() && entry.name.endsWith(".mjs") && !entry.name.endsWith(".test.mjs")) {
        await cp(new URL(entry.name, project), path.join(dir, entry.name));
      }
    }
    for (const name of ["public", "package.json"]) await cp(new URL(name, project), path.join(dir, name), { recursive: true });
    const cache = { ...structuredClone(sample), generatedAt: cachedAt, dataQualityVersion: 1, errors: [] };
    delete cache.sourceLedger;
    editCache(cache);
    assert.equal(isDashboardSnapshot(cache), true);
    await writeFile(path.join(dir, "dashboard-cache.json"), JSON.stringify(cache));
    await mkdir(path.join(dir, "evidence"));
    await writeFile(path.join(dir, "evidence/source-ledger.json"), typeof saved === "string" ? saved : JSON.stringify(saved));
    const preloadFile = path.join(dir, "held.mjs");
    await writeFile(preloadFile, preload);
    child = spawn(process.execPath, ["--import", preloadFile, path.join(dir, "server.mjs")], {
      cwd: dir, env: { ...process.env, HOST: "127.0.0.1", PORT: "0" }, stdio: ["ignore", "pipe", "pipe", "ipc"],
    });
    let listening;
    let output = "";
    child.stdout.on("data", (chunk) => { output += chunk; });
    child.stderr.on("data", (chunk) => { output += chunk; });
    child.on("message", (message) => { if (message.type === "listening") listening = message; });
    const deadline = Date.now() + 8000;
    while (!listening && Date.now() < deadline && child.exitCode === null) await pause(10);
    assert.ok(listening, `Isolated server did not listen: ${output}`);
    const read = async (query = "") => {
      const response = await fetch(`http://127.0.0.1:${listening.port}/api/dashboard${query}`, { signal: AbortSignal.timeout(2000) });
      assert.equal(response.status, 200);
      const body = await response.json();
      assert.equal(isDashboardSnapshot(body), true);
      assert.equal(body.generatedAt, cachedAt, "No pending provider may replace the existing board");
      assert.equal(body.refreshing, true);
      assert.equal(body.indicators.length, 12);
      if (scoreAvailable) assert.ok(Number.isFinite(body.score), "Ignoring a bad seed must not invalidate the market board");
      else assert.equal(body.score, null, "Restored publication proof must pause obsolete dependencies");
      return body;
    };
    await check(read);
  } finally {
    if (child && child.exitCode === null && child.signalCode === null) {
      const exited = once(child, "exit"); child.kill("SIGTERM"); await exited;
    }
    await rm(dir, { recursive: true, force: true });
  }
}

test("a fresh deployment restores raw source baselines and revision times from the repository seed before refresh", async () => {
  await withSeed(seed, async (read) => {
    const normal = await read();
    assert.equal(Object.hasOwn(normal, "sourceLedger"), false);
    assert.deepEqual(normal.sourceRevisions, [{ ...seed.revisions[0], label: "美国非农就业人数" }]);
    assert.equal(normal.sourceRevisions[0].firstDetectedAt, firstDetectedAt);
    const exported = await read("?evidence=1");
    assert.deepEqual(exported.sourceLedger, seed);
    assert.equal(exported.sourceLedger.sources.PAYEMS.points[0].value, 159045.123457);
    assert.deepEqual(exported.sourceRevisions, normal.sourceRevisions);
    assert.equal(Object.hasOwn(await read("?evidence=0"), "sourceLedger"), false);
  });
});

test("malformed and future repository seeds are ignored without breaking the existing market board", async () => {
  const future = structuredClone(seed);
  future.sources.PAYEMS.checkedAt = "2026-11-06T15:00:00.000Z";
  const brokenChain = structuredClone(seed);
  brokenChain.revisions[0].after = 1;
  for (const badSeed of ["{ invalid JSON", brokenChain, future]) {
    await withSeed(badSeed, async (read) => {
      const normal = await read();
      assert.equal(Object.hasOwn(normal, "sourceLedger"), false);
      assert.deepEqual(normal.sourceRevisions, []);
      const exported = await read("?evidence=1");
      assert.deepEqual(exported.sourceLedger, { version: 1, sources: {}, revisions: [] });
      assert.deepEqual(exported.sourceRevisions, []);
    });
  }
});

test("a deployment restores publication proof even from an empty raw ledger and immediately excludes obsolete CPI dependencies", async () => {
  const cpi = { period: "2026-09", publishedAt: "2026-10-14T12:30:00.000Z", checkedAt: "2026-11-04T15:00:00.000Z",
    source: "https://www.bls.gov/news.release/cpi.nr0.htm", error: null };
  const checkpoint = { version: 1, sources: {}, revisions: [],
    publicationSchedule: { version: 1, sources: { cpi, employment: null, pce: null } },
  };
  await withSeed(checkpoint, async (read) => {
    for (const body of [await read(), await read()]) {
      assert.equal(Object.hasOwn(body, "sourceLedger"), false);
      assert.deepEqual(body.publicationSchedule.sources.cpi, cpi);
      assert.equal(body.coverage, 57);
      assert.equal(body.score, null);
      assert.equal(body.action.key, "unavailable");
      for (const id of ["inflation", "fed", "unemployment", "payrolls"]) {
        const indicator = body.indicators.find((row) => row.id === id);
        assert.equal(indicator.available, false, id);
        assert.equal(indicator.risk, null); assert.equal(indicator.points, null);
        assert.equal(indicator.value, sample.indicators.find((row) => row.id === id).value);
      }
      const inflation = body.indicators.find((row) => row.id === "inflation");
      assert.equal(inflation.date, "2026-08-01");
      assert.deepEqual(inflation.breakdown, sample.indicators.find((row) => row.id === "inflation").breakdown);
      assert.equal(body.publicationChecks.find((row) => row.kind === "cpi").status, "lagging");
      assert.match(body.publicationErrors.join(" "), /CPI.*2026-09.*2026-08/);
    }
  }, { scoreAvailable: false, editCache(cache) {
    delete cache.publicationSchedule;
    delete cache.earningsSchedule;
    cache.indicators.find((row) => row.id === "inflation").date = "2026-08-01";
    assert.equal(cache.coverage, 90);
  } });
});
