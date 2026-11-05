import test from "node:test";
import assert from "node:assert/strict";
import { cp, mkdtemp, readFile, readdir, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { once } from "node:events";
import { spawn } from "node:child_process";
import { isDashboardSnapshot, projectDashboard } from "./public/dashboard-state.js";

const project = new URL("./", import.meta.url);
const clock = "2026-11-05T12:00:00.000Z";
const cachedAt = "2026-11-05T11:55:00.000Z";
const checkedAt = "2026-11-05T11:59:00.000Z";
const sample = JSON.parse(await readFile(new URL("dashboard-cache.json", project), "utf8"));
const historical = JSON.parse(await readFile(new URL("fixtures/earnings-data.json", project), "utf8"));
const profiles = [
  ["NVDA", "1045810", "FY2027 Q2", "2026-07-26", "2026-08-26T20:36:00.000Z", "10-Q", "0125", "000104581026000075", "nvda-20260726.htm", "2026-08-26"],
  ["AVGO", "1730168", "FY2026 Q3", "2026-08-02", "2026-09-09T21:56:42.000Z", "10-Q", "1102", "000173016826000080", "avgo-20260802.htm", "2026-09-02"],
  ["TSM", "1046179", "2026 Q3", "2026-09-30", "2026-10-15T10:40:56.000Z", "earnings-release", "1231", "000104617926000726", "a3q26e_withguidancexfinal.htm", "2026-10-15"],
  ["MSFT", "789019", "FY2027 Q1", "2026-09-30", "2026-10-28T20:07:39.000Z", "10-Q", "0630", "000119312526436133", "msft-20260930.htm", "2026-10-28"],
  ["GOOG", "1652044", "2026 Q3", "2026-09-30", "2026-10-29T00:29:06.000Z", "10-Q", "1231", "000165204426000084", "goog-20260930.htm", "2026-10-28"],
  ["AMZN", "1018724", "2026 Q3", "2026-09-30", "2026-10-29T22:20:46.000Z", "10-Q", "1231", "000101872426000040", "amzn-20260930.htm", "2026-10-29"],
  ["MU", "723125", "FY2026 Q4", "2026-09-03", "2026-10-09T12:21:00.000Z", "10-K", "0903", "000072312526000023", "mu-20260903.htm", "2026-09-30"],
  ["000660.KS", null, "2026 Q3", "2026-09-30", "2026-10-27T23:29:15.000Z", "earnings-release", null, null, null, "2026-10-28"],
].map(([ticker, cik, period, periodEnd, publishedAt, form, fiscalYearEnd, accession, document, released]) => ({
  ticker, cik, fiscalYearEnd, accession, document, released,
  proof: { period, periodEnd, publishedAt, form, title: `${ticker} official ${period} results`,
    source: cik ? `https://www.sec.gov/Archives/edgar/data/${cik}/${accession}/${document}` : "https://news.skhynix.com/en/q3-2026-business-results/" },
}));
const schedule = { version: 1, sources: Object.fromEntries(profiles.map(({ ticker, proof }) => [ticker,
  { checkedAt, attemptedAt: checkedAt, error: null, reports: [proof] },
])) };

function reviewedRows({ current = false } = {}) {
  return historical.aiEarnings.map((row) => {
    const profile = profiles.find((item) => item.ticker === row.ticker);
    return { ...row, period: current ? profile.proof.period : row.period,
      // The recent dates in the old-quarter scenario deliberately isolate the
      // report-evidence guard from the independent 120-day/quarterly age guard.
      released: current ? profile.released : "2026-10-20",
      nextReportDate: null, nextReportEstimatedDate: null, nextReportStatus: "pending",
      nextReportLabel: "待官宣", nextReportSource: null,
    };
  });
}

function baseline(rows, savedSchedule) {
  const cache = { ...structuredClone(sample), generatedAt: cachedAt, dataQualityVersion: 1,
    errors: [], aiEarnings: rows,
    calendarSchedule: { cpi: [], employment: [], fomc: [], earnings: {}, pastEarnings: {}, updatedAt: null, sources: {} },
  };
  delete cache.publicationSchedule;
  delete cache.earningsSchedule;
  const projected = projectDashboard(cache, Date.parse(clock));
  assert.equal(projected.coverage, 90);
  assert.equal(projected.indicators.find((item) => item.id === "aiEarnings").available, true);
  assert.ok(projected.aiEarnings.every((row) => !row.snapshotStale && row.snapshotAgeDays < 120));
  if (savedSchedule) projected.earningsSchedule = structuredClone(savedSchedule);
  assert.equal(isDashboardSnapshot(projected), true);
  return projected;
}

const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
async function until(check, message, timeout = 15_000) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    const result = await check();
    if (result) return result;
    await pause(20);
  }
  assert.fail(message());
}

