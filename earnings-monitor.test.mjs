import test from "node:test";
import assert from "node:assert/strict";
import { createEarningsMonitor, parseSecEarnings, parseSkEarningsFeed, earningsMonitorSources } from "./earnings-monitor.mjs";
import { applyEarningsChecks, isEarningsSchedule } from "./public/earnings-state.js";

const at = "2026-11-05T12:00:00.000Z";
const sec = (cik, entries) => ({ cik, name: "Official company", fiscalYearEnd: ({ "1045810": "0125", "1730168": "1102", "723125": "0903", "789019": "0630" })[String(cik).replace(/^0+/, "")] || "1231", filings: { recent: Object.fromEntries([
  "form", "reportDate", "filingDate", "acceptanceDateTime", "accessionNumber", "primaryDocument",
].map((field) => [field, entries.map((entry) => entry[field])])) } });
const filing = (overrides = {}) => ({ form: "10-Q", reportDate: "2026-09-30", filingDate: "2026-10-29",
  acceptanceDateTime: "2026-10-29T00:29:06.000Z", accessionNumber: "0001652044-26-000084", primaryDocument: "goog-20260930.htm", ...overrides });
const skFeed = `<rss><channel><item><title>SK hynix Announces 3Q26 Financial Results</title>
  <link>https://news.skhynix.com/en/q3-2026-business-results/</link><pubDate>Tue, 27 Oct 2026 23:29:15 +0000</pubDate></item>
  <item><title>SK hynix Announces 4Q26 Earnings Conference Call Invitation</title><link>https://news.skhynix.com/en/q4-call/</link><pubDate>Thu, 05 Nov 2026 08:00:00 +0000</pubDate></item>
  <item><title>SK hynix Announces 4Q26 Financial Results</title><link>https://news.skhynix.com/en/q4-2026-business-results/</link><pubDate>Thu, 28 Jan 2027 08:00:00 +0000</pubDate></item></channel></rss>`;

test("SEC parser proves quarterly reports, not later filing dates or unrelated 8-Ks", () => {
  const rows = parseSecEarnings(sec("0001652044", [filing(), filing({ form: "8-K", reportDate: "2026-11-04" })]), "GOOG", at);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].period, "2026 Q3");
  assert.equal(rows[0].periodEnd, "2026-09-30");
  assert.equal(rows[0].publishedAt, "2026-10-29T00:29:06.000Z");
  assert.match(rows[0].source, /\/1652044\/000165204426000084\/goog-20260930.htm$/);
  assert.equal(applyEarningsChecks([{ ticker: "GOOG", period: "2026 Q3", released: "2026-10-28" }], {
    version: 1, sources: { GOOG: { checkedAt: at, attemptedAt: at, error: null, reports: rows } },
  }, Date.parse(at)).aiEarnings[0].reviewRequired, false);
});

test("an unrecognized fiscal calendar keeps exact SEC dates without guessing a fiscal quarter", () => {
  const data = sec("1045810", [filing({ reportDate: "2026-07-26" })]);
  data.fiscalYearEnd = "0731";
  const report = parseSecEarnings(data, "NVDA", at)[0];
  assert.equal(report.period, null);
  assert.equal(report.periodEnd, "2026-07-26");
});

test("fiscal period normalization handles weekly quarter ends without shifting calendar years", () => {
  for (const [ticker, cik, end, form, expected] of [
    ["NVDA", "1045810", "2026-07-26", "10-Q", "FY2027 Q2"],
    ["AVGO", "1730168", "2026-08-02", "10-Q", "FY2026 Q3"],
    ["MU", "723125", "2026-09-03", "10-K", "FY2026 Q4"],
    ["MSFT", "789019", "2026-09-30", "10-Q", "FY2027 Q1"],
  ]) {
    const rows = parseSecEarnings(sec(cik, [filing({ form, reportDate: end })]), ticker, at);
    assert.equal(rows[0].period, expected, ticker);
  }
});

test("malformed, future and wrong-company SEC responses cannot create report evidence", () => {
  assert.throws(() => parseSecEarnings(sec("789019", [filing()]), "GOOG", at), /identity/i);
  const broken = sec("1652044", [filing()]); broken.filings.recent.reportDate.pop();
  assert.throws(() => parseSecEarnings(broken, "GOOG", at), /array|column/i);
  for (const item of [filing({ acceptanceDateTime: "2026-11-06T12:00:00.000Z" }), filing({ reportDate: "2026-12-31" }), filing({ primaryDocument: "../bad.htm" })]) {
    assert.throws(() => parseSecEarnings(sec("1652044", [item]), "GOOG", at), /report|document/i);
  }
});

