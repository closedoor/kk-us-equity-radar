import test from "node:test";
import assert from "node:assert/strict";
import { cp, mkdtemp, readFile, writeFile, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import http from "node:http";
import { once } from "node:events";
import { spawn } from "node:child_process";
import { computeScores } from "./public/risk-model.js";
import { isDashboardSnapshot } from "./public/dashboard-state.js";

const fixedTime = "2026-10-03T12:00:00.000Z";
const fixture = { ...JSON.parse(await readFile(new URL("./dashboard-cache.json", import.meta.url), "utf8")), generatedAt: fixedTime };
const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function until(check, message, timeout = 8000) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    const result = await check();
    if (result) return result;
    await delay(20);
  }
  assert.fail(message);
}

const clockPreload = `
  const NativeDate = Date;
  let clock = NativeDate.parse(${JSON.stringify(fixedTime)});
  globalThis.Date = class extends NativeDate {
    constructor(...args) { super(...(args.length ? args : [clock])); }
    static now() { return clock; }
  };
  process.on("message", (message) => {
    if (message.type === "advance") clock += message.ms;
  });
`;

const healthySources = `
  let releaseCalendar;
  const calendarGate = new Promise((resolve) => { releaseCalendar = resolve; });
  let outage = false;
  process.on("message", (message) => {
    if (message.type === "release-calendar") releaseCalendar();
    if (message.type === "outage") outage = true;
  });
  const dates = [];
  const day = new Date();
  for (; dates.length < 300; day.setUTCDate(day.getUTCDate() - 1)) {
    if (day.getUTCDay() !== 0 && day.getUTCDay() !== 6) dates.unshift(day.toISOString().slice(0, 10));
  }
  const monthly = new Set(["CPIAUCSL", "CPIAUCNS", "CPILFESL", "CPILFENS", "PCEPI", "PCEPILFE", "DRTSCILM", "SAHMREALTIME", "UNRATE", "PAYEMS"]);
  globalThis.fetch = async (value) => {
    const url = new URL(value);
    if (url.pathname.includes("/graph/fredgraph.csv")) {
      process.send({ type: "market-fetch" });
      if (outage) throw new Error("test upstream outage");
      const id = url.searchParams.get("id");
      const rows = monthly.has(id)
        ? Array.from({ length: 48 }, (_, index) => {
          const date = new Date(Date.UTC(2026, 9 - (47 - index), 1)).toISOString().slice(0, 10);
          const value = id === "PAYEMS" ? 150000 + index * 150 : id === "UNRATE" ? 4 : id === "SAHMREALTIME" ? 0.2 : id === "DRTSCILM" ? 10 : 200 + index * 0.3;
          return date + "," + value;
        })
        : dates.map((date, index) => {
          const values = { DCOILBRENTEU: 75, DFEDTARL: 3.5, DFEDTARU: 3.75, DGS2: 3.75, DGS10: 4, DFII10: 2, T10Y3M: 0.5, VIXCLS: 18, BAMLH0A0HYM2: 3, ICSA: 210000, NFCI: -0.3 };
          return date + "," + (values[id] ?? 5000 + index);
        });
      return new Response("DATE," + id + "\\n" + rows.join("\\n"));
    }
    if (url.pathname.includes("/quote/")) {
      process.send({ type: "market-fetch" });
      if (outage) throw new Error("test upstream outage");
      const rows = dates.map((date, index) => {
        const [year, month, day] = date.split("-");
        return { date: month + "/" + day + "/" + year, close: String(100 + index * 0.1) };
      }).reverse();
      return new Response(JSON.stringify({ data: { tradesTable: { rows } } }));
    }
    process.send({ type: "calendar-fetch" });
    if (globalThis.holdCalendar) await calendarGate;
    if (outage) throw new Error("test upstream outage");
    if (url.pathname.endsWith("bls.ics")) return new Response("BEGIN:VCALENDAR\\nBEGIN:VEVENT\\nDTSTART:20261106\\nSUMMARY:Employment Situation\\nEND:VEVENT\\nBEGIN:VEVENT\\nDTSTART:20261110\\nSUMMARY:Consumer Price Index\\nEND:VEVENT\\nEND:VCALENDAR");
    if (url.hostname === "www.federalreserve.gov") return new Response(globalThis.calendarFomcHtml || '<h4><a>2026 FOMC Meetings</a></h4><div class="fomc-meeting__month"><strong>October</strong></div><div class="fomc-meeting__date">27-28</div>');
    if (url.pathname.endsWith("/earnings-date")) return new Response(JSON.stringify({ data: { announcement: "October 2, 2026", reportText: "10/02/2026 after market close" } }));
    throw new Error("Unexpected test upstream: " + value);
  };
`;

