import test from "node:test";
import assert from "node:assert/strict";
import { cp, mkdtemp, readFile, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import net from "node:net";
import { once } from "node:events";
import { spawn } from "node:child_process";

const fixture = JSON.parse(await readFile(new URL("./dashboard-cache.json", import.meta.url), "utf8"));
const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function withOfflineServer(cache, check, { stalled = false } = {}) {
  const dir = await mkdtemp(path.join(tmpdir(), "radar-server-test-"));
  const reservation = net.createServer();
  reservation.listen(0, "127.0.0.1");
  await once(reservation, "listening");
  const port = reservation.address().port;
  await new Promise((resolve) => reservation.close(resolve));
  let child;
  try {
    for (const name of ["server.mjs", "calendar.mjs", "market-data.mjs", "package.json", "public"]) {
      await cp(new URL(name, import.meta.url), path.join(dir, name), { recursive: true });
    }
    await writeFile(path.join(dir, "dashboard-cache.json"), JSON.stringify(cache));
    await writeFile(path.join(dir, "offline.mjs"), stalled
      ? 'globalThis.fetch = (_url, { signal }) => new Promise((_resolve, reject) => { process.stdout.write("TEST_FETCH\\n"); signal.addEventListener("abort", () => reject(new Error("test timeout")), { once: true }); });'
      : 'globalThis.fetch = async () => { throw new Error("test upstream outage"); };');
    child = spawn(process.execPath, ["--import", path.join(dir, "offline.mjs"), path.join(dir, "server.mjs")], {
      cwd: dir, env: { ...process.env, HOST: "127.0.0.1", PORT: String(port) }, stdio: ["ignore", "pipe", "pipe"],
    });
    let output = "";
    child.stdout.on("data", (chunk) => { output += chunk; });
    child.stderr.on("data", (chunk) => { output += chunk; });
    const deadline = Date.now() + 15_000;
    while (!output.includes("已启动") && Date.now() < deadline && child.exitCode === null) await delay(50);
    assert.match(output, /已启动/, output);
    const read = async (query = "") => {
      const response = await fetch(`http://127.0.0.1:${port}/api/dashboard${query}`, { signal: AbortSignal.timeout(3000) });
      return { status: response.status, body: await response.json() };
    };
    const finished = async () => {
      while (Date.now() < deadline) {
        const result = await read();
        if (result.status === 200 && !result.body.refreshing && result.body.errors.length) return result.body;
        await delay(100);
      }
      assert.fail(`Refresh did not finish: ${output}`);
    };
    await check({ read, finished, dir, requestCount: () => output.split("TEST_FETCH").length - 1 });
  } finally {
    if (child && child.exitCode === null && child.signalCode === null) {
      child.kill("SIGTERM");
      await once(child, "exit");
    }
    await rm(dir, { recursive: true, force: true });
  }
}

test("a malformed disk cache returns warming status instead of crashing the HTTP service", async () => {
  await withOfflineServer({}, async ({ read, finished }) => {
    const first = await read();
    assert.equal(first.status, 202);
    assert.equal(first.body.warming, true);
    const after = await finished();
    assert.equal(after.score, null);
    assert.equal(after.action.key, "unavailable");
  });
});

test("an expired cache cannot supply a total score, even before or after an upstream failure", async () => {
  const cache = { ...fixture, generatedAt: new Date(Date.now() - 2 * 86_400_000).toISOString() };
  await withOfflineServer(cache, async ({ read, finished }) => {
    const first = (await read()).body;
    assert.equal(first.cacheExpired, true);
    assert.equal(first.score, null);
    const after = await finished();
    assert.equal(after.score, null);
    assert.ok(after.coverage < 60);
    assert.notEqual(after.generatedAt, cache.generatedAt);
  });
});

test("a recent cache survives source failures while latest calendar status is persisted", async () => {
  const cache = { ...fixture, generatedAt: new Date().toISOString() };
  await withOfflineServer(cache, async ({ finished, dir }) => {
    const after = await finished();
    assert.equal(after.generatedAt, cache.generatedAt);
    assert.ok(after.coverage >= 60);
    assert.ok(Number.isFinite(after.score));
    assert.ok(after.calendarSync.sources.bls.error);
    // The response can precede the asynchronous disk write by one event-loop turn.
    await delay(100);
    const stored = JSON.parse(await readFile(path.join(dir, "dashboard-cache.json"), "utf8"));
    assert.equal(stored.generatedAt, cache.generatedAt);
    assert.ok(stored.calendarSync.sources.bls.error);
  });
});

test("manual refresh returns promptly and shares the running fetch when upstream requests stall", async () => {
  const cache = { ...fixture, generatedAt: new Date().toISOString() };
  await withOfflineServer(cache, async ({ read, requestCount }) => {
    const count = requestCount();
    for (let attempt = 0; attempt < 3; attempt += 1) {
      const result = await read("?refresh=1");
      assert.equal(result.status, 200);
      assert.equal(result.body.refreshing, true);
      assert.equal(result.body.generatedAt, cache.generatedAt);
    }
    await delay(50);
    assert.equal(requestCount(), count);
  }, { stalled: true });
});
