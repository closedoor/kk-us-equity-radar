import test from "node:test";
import assert from "node:assert/strict";
import { cp, mkdtemp, readFile, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import net from "node:net";
import http from "node:http";
import { once } from "node:events";
import { spawn } from "node:child_process";
import { isDashboardSnapshot } from "./public/dashboard-state.js";

const fixture = JSON.parse(await readFile(new URL("./dashboard-cache.json", import.meta.url), "utf8"));
const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function withOfflineServer(cache, check, { stalled = false, preload = null } = {}) {
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
    await writeFile(path.join(dir, "offline.mjs"), preload ?? (stalled
      ? 'globalThis.fetch = (_url, { signal }) => new Promise((_resolve, reject) => { process.stdout.write("TEST_FETCH\\n"); signal.addEventListener("abort", () => reject(new Error("test timeout")), { once: true }); });'
      : 'globalThis.fetch = async () => { throw new Error("test upstream outage"); };'));
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
        if (result.status === 200 && !result.body.refreshing) return result.body;
        await delay(100);
      }
      assert.fail(`Refresh did not finish: ${output}`);
    };
    const request = (options = {}) => new Promise((resolve, reject) => {
      const req = http.request({ hostname: "127.0.0.1", port, path: "/", ...options }, (response) => {
        let body = "";
        response.setEncoding("utf8");
        response.on("data", (chunk) => { body += chunk; });
        response.on("end", () => resolve({ status: response.statusCode, headers: response.headers, body }));
        response.on("error", reject);
      });
      req.on("error", reject);
      req.setTimeout(3000, () => req.destroy(new Error("HTTP test timed out")));
      req.end();
    });
    await check({ read, finished, request, dir, requestCount: () => output.split("TEST_FETCH").length - 1 });
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

test("an incomplete disk signal board cannot bootstrap a reassuring score", async () => {
  const cache = { ...fixture, generatedAt: new Date().toISOString(), indicators: fixture.indicators.slice(1) };
  await withOfflineServer(cache, async ({ read, finished }) => {
    const first = await read();
    assert.equal(first.status, 202);
    assert.equal(first.body.warming, true);
    const after = await finished();
    assert.equal(after.score, null);
    assert.equal(after.indicators.length, 12);
  });
});