async function isolatedServer(cache, check) {
  const dir = await mkdtemp(path.join(tmpdir(), "radar-reliability-test-"));
  const instances = [];
  try {
    for (const name of ["server.mjs", "calendar.mjs", "market-data.mjs", "package.json", "public"]) {
      await cp(new URL(name, import.meta.url), path.join(dir, name), { recursive: true });
    }
    if (cache !== null) await writeFile(path.join(dir, "dashboard-cache.json"), JSON.stringify(cache));
    const start = async (preload) => {
      const preloadFile = path.join(dir, `preload-${instances.length}.mjs`);
      await writeFile(preloadFile, clockPreload + preload);
      const child = spawn(process.execPath, ["--import", preloadFile, path.join(dir, "server.mjs")], {
        cwd: dir, env: { ...process.env, HOST: "127.0.0.1", PORT: "0" }, stdio: ["ignore", "pipe", "pipe", "ipc"],
      });
      let output = "";
      const messages = [];
      child.stdout.on("data", (chunk) => { output += chunk; });
      child.stderr.on("data", (chunk) => { output += chunk; });
      child.on("message", (message) => messages.push(message));
      const instance = {
        messages, output: () => output,
        send: (message) => new Promise((resolve, reject) => child.send(message, (error) => error ? reject(error) : resolve())),
        stop: async () => {
          if (child.exitCode === null && child.signalCode === null) {
            const exited = once(child, "exit");
            child.kill("SIGTERM");
            await exited;
          }
        },
      };
      instances.push(instance);
      // PORT=0 needs the actual bound port, without changing the server source.
      await until(() => messages.find((message) => message.type === "listening"), `Server failed to listen: ${output}`);
      const port = messages.find((message) => message.type === "listening").port;
      instance.read = async (query = "") => {
        const response = await fetch(`http://127.0.0.1:${port}/api/dashboard${query}`, { signal: AbortSignal.timeout(2000) });
        return { status: response.status, body: await response.json() };
      };
      instance.finished = () => until(async () => {
        const result = await instance.read();
        return result.status === 200 && !result.body.refreshing ? result.body : null;
      }, `Refresh did not finish: ${output}`);
      return instance;
    };
    await check({ dir, start });
  } finally {
    for (const instance of instances) await instance.stop();
    await rm(dir, { recursive: true, force: true });
  }
}

const listeningPreload = `
  import http from "node:http";
  const nativeListen = http.Server.prototype.listen;
  http.Server.prototype.listen = function (...args) {
    this.once("listening", () => process.send({ type: "listening", port: this.address().port }));
    return nativeListen.apply(this, args);
  };
`;

const stalledSources = listeningPreload + `
  globalThis.fetch = (_url, { signal }) => new Promise((_resolve, reject) => {
    signal.addEventListener("abort", () => reject(new Error("test timeout")), { once: true });
  });
`;

