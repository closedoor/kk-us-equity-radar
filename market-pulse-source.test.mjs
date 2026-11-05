import test from "node:test";
import assert from "node:assert/strict";
import { fetchLicensedMarketPulse, MARKET_PULSE_BUDGET_MS } from "./market-pulse-source.mjs";

const NOW = "2026-11-05T23:18:30.000Z";
const now = () => new Date(NOW);
const licensedUrl = "https://licensed.example.test/pulse";
const quote = (symbol, value, changePercent, edits = {}) => ({
  symbol, value, date: "2026-11-05", at: "2026-11-05T21:00:00.000Z", session: "close",
  changePercent, source: "https://licensed.example.test/attribution/" + symbol, ...edits,
});
const licensedVix = quote("VIX", 28.18, (28.18 / 16.61 - 1) * 100, { at: "2026-11-05T21:15:01.000Z" });

test("licensed default fetch keeps bearer tokens in a single nonredirecting HTTPS request", async () => {
  const originalFetch = globalThis.fetch;
  const requests = [];
  globalThis.fetch = async (url, options) => {
    requests.push({ url, options });
    return Response.json({ quotes: [licensedVix] });
  };
  try {
    const result = await fetchLicensedMarketPulse({ now, url: licensedUrl, token: "fixture-token" });
    assert.deepEqual(result, { quotes: [licensedVix], errors: [], checkedAt: NOW });
    assert.equal(requests.length, 1); assert.equal(requests[0].url, licensedUrl);
    assert.equal(requests[0].options.redirect, "error");
    assert.equal(requests[0].options.headers.authorization, "Bearer fixture-token");
    assert.equal(JSON.stringify(result).includes("fixture-token"), false);
    for (const url of ["http://licensed.example.test/pulse", `${licensedUrl}?token=secret`, "https://user:secret@licensed.example.test/pulse", ""]) {
      assert.deepEqual((await fetchLicensedMarketPulse({ now, url })).quotes, []);
    }
    assert.deepEqual((await fetchLicensedMarketPulse({ now, url: licensedUrl, token: "invalid\nheader" })).quotes, []);
    assert.equal(requests.length, 1, "Unsafe or disabled configuration must not fetch anything");
  } finally { globalThis.fetch = originalFetch; }
});

test("licensed feeds reject oversized bodies and isolate duplicate, future, or credential-bearing quotes", async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => new Response(JSON.stringify({ quotes: [], padding: "x".repeat(65_536) }));
  try {
    const result = await fetchLicensedMarketPulse({ now, url: licensedUrl });
    assert.deepEqual(result.quotes, []); assert.match(result.errors.join(" "), /响应无法读取/);
  } finally { globalThis.fetch = originalFetch; }
  const valid = quote("SMH", 446.29, -11.5);
  const secret = { ...quote("QQQ", 648.58, -6.27), source: "https://example.test/quote?api_key=secret" };
  const future = { ...quote("RSP", 217.0799, -2.8), date: "2026-11-06", at: "2026-11-06T21:00:00.000Z" };
  const result = await fetchLicensedMarketPulse({ now, url: licensedUrl, fetchText: async () => JSON.stringify({ quotes: [licensedVix, licensedVix, secret, future, valid], errors: ["Provider secret"] }) });
  assert.deepEqual(result.quotes, [valid]);
  assert.equal(result.errors.length, 4);
  assert.equal(JSON.stringify(result).includes("secret"), false);
});

test("licensed closing-window quotes preserve observation time, missing reference, and prior dates over weekends", async () => {
  const rows = [
    licensedVix,
    quote("VXSMH", 65.89, null, { at: "2026-11-05T15:02:02.681000-06:00" }),
    quote("SPX", 7353.73, -4.3557, { at: "2026-11-05T21:14:59Z" }),
    quote("RSP", 217.0799, -2.8), quote("QQQ", 648.58, -6.27), quote("SMH", 446.29, -11.5),
  ];
  const checkedAt = "2026-11-07T15:00:00.000Z";
  const start = Date.now();
  const result = await fetchLicensedMarketPulse({ url: licensedUrl, now: () => new Date(checkedAt),
    fetchText: async (url, headers, deadline, options) => {
      assert.equal(url, licensedUrl); assert.equal(headers.authorization, undefined);
      assert.ok(deadline >= start + MARKET_PULSE_BUDGET_MS);
      assert.deepEqual(options, { redirect: "error", maxBytes: 65_536 });
      return JSON.stringify({ quotes: rows, checkedAt: "not the verification time", errors: [] });
    },
  });
  assert.equal(result.checkedAt, checkedAt); assert.deepEqual(result.errors, []);
  assert.equal(result.quotes.length, 6);
  assert.ok(result.quotes.every((row) => row.date === "2026-11-05"));
  assert.equal(result.quotes[1].at, "2026-11-05T21:02:02.681Z");
  assert.equal(result.quotes[1].changePercent, null);
  assert.equal(result.quotes[2].at, "2026-11-05T21:14:59.000Z");
});

test("licensed rows cannot fabricate an observation date, regular phase, or valid price", async () => {
  const rows = [
    quote("VIX", 28.18, 69.65, { at: "2026-11-05T16:15:01" }),
    quote("VXSMH", 65.89, 43.8, { date: "2026-11-04" }),
    quote("SPX", 7353.73, -4.35, { at: "2026-11-05T23:00:00.000Z", session: "regular" }),
    quote("RSP", "217.0799", -2.8),
    quote("QQQ", 648.58, -100),
    quote("SMH", 446.29, -11.5),
  ];
  const result = await fetchLicensedMarketPulse({ now, url: licensedUrl, fetchText: async () => JSON.stringify({ quotes: rows }) });
  assert.deepEqual(result.quotes, [rows.at(-1)]); assert.equal(result.errors.length, 5);
  const oversized = await fetchLicensedMarketPulse({ now, url: licensedUrl, fetchText: async () => JSON.stringify({ quotes: [...rows, rows[0]] }) });
  assert.deepEqual(oversized.quotes, []); assert.match(oversized.errors.join(" "), /批量大小无效/);
});