test("a malformed saved calendar cannot enter service hydration", async () => {
  const cache = structuredClone(fixture);
  cache.generatedAt = new Date().toISOString();
  cache.calendarSchedule.earnings.NVDA = { date: "2026-11-18", timing: { toString: null } };
  await withOfflineServer(cache, async ({ read, finished }) => {
    const first = await read();
    assert.equal(first.status, 202);
    assert.equal(first.body.warming, true);
    const after = await finished();
    assert.equal(after.indicators.length, 12);
    assert.equal(after.score, null);
    assert.equal(isDashboardSnapshot(after), true);
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

test("a malformed Host header cannot crash the service", async () => {
  await withOfflineServer(fixture, async ({ request, read }) => {
    assert.equal((await request({ headers: { host: "[" } })).status, 200);
    assert.equal((await read()).status, 200);
  }, { stalled: true });
});

test("a malformed request target returns 400 and leaves subsequent requests working", async () => {
  await withOfflineServer(fixture, async ({ request, read }) => {
    const invalid = await request({ path: "http://[" });
    assert.equal(invalid.status, 400);
    assert.ok(invalid.headers["x-content-type-options"]);
    assert.doesNotMatch(invalid.body, /TypeError|server\.mjs/);
    assert.equal((await read()).status, 200);
  }, { stalled: true });
});

test("read-only routes reject writes and HEAD returns headers without a body", async () => {
  await withOfflineServer(fixture, async ({ request }) => {
    for (const method of ["POST", "PUT", "DELETE"]) {
      const response = await request({ method, path: "/api/dashboard?refresh=1" });
      assert.equal(response.status, 405);
      assert.equal(response.headers.allow, "GET, HEAD");
    }
    for (const path of ["/", "/app.js", "/api/dashboard"]) {
      const head = await request({ method: "HEAD", path });
      assert.equal(head.status, 200);
      assert.equal(head.body, "");
      assert.ok(head.headers["content-security-policy"]);
    }
    for (const path of ["/server.mjs", "/dashboard-cache.json", "/.git/config", "/../server.mjs"]) {
      assert.equal((await request({ path })).status, 404);
    }
  }, { stalled: true });
});

function marketStub({ missingStart = false, staleSectors = false } = {}) {
  const dates = [];
  const day = new Date();
  for (; dates.length < 260; day.setUTCDate(day.getUTCDate() - 1)) {
    if (day.getUTCDay() !== 0 && day.getUTCDay() !== 6) dates.unshift(day.toISOString().slice(0, 10));
  }
  const expectedDate = dates.at(-2);
  const preload = `
    const dates = ${JSON.stringify(dates)};
    globalThis.fetch = async (url) => {
      const symbol = String(url).match(/\\/quote\\/([^/]+)\\/historical/)?.[1];
      if (!symbol) throw new Error("test source unavailable");
      const rows = dates.flatMap((date, index) => {
        if (symbol === "RSP" && (index === 259 || (${missingStart} && index === 198))) return [];
        if (${staleSectors} && ["XLK", "XLF", "XLY", "XLC"].includes(symbol) && index >= 258) return [];
        const [year, month, day] = date.split("-");
        return [{ date: month + "/" + day + "/" + year, close: String(index === 259 ? 1000 : 100 + index) }];
      }).reverse();
      return new Response(JSON.stringify({ data: { tradesTable: { rows } } }));
    };
  `;
  return { preload, expectedDate };
}

function completeSourcesStub({ missing = [], laggedCpi = false, missingCpiMonth = false } = {}) {
  return `
    const now = new Date();
    const end = new Date(now.getTime() - 86400000).toISOString().slice(0, 10);
    const days = (value, count = 800, step = 1) => Array.from({length: count}, (_, index) => ({
      date: new Date(Date.parse(end) - (count - 1 - index) * step * 86400000).toISOString().slice(0, 10), value
    }));
    const months = (value = null) => Array.from({length: 36}, (_, index) => ({
      date: new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - 36 + index, 1)).toISOString().slice(0, 10),
      value: value === null ? 100 * 1.003 ** index : value
    }));
    const series = {
      DCOILBRENTEU: days(90), CPIAUCSL: months(), CPIAUCNS: months(), CPILFESL: months(), CPILFENS: months(),
      PCEPI: months(), PCEPILFE: months(), DFEDTARL: days(3.75), DFEDTARU: days(4), DGS2: days(5),
      DGS10: days(4.2), DFII10: days(1.3), T10Y3M: days(-1), VIXCLS: days(17), SP500: days(5000),
      BAMLH0A0HYM2: days(3), DRTSCILM: months(40), SAHMREALTIME: months(0.5), ICSA: days(240000, 60, 7),
      NFCI: days(0.5, 60, 7), UNRATE: months(4.2), PAYEMS: months().map((row, index) => ({...row, value: 160000 + index * 250}))
    };
    if (${laggedCpi}) {
      series.CPIAUCNS.pop(); series.CPILFENS.pop();
      series.CPIAUCSL.at(-1).value = series.CPIAUCSL.at(-2).value * 1.1;
    }
    if (${missingCpiMonth}) series.CPIAUCSL.splice(-2, 1);
    globalThis.fetch = async (raw) => {
      const url = new URL(raw);
      if (url.pathname.endsWith('/fredgraph.csv')) {
        const id = url.searchParams.get('id');
        if (${JSON.stringify(missing)}.includes(id)) throw new Error('test missing ' + id);
        return new Response('DATE,' + id + '\\n' + series[id].map(row => row.date + ',' + row.value).join('\\n'));
      }
      const symbol = url.pathname.match(/\\/quote\\/([^/]+)\\/historical/)?.[1];
      if (symbol) return new Response(JSON.stringify({data: {tradesTable: {rows: days(100, 300).map(row => {
        const [year, month, day] = row.date.split('-'); return {date: month + '/' + day + '/' + year, close: '100'};
      })}}}));
      throw new Error('test calendar unavailable');
    };
  `;
}

test("missing composite dependencies cannot retain complete scoring weight", async () => {
  for (const [missing, ids] of [
    ["NFCI", ["credit"]], ["DRTSCILM", ["credit"]], ["T10Y3M", ["rates"]],
    ["SAHMREALTIME", ["unemployment"]], ["ICSA", ["unemployment"]], ["DGS2", ["fed"]],
    ["DFEDTARL", ["fed"]], ["PCEPILFE", ["inflation", "fed", "unemployment", "payrolls"]],
  ]) {
    await withOfflineServer({}, async ({ finished }) => {
      const data = await finished();
      for (const id of ids) {
        const row = data.indicators.find((item) => item.id === id);
        assert.equal(row.available, false, missing + ' -> ' + id);
        assert.equal(row.risk, null);
        assert.equal(row.points, null);
        assert.match(row.unavailableReason, /子数据|数据不足/);
      }
      assert.ok(data.coverage < 90, missing);
      assert.equal(data.coverage, data.indicators.filter(row => row.available).reduce((sum, row) => sum + row.weight, 0));
      assert.ok(data.errors.some(error => error.includes(missing)));
    }, { preload: completeSourcesStub({ missing: [missing] }) });
  }
});

test("staggered CPI sources use one common month for levels and changes", async () => {
  await withOfflineServer({}, async ({ finished }) => {
    const data = await finished();
    const row = data.indicators.find(item => item.id === "inflation");
    assert.equal(row.available, true);
    assert.match(row.breakdown[0].detail, /月率 \+0\.3%/);
    assert.doesNotMatch(row.breakdown[0].detail, /月率 \+10%/);
    const change = (1.003 ** 12 - 1) * 100;
    const expected = Math.round(((change - 2.5) / 4.5 * 0.35 + (change - 2.5) / 2.5 * 0.25
      + (change - 2.2) / 2.3 * 0.25 + (change - 2.2) / 1.8 * 0.15) * 1000) / 10;
    assert.equal(row.risk, expected);
    assert.ok(data.errors.some(error => /CPI.*月份.*对齐/.test(error)));
  }, { preload: completeSourcesStub({ laggedCpi: true }) });
});

test("a missing common CPI month pauses scoring instead of selecting an older substitute", async () => {
  await withOfflineServer({}, async ({ finished }) => {
    const row = (await finished()).indicators.find(item => item.id === "inflation");
    assert.equal(row.available, false);
    assert.equal(row.risk, null);
    assert.match(row.unavailableReason, /子数据|数据不足/);
  }, { preload: completeSourcesStub({ laggedCpi: true, missingCpiMonth: true }) });
});

test("breadth compares the same start and end dates when a fund updates late", async () => {
  const { preload, expectedDate } = marketStub();
  await withOfflineServer({}, async ({ finished }) => {
    const data = await finished();
    const breadth = data.indicators.find((row) => row.id === "breadth");
    assert.equal(breadth.available, true);
    assert.equal(breadth.date, expectedDate);
    assert.equal(breadth.risk, 0);
  }, { preload });
});

test("breadth is unavailable if the common starting price is missing", async () => {
  const { preload } = marketStub({ missingStart: true });
  await withOfflineServer({}, async ({ finished }) => {
    const breadth = (await finished()).indicators.find((row) => row.id === "breadth");
    assert.equal(breadth.available, false);
    assert.equal(breadth.risk, null);
    assert.equal(breadth.unavailableReason, "数据不足");
  }, { preload });
});

test("breadth requires at least eight sectors on the comparison date, not stale sector prices", async () => {
  const { preload } = marketStub({ staleSectors: true });
  await withOfflineServer({}, async ({ finished }) => {
    const breadth = (await finished()).indicators.find((row) => row.id === "breadth");
    assert.equal(breadth.available, false);
    assert.match(breadth.detail, /7\/11/);
  }, { preload });
});