test("partial persistence failure preserves the live cache and an offline restart", async () => {
  await isolatedServer(fixture, async ({ dir, start }) => {
    const server = await start(listeningPreload + `
      import fs from "node:fs";
      import { syncBuiltinESMExports } from "node:module";
      const originalWrite = fs.promises.writeFile;
      fs.promises.writeFile = async (file, data, options) => {
        if (!String(file).includes("dashboard-cache.json")) return originalWrite(file, data, options);
        await originalWrite(file, String(data).slice(0, 127), options);
        process.send({ type: "partial-write" });
        throw new Error("test ENOSPC after partial write");
      };
      syncBuiltinESMExports();
      globalThis.fetch = async () => { throw new Error("test upstream outage"); };
    `);
    await server.finished();
    await until(() => server.messages.some((message) => message.type === "partial-write"), "No partial-write fault exercised");
    const stored = JSON.parse(await readFile(path.join(dir, "dashboard-cache.json"), "utf8"));
    assert.equal(stored.generatedAt, fixture.generatedAt);
    assert.ok(isDashboardSnapshot(stored));
    assert.equal((await readdir(dir)).filter((file) => file.endsWith(".tmp")).length, 0);
    await server.stop();
    const restarted = await start(listeningPreload + `
      globalThis.fetch = (_url, { signal }) => new Promise((_resolve, reject) => {
        signal.addEventListener("abort", () => reject(new Error("test timeout")), { once: true });
      });
    `);
    const response = await restarted.read();
    assert.equal(response.status, 200);
    assert.equal(response.body.generatedAt, fixture.generatedAt);
    assert.ok(Number.isFinite(response.body.score));
  });
});

test("pending cache writes stay atomic and serialized and finish with the latest snapshot", async () => {
  await isolatedServer(fixture, async ({ dir, start }) => {
    const server = await start(listeningPreload + healthySources + `
      import fs from "node:fs";
      import { syncBuiltinESMExports } from "node:module";
      const originalWrite = fs.promises.writeFile;
      let writes = 0;
      let releaseWrite;
      const gate = new Promise((resolve) => { releaseWrite = resolve; });
      process.on("message", (message) => { if (message.type === "release-write") releaseWrite(); });
      fs.promises.writeFile = async (file, data, options) => {
        if (!String(file).includes("dashboard-cache.json")) return originalWrite(file, data, options);
        const index = ++writes;
        process.send({ type: "write-start", index });
        if (index === 1) {
          const handle = await fs.promises.open(file, options?.flag || "w");
          try {
            await handle.write(String(data).slice(0, 127));
            await gate;
            await handle.write(String(data).slice(127));
          } finally { await handle.close(); }
        } else await originalWrite(file, data, options);
        process.send({ type: "write-end", index });
      };
      syncBuiltinESMExports();
    `);
    await until(() => server.messages.some((message) => message.type === "write-start"), "No persistence job started");
    await server.send({ type: "advance", ms: 61_000 });
    await server.read("?refresh=1");
    await delay(500);
    assert.equal(server.messages.filter((message) => message.type === "write-start").length, 1, "A newer write overtook the held write");
    assert.ok(isDashboardSnapshot(JSON.parse(await readFile(path.join(dir, "dashboard-cache.json"), "utf8"))), "A partial temporary file replaced the live cache");
    await server.send({ type: "release-write" });
    const latest = await server.finished();
    const stored = JSON.parse(await readFile(path.join(dir, "dashboard-cache.json"), "utf8"));
    for (const key of ["generatedAt", "score", "coverage", "indicators", "categories", "aiEarnings", "calendarSync"]) {
      assert.deepEqual(stored[key], latest[key], `Persisted ${key} is not the latest published value`);
    }
    assert.ok(server.messages.filter((message) => message.type === "write-start").length >= 2, "The newer snapshot was never persisted");
    assert.equal((await readdir(dir)).filter((file) => file.endsWith(".tmp")).length, 0);
  });
});