function mockSources(mode) {
  return `
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
    const profiles = ${JSON.stringify(profiles)};
    let release;
    const gate = new Promise((resolve) => { release = resolve; });
    process.on("message", (message) => { if (message.type === "release-earnings") release(); });
    globalThis.fetch = async (raw) => {
      const url = new URL(raw);
      if (url.pathname.endsWith("/earnings-date")) return new Response(JSON.stringify({ data: null }));
      const earningsSource = url.hostname === "data.sec.gov" || url.hostname === "www.sec.gov" || url.hostname === "news.skhynix.com";
      if (!earningsSource) {
        if (${JSON.stringify(mode)} === "partial" && (url.pathname.includes("/graph/fredgraph.csv") || url.pathname.includes("/quote/"))) await gate;
        throw new Error("test market/calendar/publication outage");
      }
      process.send({ type: "earnings-request", url: String(raw) });
      if (${JSON.stringify(mode)} === "offline") throw new Error("test official earnings offline");
      if (${JSON.stringify(mode)} === "gated") await gate;
      if (${JSON.stringify(mode)} === "partial" && url.pathname.includes("CIK0001045810")) {
        process.send({ type: "held-earnings", url: String(raw) });
        await gate;
      }
      if (url.hostname === "data.sec.gov") {
        const profile = profiles.find((item) => item.cik && url.pathname === "/submissions/CIK" + item.cik.padStart(10, "0") + ".json");
        if (!profile) throw new Error("Unexpected SEC company");
        const proof = profile.proof;
        const row = { form: profile.ticker === "TSM" ? "6-K" : proof.form, reportDate: proof.periodEnd,
          filingDate: proof.publishedAt.slice(0, 10), acceptanceDateTime: proof.publishedAt,
          accessionNumber: profile.accession.slice(0, 10) + "-" + profile.accession.slice(10, 12) + "-" + profile.accession.slice(12),
          primaryDocument: profile.ticker === "TSM" ? "tsm-20261015x6k.htm" : profile.document };
        const recent = Object.fromEntries(Object.entries(row).map(([key, value]) => [key, [value]]));
        return new Response(JSON.stringify({ cik: profile.cik, fiscalYearEnd: profile.fiscalYearEnd, filings: { recent } }));
      }
      if (url.hostname === "www.sec.gov" && url.pathname.endsWith("tsm-20261015x6k.htm")) {
        return new Response('<a href="a3q26e_withguidancexfinal.htm">Press release issued by TSMC on October 15, 2026</a>');
      }
      if (url.hostname === "www.sec.gov" && url.pathname.endsWith("a3q26e_withguidancexfinal.htm")) {
        return new Response('<h1>TSMC Reports Third Quarter EPS of NT$29.43</h1><p>Third quarter 2026 net revenue and net income.</p>');
      }
      if (url.hostname === "news.skhynix.com") return new Response('<rss><channel><item><title>SK hynix Announces 3Q26 Financial Results</title><link>https://news.skhynix.com/en/q3-2026-business-results/</link><pubDate>Tue, 27 Oct 2026 23:29:15 +0000</pubDate></item></channel></rss>');
      throw new Error("Unmocked official earnings source");
    };
  `;
}

