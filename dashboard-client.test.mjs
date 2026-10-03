import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { requestDashboard } from "./public/dashboard-client.js";

const fixture = JSON.parse(readFileSync(new URL("./dashboard-cache.json", import.meta.url)));
const response = (payload, status = 200) => async () => new Response(JSON.stringify(payload), { status });

test("client accepts a complete dashboard and the cold-start response", async () => {
  assert.deepEqual((await requestDashboard("/api/dashboard", { fetchImpl: response(fixture) })).payload, fixture);
  assert.equal((await requestDashboard("/api/dashboard", { fetchImpl: response({ warming: true }, 202) })).warming, true);
});

test("client rejects malformed success payloads before they can replace a working dashboard", async () => {
  const malformed = [null, {}, { ...fixture, indicators: null }, { ...fixture, aiEarnings: [null] },
    { ...fixture, aiChainLayers: [{ tickers: null }] }, { ...fixture, reminders: [null] },
    { ...fixture, errors: {} }, { ...fixture, scoringContext: null },
    { ...fixture, indicators: fixture.indicators.slice(1) },
    { ...fixture, indicators: fixture.indicators.map((row, index) => index ? row : { ...row, available: "false" }) },
    { ...fixture, indicators: [{ ...fixture.indicators[0], sparkline: {} }] }];
  for (const payload of malformed) {
    await assert.rejects(requestDashboard("/api/dashboard", { fetchImpl: response(payload) }), /数据格式异常/);
  }
  await assert.rejects(requestDashboard("/api/dashboard", { fetchImpl: response({ warming: false }, 202) }), /数据格式异常/);
  await assert.rejects(requestDashboard("/api/dashboard", { fetchImpl: async () => new Response("broken JSON") }), /数据格式异常/);
});

test("an HTTP error does not try to parse an HTML error page as a dashboard", async () => {
  await assert.rejects(requestDashboard("/api/dashboard", { fetchImpl: async () => new Response("<h1>Unavailable</h1>", { status: 503 }) }), /503/);
});

test("the timeout covers a stalled body after response headers have arrived", async () => {
  let aborted = false;
  const fetchImpl = async (_url, { signal }) => ({
    ok: true, status: 200,
    json: () => new Promise((_resolve, reject) => signal.addEventListener("abort", () => { aborted = true; reject(new Error("aborted")); }, { once: true })),
  });
  await assert.rejects(requestDashboard("/api/dashboard", { fetchImpl, timeoutMs: 15 }), /超时/);
  assert.equal(aborted, true);
});