test("streaming non-OK upstream bodies release their network resources", async () => {
  const responses = new Set();
  const sockets = new Set();
  let requests = 0;
  const upstream = http.createServer((_req, res) => {
    requests += 1;
    responses.add(res);
    res.on("close", () => responses.delete(res));
    res.writeHead(429);
    res.write("error body deliberately left open");
  });
  upstream.on("connection", (socket) => { sockets.add(socket); socket.on("close", () => sockets.delete(socket)); });
  upstream.listen(0, "127.0.0.1");
  await once(upstream, "listening");
  try {
    await isolatedServer(fixture, async ({ start }) => {
      const server = await start(listeningPreload + `
        const nativeFetch = globalThis.fetch;
        globalThis.fetch = (_url, options) => nativeFetch("http://127.0.0.1:${upstream.address().port}/", options);
      `);
      await server.finished();
      assert.ok(requests >= 70, "The upstream retry/error path was not exercised");
      await until(() => responses.size === 0, `${responses.size} unread error responses still hold resources`, 1000);
      assert.equal((await server.read()).status, 200);
    });
  } finally {
    for (const socket of sockets) socket.destroy();
    await new Promise((resolve) => upstream.close(resolve));
  }
});

test("successful upstream bodies retain their complete-body timeout", async () => {
  const sockets = new Set();
  const upstream = http.createServer((_req, res) => { res.writeHead(200); res.write("incomplete body"); });
  upstream.on("connection", (socket) => { sockets.add(socket); socket.on("close", () => sockets.delete(socket)); });
  upstream.listen(0, "127.0.0.1");
  await once(upstream, "listening");
  try {
    const source = await readFile(new URL("./server.mjs", import.meta.url), "utf8");
    const body = source.slice(source.indexOf("async function fetchText("), source.indexOf("\nasync function fetchJson("));
    const fetchText = new Function("fetch", "REQUEST_TIMEOUT_MS", `${body}; return fetchText;`)(fetch, 100);
    await assert.rejects(fetchText(`http://127.0.0.1:${upstream.address().port}/`), (error) => error.name === "AbortError");
  } finally {
    for (const socket of sockets) socket.destroy();
    await new Promise((resolve) => upstream.close(resolve));
  }
});

test("market cold start publishes before calendars finish and polling sees coherent completion", async () => {
  await isolatedServer(null, async ({ dir, start }) => {
    const server = await start(listeningPreload + "globalThis.holdCalendar = true;\n" + healthySources);
    const early = await until(async () => {
      const response = await server.read();
      return response.status === 200 ? response.body : null;
    }, "Usable market data was blocked by calendar completion", 2000);
    assert.ok(early.refreshing, "Polling stopped before calendar completion");
    assert.ok(Number.isFinite(early.score));
    assert.ok(early.coverage >= 60);
    assert.ok(early.indicators.find((row) => row.id === "aiEarnings").available);
    const marketCalls = server.messages.filter((message) => message.type === "market-fetch").length;
    assert.equal(marketCalls, 35);
    for (let attempt = 0; attempt < 3; attempt += 1) assert.equal((await server.read()).body.refreshing, true);
    await server.send({ type: "release-calendar" });
    const complete = await server.finished();
    assert.equal(complete.generatedAt, early.generatedAt);
    assert.equal(server.messages.filter((message) => message.type === "market-fetch").length, marketCalls);
    assert.equal(complete.calendarSync.sources.earnings.error, null);
    assert.ok(complete.aiEarnings.every((row) => row.snapshotStale));
    const ai = complete.indicators.find((row) => row.id === "aiEarnings");
    assert.equal(ai.available, false);
    assert.equal(ai.date, null);
    assert.equal(complete.score, computeScores(complete.indicators, complete.scoringContext).score);
    assert.ok(isDashboardSnapshot(complete));
    const stored = JSON.parse(await readFile(path.join(dir, "dashboard-cache.json"), "utf8"));
    assert.equal(stored.generatedAt, early.generatedAt);
    assert.deepEqual(stored.aiEarnings, complete.aiEarnings);
    assert.deepEqual(stored.indicators, complete.indicators);
    assert.equal(stored.score, complete.score);
  });
});