test("SK official RSS distinguishes released results from invitations and future publications", () => {
  const rows = parseSkEarningsFeed(skFeed, at);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].period, "2026 Q3");
  assert.equal(rows[0].publishedAt, "2026-10-27T23:29:15.000Z");
  assert.throws(() => parseSkEarningsFeed("<html>Access denied</html>", at), /RSS|feed/i);
});

test("refresh shares work, retains evidence on failure, and naturally retries", async () => {
  let clock = new Date(at); let calls = 0; let fail = false;
  const service = createEarningsMonitor({ aiEarnings: [{ ticker: "GOOG" }], now: () => clock, logger: { warn() {} },
    fetchText: async () => { calls++; if (fail) throw new Error("HTTP 403"); return JSON.stringify(sec("1652044", [filing()])); },
  });
  const first = service.refresh(); assert.equal(service.refresh(), first); await first;
  assert.equal(calls, 1);
  await service.refresh(); assert.equal(calls, 1);
  clock = new Date(Date.parse(at) + 7 * 3_600_000); fail = true;
  await service.refresh();
  const failed = service.snapshot().sources.GOOG;
  assert.equal(failed.reports.length, 1);
  assert.equal(failed.checkedAt, at);
  assert.equal(failed.attemptedAt, clock.toISOString());
  assert.match(failed.error, /403/);
  clock = new Date(clock.getTime() + 31 * 60_000); fail = false;
  await service.refresh(); assert.equal(service.snapshot().sources.GOOG.error, null);
  const restored = createEarningsMonitor({ aiEarnings: [{ ticker: "GOOG" }], fetchText: async () => { throw Error("offline"); }, now: () => clock, logger: { warn() {} } });
  restored.hydrate(service.snapshot()); await restored.refresh();
  assert.equal(restored.snapshot().sources.GOOG.reports.length, 1);
});

test("TSM requires an actual quarterly earnings exhibit, never monthly revenue 6-K metadata", async () => {
  const records = [
    filing({ form: "6-K", reportDate: "2026-09-30", accessionNumber: "0001046179-26-000728", primaryDocument: "tsm-monthend6kx20261022.htm" }),
    filing({ form: "6-K", reportDate: "2026-09-30", accessionNumber: "0001046179-26-000726", primaryDocument: "tsm-20261015x6k.htm", acceptanceDateTime: "2026-10-15T10:40:56.000Z" }),
  ];
  const service = createEarningsMonitor({ aiEarnings: [{ ticker: "TSM" }], now: () => new Date(at), logger: { warn() {} }, fetchText: async (url) => {
    if (url === earningsMonitorSources.TSM) return JSON.stringify(sec("1046179", records));
    if (url.endsWith("tsm-20261015x6k.htm")) return '<a href="a3q26e_withguidancexfinal.htm">Press release issued by TSMC on October 15, 2026</a>';
    if (url.endsWith("a3q26e_withguidancexfinal.htm")) return '<h1>TSMC Reports Third Quarter EPS of NT$29.43</h1><p>HSINCHU, Taiwan, October 15, 2026. Third quarter 2026 net revenue and net income.</p>';
    throw Error("Unexpected monthly document request");
  } });
  await service.refresh();
  const record = service.snapshot().sources.TSM;
  assert.equal(record.error, null);
  assert.equal(record.reports[0].period, "2026 Q3");
  assert.match(record.reports[0].source, /a3q26e_withguidancexfinal.htm$/);
  const monthlyOnly = createEarningsMonitor({ aiEarnings: [{ ticker: "TSM" }], now: () => new Date(at), logger: { warn() {} },
    fetchText: async () => JSON.stringify(sec("1046179", records.slice(0, 1))),
  });
  await monthlyOnly.refresh();
  assert.equal(monthlyOnly.snapshot().sources.TSM.reports.length, 0);
  assert.match(monthlyOnly.snapshot().sources.TSM.error, /quarterly|exhibit/i);
});

test("the monitor budget reaches fetchText and queued companies do not start after exhaustion", async () => {
  let calls = 0;
  const started = Date.now();
  const service = createEarningsMonitor({ aiEarnings: [{ ticker: "NVDA" }, { ticker: "AVGO" }, { ticker: "GOOG" }],
    fetchBudgetMs: 20, logger: { warn() {} }, fetchText: async (_url, _headers, deadline) => {
      calls++;
      assert.ok(Number.isFinite(deadline) && deadline <= started + 100);
      await new Promise((resolve) => setTimeout(resolve, Math.max(0, deadline - Date.now())));
      throw new Error("test body deadline");
    },
  });
  await service.refresh();
  assert.equal(calls, 1);
  assert.ok(Object.values(service.snapshot().sources).every((source) => source.error && !source.reports.length));
});