async function withIsolatedBoard(rows, cache, check) {
  const dir = await mkdtemp(path.join(tmpdir(), "radar-earnings-integration-"));
  const instances = [];
  try {
    // Copy every production module so unrelated new runtime dependencies cannot
    // silently make this isolated regression exercise an incomplete old server.
    for (const entry of await readdir(project, { withFileTypes: true })) {
      if (entry.isFile() && entry.name.endsWith(".mjs") && !entry.name.endsWith(".test.mjs")) await cp(new URL(entry.name, project), path.join(dir, entry.name));
    }
    for (const name of ["public", "package.json", "fixtures"]) await cp(new URL(name, project), path.join(dir, name), { recursive: true });
    await writeFile(path.join(dir, "earnings-data.mjs"), `export const aiEarnings = ${JSON.stringify(rows)};\nexport const aiChainLayers = ${JSON.stringify(historical.aiChainLayers)};\n`);
    await writeFile(path.join(dir, "dashboard-cache.json"), JSON.stringify(cache));
    const start = async (mode) => {
      const preload = path.join(dir, `preload-${instances.length}.mjs`);
      await writeFile(preload, mockSources(mode));
      const child = spawn(process.execPath, ["--import", preload, path.join(dir, "server.mjs")], {
        cwd: dir, env: { ...process.env, HOST: "127.0.0.1", PORT: "0" }, stdio: ["ignore", "pipe", "pipe", "ipc"],
      });
      const messages = []; let output = "";
      child.stdout.on("data", (chunk) => { output += chunk; });
      child.stderr.on("data", (chunk) => { output += chunk; });
      child.on("message", (message) => messages.push(message));
      const stop = async () => {
        if (child.exitCode === null && child.signalCode === null) {
          const exited = once(child, "exit"); child.kill("SIGTERM"); await exited;
        }
      };
      const instance = { stop, messages };
      instances.push(instance);
      const listening = await until(() => messages.find((message) => message.type === "listening"), () => `Server did not listen: ${output}`);
      instance.read = async () => {
        const response = await fetch(`http://127.0.0.1:${listening.port}/api/dashboard`, { signal: AbortSignal.timeout(3000) });
        assert.equal(response.status, 200);
        const body = await response.json(); assert.equal(isDashboardSnapshot(body), true); return body;
      };
      instance.finished = () => until(async () => {
        const body = await instance.read(); return !body.refreshing ? body : null;
      }, () => `Refresh did not finish: ${output}`);
      instance.release = () => new Promise((resolve, reject) => child.send({ type: "release-earnings" }, (error) => error ? reject(error) : resolve()));
      return instance;
    };
    await check({ start, dir });
  } finally {
    for (const instance of instances) await instance.stop();
    await rm(dir, { recursive: true, force: true });
  }
}

function assertReviewedText(body, rows) {
  for (const row of rows) {
    const result = body.aiEarnings.find((item) => item.ticker === row.ticker);
    for (const field of ["period", "released", "revenue", "netIncome", "grossMargin", "guidance", "guidanceTone", "resultTone", "source"]) assert.equal(result[field], row[field], `${row.ticker}.${field} was rewritten`);
    assert.equal(result.snapshotStale, false, `${row.ticker} was disabled by the independent age guard`);
    assert.ok(result.snapshotAgeDays >= 0 && result.snapshotAgeDays < 120);
  }
}

function assertSixNewReports(body, rows, expectedProofs = profiles) {
  assertReviewedText(body, rows);
  assert.deepEqual(body.aiEarnings.filter((row) => row.reviewRequired).map((row) => row.ticker).sort(), ["TSM", "MSFT", "GOOG", "AMZN", "MU", "000660.KS"].sort());
  const ai = body.indicators.find((row) => row.id === "aiEarnings");
  assert.equal(ai.available, false); assert.equal(ai.risk, null); assert.equal(ai.points, null);
  assert.equal(ai.value, "2 / 8 家"); assert.equal(ai.weight, 5); assert.equal(body.coverage, 85);
  assert.equal(body.generatedAt, cachedAt, "A lower-coverage failed refresh replaced the last usable market board");
  for (const profile of expectedProofs) {
    assert.equal(body.aiEarnings.find((row) => row.ticker === profile.ticker).latestReport.source, profile.proof.source);
    assert.ok(body.earningsSchedule.sources[profile.ticker].reports.some((report) => report.source === profile.proof.source));
  }
}