test("source errors preserve the last usable market snapshot and force cooldown still applies", async () => {
  await isolatedServer(null, async ({ start }) => {
    const server = await start(listeningPreload + healthySources);
    const first = await server.finished();
    assert.ok(Number.isFinite(first.score));
    const count = () => server.messages.filter((message) => message.type === "market-fetch").length;
    assert.equal(count(), 35);
    await server.send({ type: "advance", ms: 59_000 });
    assert.equal((await server.read("?refresh=1")).body.refreshing, false);
    assert.equal(count(), 35);
    await server.send({ type: "advance", ms: 2000 });
    await server.send({ type: "outage" });
    await server.read("?refresh=1");
    const after = await server.finished();
    assert.equal(after.generatedAt, first.generatedAt);
    assert.ok(Number.isFinite(after.score));
    assert.ok(after.errors.length > 0);
    assert.ok(count() > 35);
    const attempts = count();
    assert.equal((await server.read("?refresh=1")).body.refreshing, false);
    assert.equal(count(), attempts);
  });
});

test("cache replacement compares coverage after concurrent AI calendar changes", async () => {
  const previous = { ...fixture, generatedAt: "2026-10-03T11:00:00.000Z" };
  await isolatedServer(previous, async ({ start }) => {
    const server = await start(listeningPreload + healthySources + `
      const sources = globalThis.fetch;
      let releaseMarket;
      const gate = new Promise((resolve) => { releaseMarket = resolve; });
      process.on("message", (message) => { if (message.type === "release-market") releaseMarket(); });
      globalThis.fetch = async (value, options) => {
        const url = new URL(value);
        if (url.pathname.includes("/graph/fredgraph.csv") || url.pathname.includes("/quote/")) {
          await gate;
          if (url.searchParams.get("id") === "VIXCLS") throw new Error("test missing VIX");
        }
        return sources(value, options);
      };
    `);
    const during = await until(async () => {
      const response = await server.read();
      return response.status === 200 && response.body.aiEarnings.every((row) => row.snapshotStale) ? response.body : null;
    }, "Calendar completion was not visible while market work remained pending");
    assert.equal(during.generatedAt, previous.generatedAt);
    assert.equal(during.indicators.find((row) => row.id === "aiEarnings").available, false);
    await server.send({ type: "release-market" });
    const after = await server.finished();
    assert.equal(after.generatedAt, previous.generatedAt, "The guard used superseded AI eligibility to replace a better cache");
    assert.equal(after.coverage, during.coverage);
    assert.equal(after.indicators.find((row) => row.id === "vix").available, true);
    assert.match(after.errors.join(" "), /test missing VIX/);
  });
});

test("calendar completion replaces a pending FOMC label without changing the market timestamp", async () => {
  await isolatedServer(null, async ({ dir, start }) => {
    const server = await start(listeningPreload + `
      clock = NativeDate.parse("2026-12-20T12:00:00.000Z");
      globalThis.holdCalendar = true;
      globalThis.calendarFomcHtml = '<h4><a>2027 FOMC Meetings</a></h4><div class="fomc-meeting__month"><strong>January</strong></div><div class="fomc-meeting__date">26-27</div>';
    ` + healthySources);
    const early = await until(async () => {
      const response = await server.read();
      return response.status === 200 ? response.body : null;
    }, "No first market snapshot", 2000);
    assert.equal(early.reminders.find((row) => row.indicatorId === "fed").date, null);
    assert.ok(early.indicators.find((row) => row.id === "fed").detail.includes("\u5f85\u5b98\u65b9\u516c\u5e03"));
    assert.ok(early.refreshing);
    await server.send({ type: "release-calendar" });
    const complete = await server.finished();
    const meeting = complete.reminders.find((row) => row.indicatorId === "fed");
    const fed = complete.indicators.find((row) => row.id === "fed");
    const twoYear = fed.breakdown.find((row) => row.label === "2 \u5e74\u671f\u7f8e\u503a");
    assert.equal(meeting.date, "2027-01-27");
    assert.equal(fed.detail, "\u5f53\u524d\u8054\u90a6\u57fa\u91d1\u76ee\u6807\u533a\u95f4\uff1b\u4e0b\u6b21\u4f1a\u8bae " + meeting.date + "\uff1b2 \u5e74\u671f " + twoYear.value);
    assert.equal(complete.generatedAt, early.generatedAt);
    assert.equal(fed.date, early.indicators.find((row) => row.id === "fed").date);
    const stored = JSON.parse(await readFile(path.join(dir, "dashboard-cache.json"), "utf8"));
    assert.equal(stored.generatedAt, early.generatedAt);
    assert.equal(stored.indicators.find((row) => row.id === "fed").detail, fed.detail);
  });
});