test("onChange publishes each company's evidence while another source remains pending", async () => {
  let release;
  const held = new Promise((resolve) => { release = resolve; });
  let observed;
  const notified = new Promise((resolve) => { observed = resolve; });
  let finished = false;
  const service = createEarningsMonitor({ aiEarnings: [{ ticker: "GOOG" }, { ticker: "MSFT" }],
    now: () => new Date(at), logger: { warn() {} },
    fetchText: async (url) => {
      if (url.includes("CIK0000789019")) { await held; return JSON.stringify(sec("789019", [filing({ primaryDocument: "msft-20260930.htm" })])); }
      return JSON.stringify(sec("1652044", [filing()]));
    },
    onChange: async (snapshot) => { if (snapshot.sources.GOOG.reports.length) observed(snapshot); },
  });
  const pending = service.refresh().then(() => { finished = true; });
  let notificationTimer;
  try {
    const early = await Promise.race([notified, new Promise((resolve) => { notificationTimer = setTimeout(() => resolve(null), 700); })]);
    assert.ok(early, "No per-company notification arrived before the held source finished");
    assert.equal(finished, false);
    assert.equal(early.sources.GOOG.reports.length, 1);
    assert.equal(early.sources.MSFT.reports.length, 0);
    early.sources.GOOG.reports[0].title = "callback-owned copy";
    assert.notEqual(service.snapshot().sources.GOOG.reports[0].title, "callback-owned copy");
  } finally { clearTimeout(notificationTimer); release(); await pending; }
});

test("onChange rejection is separate from provider status and does not stop remaining companies", async () => {
  const warnings = []; let notifications = 0;
  const service = createEarningsMonitor({ aiEarnings: [{ ticker: "GOOG" }, { ticker: "MSFT" }],
    now: () => new Date(at), logger: { warn: (message) => warnings.push(message) },
    fetchText: async (url) => JSON.stringify(sec(url.includes("CIK0000789019") ? "789019" : "1652044", [filing()])),
    onChange: async () => { notifications++; if (notifications === 1) throw new Error("test persistence failed"); },
  });
  await service.refresh();
  assert.equal(notifications, 2);
  assert.ok(Object.values(service.snapshot().sources).every((record) => record.error === null && record.reports.length === 1));
  assert.equal(warnings.length, 1);
  assert.match(warnings[0], /onChange.*test persistence failed/);
});

test("checkpoint hydration retains last successful evidence across a newer unknown failure in either order", () => {
  const reports = parseSecEarnings(sec("1652044", [filing()]), "GOOG", at);
  const successTime = "2026-11-04T12:00:00.000Z";
  const attemptTime = "2026-11-05T11:00:00.000Z";
  const good = { version: 1, sources: { GOOG: { checkedAt: successTime, attemptedAt: successTime, error: null, reports } } };
  const failed = { version: 1, sources: { GOOG: { checkedAt: null, attemptedAt: attemptTime, error: "new host upstream outage", reports: [] } } };
  assert.equal(isEarningsSchedule(good), true);
  assert.equal(isEarningsSchedule(failed), true);
  const results = [];
  for (const order of [[good, failed], [failed, good]]) {
    let calls = 0;
    const monitor = createEarningsMonitor({ aiEarnings: [{ ticker: "GOOG" }], now: () => new Date(at),
      fetchText: async () => { calls++; throw new Error("Hydration must not fetch"); },
    });
    for (const checkpoint of order) monitor.hydrate(checkpoint);
    const merged = monitor.snapshot();
    assert.equal(calls, 0);
    assert.equal(isEarningsSchedule(merged), true);
    assert.equal(merged.sources.GOOG.checkedAt, successTime, "A failed attempt must not erase or advance successful verification time");
    assert.equal(merged.sources.GOOG.attemptedAt, attemptTime);
    assert.equal(merged.sources.GOOG.error, "new host upstream outage");
    assert.deepEqual(merged.sources.GOOG.reports, reports);
    const projected = applyEarningsChecks([{ ticker: "GOOG", period: "2026 Q2", released: "2026-07-22" }], merged, Date.parse(at));
    assert.equal(projected.aiEarnings[0].reviewRequired, true);
    assert.match(projected.errors.join(" "), /upstream outage/);
    results.push(merged);
  }
  assert.deepEqual(results[0], results[1]);
});