test("saved new-report evidence retires old guidance before HTTP response and survives an offline restart", async () => {
  const rows = reviewedRows();
  await withIsolatedBoard(rows, baseline(rows, schedule), async ({ start, dir }) => {
    const first = await start("offline");
    assertSixNewReports(await first.read(), rows);
    assertSixNewReports(await first.finished(), rows);
    const stored = JSON.parse(await readFile(path.join(dir, "dashboard-cache.json"), "utf8"));
    assertSixNewReports(stored, rows);
    await first.stop();
    const restarted = await start("offline");
    assertSixNewReports(await restarted.read(), rows);
    assertSixNewReports(await restarted.finished(), rows);
  });
});

test("new SEC/RSS evidence updates a high-coverage cached board without changing its reviewed prose", async () => {
  const rows = reviewedRows();
  await withIsolatedBoard(rows, baseline(rows), async ({ start, dir }) => {
    const server = await start("gated");
    await until(() => server.messages.some((message) => message.type === "earnings-request"), () => "The monitor never requested its mocked official sources");
    const before = await server.read();
    assertReviewedText(before, rows);
    assert.equal(before.indicators.find((row) => row.id === "aiEarnings").available, true);
    assert.equal(before.coverage, 90);
    assert.ok(before.aiEarnings.every((row) => !row.reviewRequired));
    await server.release();
    const after = await server.finished();
    assertSixNewReports(after, rows);
    const stored = JSON.parse(await readFile(path.join(dir, "dashboard-cache.json"), "utf8"));
    assertSixNewReports(stored, rows);
    await server.stop();
    const restarted = await start("offline");
    assertSixNewReports(await restarted.read(), rows);
  });
});

test("same-quarter SEC filings later than reviewed press releases preserve the AI weight", async () => {
  const rows = reviewedRows({ current: true });
  await withIsolatedBoard(rows, baseline(rows, schedule), async ({ start }) => {
    const server = await start("offline");
    for (const body of [await server.read(), await server.finished()]) {
      assertReviewedText(body, rows);
      assert.ok(body.aiEarnings.every((row) => !row.reviewRequired));
      assert.equal(body.indicators.find((row) => row.id === "aiEarnings").available, true);
      assert.equal(body.indicators.find((row) => row.id === "aiEarnings").value, "8 / 8 家");
      assert.equal(body.coverage, 90);
    }
  });
});

test("early company evidence reaches disk before an unrelated held source and survives a crash restart", async () => {
  const rows = reviewedRows();
  const completedProfiles = profiles.filter((profile) => profile.ticker !== "NVDA");
  await withIsolatedBoard(rows, baseline(rows), async ({ start, dir }) => {
    const server = await start("partial");
    await until(() => server.messages.some((message) => message.type === "held-earnings"), () => "The unrelated NVDA source was not held");
    const early = await until(async () => {
      const body = await server.read();
      return body.aiEarnings.filter((row) => row.reviewRequired).length === 6 ? body : null;
    }, () => "Completed company proofs were not visible while NVDA remained pending");
    assert.equal(early.refreshing, true);
    assertSixNewReports(early, rows, completedProfiles);
    const stored = await until(async () => {
      const body = JSON.parse(await readFile(path.join(dir, "dashboard-cache.json"), "utf8"));
      return body.aiEarnings.filter((row) => row.reviewRequired).length === 6 ? body : null;
    }, () => "Completed new-report evidence remained only in process memory", 3000);
    assertSixNewReports(stored, rows, completedProfiles);
    // Neither the held market fetches nor NVDA is released. Killing this process
    // exercises the exact window before the aggregate refresh can ever finish.
    await server.stop();
    const restarted = await start("offline");
    assertSixNewReports(await restarted.read(), rows, completedProfiles);
    assertSixNewReports(await restarted.finished(), rows, completedProfiles);
  });
});