test("a failed persistence job does not poison subsequent queued writes", async () => {
  await isolatedServer(fixture, async ({ dir, start }) => {
    const server = await start(listeningPreload + healthySources + `
      import fs from "node:fs";
      import { syncBuiltinESMExports } from "node:module";
      const originalWrite = fs.promises.writeFile;
      let writes = 0;
      fs.promises.writeFile = async (file, data, options) => {
        if (!String(file).includes("dashboard-cache.json")) return originalWrite(file, data, options);
        process.send({ type: "persistence-attempt", index: ++writes });
        if (writes === 1) {
          await originalWrite(file, String(data).slice(0, 127), options);
          throw new Error("test first persistence failed");
        }
        return originalWrite(file, data, options);
      };
      syncBuiltinESMExports();
    `);
    const latest = await server.finished();
    assert.ok(server.messages.filter((message) => message.type === "persistence-attempt").length >= 2);
    assert.match(server.output(), /test first persistence failed/);
    const stored = JSON.parse(await readFile(path.join(dir, "dashboard-cache.json"), "utf8"));
    assert.ok(isDashboardSnapshot(stored));
    assert.deepEqual(stored.indicators, latest.indicators);
    assert.equal(stored.score, latest.score);
    assert.equal((await readdir(dir)).filter((file) => file.endsWith(".tmp")).length, 0);
  });
});

test("legacy error cache cannot bootstrap unverified composite integrity", async () => {
  const legacy = { ...fixture, errors: ["NFCI unavailable"] };
  delete legacy.dataQualityVersion;
  await isolatedServer(legacy, async ({ start }) => {
    const server = await start(stalledSources);
    const response = await server.read();
    assert.equal(response.status, 202);
    assert.equal(response.body.warming, true);
  });
});

test("complete legacy cache still bootstraps without changing its market date", async () => {
  const legacy = { ...fixture, errors: [] };
  delete legacy.dataQualityVersion;
  await isolatedServer(legacy, async ({ start }) => {
    const server = await start(stalledSources);
    const response = await server.read();
    assert.equal(response.status, 200);
    assert.equal(response.body.generatedAt, legacy.generatedAt);
    assert.equal(response.body.dataQualityVersion, undefined);
    assert.ok(Number.isFinite(response.body.score));
  });
});

test("versioned partial cache bootstraps with unavailable credit excluded", async () => {
  const indicators = fixture.indicators.map((row) => row.id === "credit"
    ? { ...row, available: false, risk: null, points: null, status: "unavailable", unavailableReason: "Sub-data unavailable" }
    : row);
  const { available, ...model } = computeScores(indicators, fixture.scoringContext);
  const cache = { ...fixture, ...model, dataQualityVersion: 1, indicators, errors: ["NFCI unavailable"] };
  await isolatedServer(cache, async ({ start }) => {
    const server = await start(stalledSources);
    const response = await server.read();
    assert.equal(response.status, 200);
    assert.equal(response.body.generatedAt, cache.generatedAt);
    assert.equal(response.body.dataQualityVersion, 1);
    assert.equal(response.body.indicators.find((row) => row.id === "credit").available, false);
    assert.equal(response.body.coverage, model.coverage);
    assert.equal(response.body.score, model.score);
    assert.ok(Number.isFinite(response.body.score));
  });
});

async function withMarketBudgetPeer(cache, check) {
  const heldResponses = new Set();
  const sockets = new Set();
  const calls = [];
  let slow = true;
  const days = Array.from({ length: 300 }, (_, index) => {
    const day = new Date(fixedTime);
    day.setUTCDate(day.getUTCDate() - (299 - index));
    return day.toISOString().slice(0, 10);
  });
  const monthly = new Set(["CPIAUCSL", "CPIAUCNS", "CPILFESL", "CPILFENS", "PCEPI", "PCEPILFE", "DRTSCILM", "SAHMREALTIME", "UNRATE", "PAYEMS"]);
  const upstream = http.createServer((req, res) => {
    const original = new URL(new URL(req.url, "http://localhost").searchParams.get("source"));
    const id = original.searchParams.get("id") || original.pathname.split("/")[3];
    calls.push(id);
    res.writeHead(200);
    if (slow && !["DCOILBRENTEU", "CPIAUCSL", "SPY"].includes(id)) {
      heldResponses.add(res);
      res.on("close", () => heldResponses.delete(res));
      res.write("held successful-response body");
      return;
    }
    if (original.pathname.includes("/quote/")) {
      const rows = days.map((date, index) => {
        const [year, month, day] = date.split("-");
        return { date: `${month}/${day}/${year}`, close: String(100 + index * 0.1) };
      }).reverse();
      res.end(JSON.stringify({ data: { tradesTable: { rows } } }));
    } else {
      const rows = monthly.has(id)
        ? Array.from({ length: 48 }, (_, index) => `${new Date(Date.UTC(2026, 9 - (47 - index), 1)).toISOString().slice(0, 10)},${100 + index}`)
        : days.map((date, index) => `${date},${id === "DCOILBRENTEU" ? 75 : 100 + index}`);
      res.end(`DATE,${id}\n${rows.join("\n")}`);
    }
  });
  upstream.on("connection", (socket) => { sockets.add(socket); socket.on("close", () => sockets.delete(socket)); });
  upstream.listen(0, "127.0.0.1");
  await once(upstream, "listening");
  try {
    await isolatedServer(cache, async ({ start }) => {
      const server = await start(listeningPreload + "const networkFetch = globalThis.fetch;\n" + healthySources + `
        const nativeNow = NativeDate.now.bind(NativeDate);
        const started = nativeNow();
        const nativeTimeout = globalThis.setTimeout;
        const scale = 100;
        Date.now = () => clock + (nativeNow() - started) * scale;
        globalThis.setTimeout = (callback, ms, ...args) => nativeTimeout(callback, ms / scale, ...args);
        const sourceFetch = globalThis.fetch;
        globalThis.fetch = (value, options) => {
          const url = new URL(value);
          if (!url.pathname.includes("/graph/fredgraph.csv") && !url.pathname.includes("/quote/")) return sourceFetch(value, options);
          process.send({ type: "budget-fetch", at: Date.now() });
          return networkFetch("http://127.0.0.1:${upstream.address().port}/?source=" + encodeURIComponent(value), options);
        };
      `);
      await check({ server, calls, heldResponses, recover: () => { slow = false; } });
    });
  } finally {
    for (const socket of sockets) socket.destroy();
    await new Promise((resolve) => upstream.close(resolve));
  }
}

test("market-fetch budget settles mixed fast and held 200 bodies without pending responses", async (t) => {
  await withMarketBudgetPeer(null, async ({ server, calls, heldResponses }) => {
    const started = Date.now();
    const result = await until(async () => {
      const response = await server.read();
      return response.status === 200 && !response.body.refreshing ? response.body : null;
    }, "Market fetching exceeded the simulated 90-second absolute budget", 1600);
    assert.equal(result.score, null);
    assert.ok(result.coverage < 60);
    assert.equal(result.indicators.find((row) => row.id === "oil").available, true);
    assert.match(result.errors.join(" "), /Market fetch budget exhausted/);
    assert.ok(calls.some((id, index) => calls.indexOf(id) !== index), "No request retry was exercised");
    assert.ok(!calls.includes("PAYEMS"), "Expired queued sources still started network requests");
    await until(() => heldResponses.size === 0, "Successful-response bodies outlived the market budget", 500);
    const requests = server.messages.filter((message) => message.type === "budget-fetch");
    assert.ok(requests.every((request) => request.at <= requests[0].at + 90_000));
    const count = calls.length;
    await delay(100);
    assert.equal(calls.length, count, "A queued request or retry started after publication");
    const source = await readFile(new URL("./server.mjs", import.meta.url), "utf8");
    assert.match(source, /MARKET_FETCH_BUDGET_MS = 90_000/);
    assert.match(source, /REQUEST_TIMEOUT_MS = 25_000/);
    t.diagnostic(`Production cap 90000ms; test clock/timers run 100x (900ms wall equivalent); observed settle/cleanup ${Date.now() - started}ms.`);
  });
});

test("market-fetch budget preserves last-good data and permits a subsequent successful refresh", async (t) => {
  const previous = { ...fixture, generatedAt: "2026-10-03T11:00:00.000Z" };
  await withMarketBudgetPeer(previous, async ({ server, calls, heldResponses, recover }) => {
    const started = Date.now();
    const result = await until(async () => {
      const response = await server.read();
      return response.status === 200 && !response.body.refreshing ? response.body : null;
    }, "Budgeted refresh did not settle while retaining previous data", 1600);
    assert.equal(result.generatedAt, previous.generatedAt);
    assert.ok(Number.isFinite(result.score));
    assert.ok(result.errors.length > 0);
    await until(() => heldResponses.size === 0, "Budgeted error left response resources alive", 500);
    const count = calls.length;
    recover();
    await server.read("?refresh=1");
    const recovered = await server.finished();
    assert.equal(recovered.generatedAt, fixedTime);
    assert.equal(recovered.dataQualityVersion, 1);
    assert.ok(Number.isFinite(recovered.score));
    assert.deepEqual(recovered.errors, []);
    assert.ok(calls.length > count);
    assert.equal(heldResponses.size, 0);
    t.diagnostic(`Production cap 90000ms; 100x simulated timers; preserved cache, then successful retry in ${Date.now() - started}ms total.`);
  });
});

test("expired deadlines skip network calls and retry backoff cannot exceed the remainder", async () => {
  const source = await readFile(new URL("./server.mjs", import.meta.url), "utf8");
  const textBody = source.slice(source.indexOf("async function fetchText("), source.indexOf("\nasync function fetchJson("));
  let fetches = 0;
  const fetchText = new Function("fetch", "REQUEST_TIMEOUT_MS", `${textBody}; return fetchText;`)(async () => {
    fetches += 1;
    return new Response("complete body");
  }, 100);
  await assert.rejects(fetchText("http://unused", {}, Date.now() - 1), /Market fetch budget exhausted/);
  assert.equal(fetches, 0);
  assert.equal(await fetchText("http://unused"), "complete body");
  assert.equal(fetches, 1);

  const retryBody = source.slice(source.indexOf("async function retry("), source.indexOf("\nfunction seriesData("));
  let now = 1000;
  let backoffs = 0;
  let attempts = 0;
  const retry = new Function("Date", "setTimeout", `${retryBody}; return retry;`)({ now: () => now }, (callback, ms) => {
    backoffs += 1;
    now += ms;
    callback();
  });
  const task = async () => { attempts += 1; throw new Error("test transient error"); };
  await assert.rejects(retry(task, 2, 1100), /test transient error/);
  assert.equal(attempts, 1);
  assert.equal(backoffs, 0);
  await assert.rejects(retry(task, 2, 1000), /Market fetch budget exhausted/);
  assert.equal(attempts, 1);
});
