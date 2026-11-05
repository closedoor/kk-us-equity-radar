import { readFile, writeFile, mkdir, readdir, mkdtemp, rm } from "node:fs/promises";
import { createHash } from "node:crypto";
import { fileURLToPath } from "node:url";
import { tmpdir } from "node:os";
import path from "node:path";
import http from "node:http";
import net from "node:net";
import { spawn, execFileSync } from "node:child_process";
import { once } from "node:events";
import { quarterDates, parseVintageCsv, historyWindow, forwardOutcome, summarizeHistory } from "../history-validation.mjs";
import { parseFredCsv, parseNasdaqRows } from "../market-data.mjs";
import { SCORING_VERSION, INDICATOR_WEIGHTS } from "../public/risk-model.js";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const args = process.argv.slice(2);
const option = (name, fallback) => {
  const index = args.indexOf(name);
  if (index < 0) return fallback;
  if (!args[index + 1] || args[index + 1].startsWith("--")) throw new Error(`Missing ${name}`);
  return args[index + 1];
};
const cacheDir = path.resolve(option("--cache-dir", path.join(tmpdir(), "radar-history-source-cache")));
const out = path.resolve(root, option("--out", "reports/history-validation-2019-2025.json"));
const offline = args.includes("--offline");
const vintages = quarterDates();
const allFredIds = ["DCOILBRENTEU", "CPIAUCSL", "CPIAUCNS", "CPILFESL", "CPILFENS", "PCEPI", "PCEPILFE", "DFEDTARL", "DFEDTARU", "DGS2", "DGS10", "DFII10", "T10Y3M", "VIXCLS", "SP500", "BAMLH0A0HYM2", "DRTSCILM", "SAHMREALTIME", "ICSA", "NFCI", "UNRATE", "PAYEMS"];
const vintageIds = allFredIds.filter((id) => !["SP500", "BAMLH0A0HYM2"].includes(id));
const symbols = ["SPY", "RSP", "XLK", "XLF", "XLY", "XLC", "XLI", "XLV", "XLP", "XLE", "XLU", "XLRE", "XLB"];
const hash = (value) => createHash("sha256").update(value).digest("hex");
const receipts = [];
const sourceFailures = [];
let requestCount = 0;

await mkdir(cacheDir, { recursive: true });
async function fetchSource(url) {
  const key = hash(url);
  const receiptFile = path.join(cacheDir, `${key}.json`);
  const bodyFile = path.join(cacheDir, `${key}.txt`);
  try {
    const receipt = JSON.parse(await readFile(receiptFile, "utf8"));
    const body = await readFile(bodyFile, "utf8");
    if (receipt.url !== url || receipt.sha256 !== hash(body)) throw new Error("Source cache integrity mismatch");
    receipts.push(receipt);
    return { ...receipt, body };
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
    if (offline) throw new Error(`Offline source missing: ${url}`);
  }
  if (++requestCount > 100) throw new Error("Historical source request budget exceeded (100)");
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 30_000);
  try {
    const response = await fetch(url, { signal: controller.signal, headers: { "user-agent": "EquityRadar historical research; public data" } });
    const body = await response.text();
    const receipt = { url, retrievedAt: new Date().toISOString(), status: response.status, bytes: Buffer.byteLength(body), sha256: hash(body) };
    await writeFile(bodyFile, body);
    await writeFile(receiptFile, JSON.stringify(receipt));
    receipts.push(receipt);
    await new Promise((resolve) => setTimeout(resolve, 300));
    return { ...receipt, body };
  } finally { clearTimeout(timer); controller.abort(); }
}

async function mapTwo(items, worker) {
  let cursor = 0;
  const results = new Array(items.length);
  async function run() {
    while (cursor < items.length) {
      const index = cursor++;
      results[index] = await worker(items[index], index);
    }
  }
  await Promise.all([run(), run()]);
  return results;
}

// Snapshot actual production sources before the run. Each quarter starts an
// isolated server with no cache and no network access; no scoring formula is
// copied, fitted or reimplemented in this research runner.
const runtime = await mkdtemp(path.join(tmpdir(), "radar-historical-runtime-"));
const runtimeHashes = {};
let sourceSnapshot;
let activeChild;
try {
  async function runtimePaths() {
    const files = (await readdir(root)).filter((name) => (name.endsWith(".mjs") && !name.endsWith(".test.mjs")) || name === "package.json");
    async function walk(directory) {
      for (const entry of await readdir(path.join(root, directory), { withFileTypes: true })) {
        const name = `${directory}/${entry.name}`;
        if (entry.isDirectory()) await walk(name);
        else if (entry.isFile()) files.push(name);
      }
    }
    await walk("public");
    return files.sort();
  }
  const sourceBaseCommit = execFileSync("git", ["rev-parse", "HEAD"], { cwd: root, encoding: "utf8" }).trim();
  const workingTreeDirty = Boolean(execFileSync("git", ["status", "--porcelain"], { cwd: root, encoding: "utf8" }).trim());
  const names = await runtimePaths();
  const buffers = new Map(await Promise.all(names.map(async (name) => [name, await readFile(path.join(root, name))])));
  // Freeze bytes, not just paths. Reject detected source drift during capture;
  // later working-tree edits cannot affect the already frozen replay server.
  if (JSON.stringify(await runtimePaths()) !== JSON.stringify(names)) throw new Error("Runtime source paths changed during capture; rerun after edits settle");
  for (const [name, bytes] of buffers) {
    if (hash(await readFile(path.join(root, name))) !== hash(bytes)) throw new Error(`Runtime source changed during capture: ${name}`);
    await mkdir(path.dirname(path.join(runtime, name)), { recursive: true });
    await writeFile(path.join(runtime, name), bytes);
    runtimeHashes[name] = hash(bytes);
  }
  if (sourceBaseCommit !== execFileSync("git", ["rev-parse", "HEAD"], { cwd: root, encoding: "utf8" }).trim()) throw new Error("Git HEAD changed during source capture");
  sourceSnapshot = { capturedAt: new Date().toISOString(), baseCommit: sourceBaseCommit, workingTreeDirty,
    kind: "Frozen working-tree bytes; baseCommit is lineage, not a claim of a clean commit",
    runnerSha256: hash(await readFile(fileURLToPath(import.meta.url))), runtimeHashes: { ...runtimeHashes }, syntheticOverrides: [] };
  const historicalCompanies = ["NVDA", "AVGO", "TSM", "MSFT", "GOOG", "AMZN", "MU", "SKHY"].map((ticker) => ({ ticker, company: ticker, released: null, source: "https://www.sec.gov/", guidanceTone: null, resultTone: null }));
  await writeFile(path.join(runtime, "earnings-data.mjs"), `export const aiEarnings = ${JSON.stringify(historicalCompanies)};\nexport const aiChainLayers = [];\n`);
  await writeFile(path.join(runtime, "historical-preload.mjs"), `
    import {readFileSync} from 'node:fs';
    const input = JSON.parse(readFileSync(new URL('./historical-input.json', import.meta.url), 'utf8'));
    const NativeDate = Date;
    const clock = NativeDate.parse(input.asOf + 'T23:59:59.000Z');
    globalThis.Date = class extends NativeDate {
      constructor(...args) { super(...(args.length ? args : [clock])); }
      static now() { return clock; }
    };
    globalThis.fetch = async(value) => {
      const url = new URL(value);
      if(url.hostname === 'fred.stlouisfed.org' && url.pathname === '/graph/fredgraph.csv') {
        const id = url.searchParams.get('id');
        if(!Object.hasOwn(input.fred,id)) throw new Error('No historical vintage for ' + id);
        return new Response('observation_date,' + id + '\\n' + input.fred[id].map(row=>row.date+','+row.value).join('\\n'));
      }
      const match = url.hostname === 'api.nasdaq.com' && url.pathname.match(/^\\/api\\/quote\\/([A-Z]+)\\/historical$/);
      if(match) {
        const rows = (input.market[match[1]] || []).map(row => ({ date: row.date.slice(5,7)+'/'+row.date.slice(8,10)+'/'+row.date.slice(0,4), close: String(row.value) }));
        return new Response(JSON.stringify({data:{tradesTable:{rows}}}));
      }
      throw new Error('Historical replay: no point-in-time release/calendar/earnings evidence');
    };
  `);
  for (const name of ["earnings-data.mjs", "historical-preload.mjs"]) {
    sourceSnapshot.syntheticOverrides.push({ path: name, sha256: hash(await readFile(path.join(runtime, name))),
      reason: name === "earnings-data.mjs" ? "All reviewed historical earnings judgments unavailable" : "Fixed as-of clock and network-isolated source replay" });
  }

  const sahmPage = await fetchSource("https://alfred.stlouisfed.org/series/downloaddata?seid=SAHMREALTIME");
  if (sahmPage.status !== 200) throw new Error("Cannot establish Sahm archive availability");
  const select = sahmPage.body.match(/<select[^>]*id="form_selected_vintage_dates"[\s\S]*?<\/select>/)?.[0];
  const sahmDates = [...(select?.matchAll(/value="(\d{4}-\d{2}-\d{2})"/g) || [])].map((match) => match[1]).sort();
  if (!sahmDates.length) throw new Error("Cannot parse Sahm vintage dates");
  const earliestSahmVintage = sahmDates[0];
  const fredByVintage = Object.fromEntries(vintages.map((date) => [date, {}]));
  const jobs = vintageIds.flatMap((id) => {
    const dates = id === "SAHMREALTIME" ? vintages.filter((date) => date >= earliestSahmVintage) : vintages;
    return Array.from({ length: Math.ceil(dates.length / 12) }, (_, index) => ({ id, dates: dates.slice(index * 12, index * 12 + 12) }));
  });
  await mapTwo(jobs, async ({ id, dates }, index) => {
    const url = new URL("https://alfred.stlouisfed.org/graph/alfredgraph.csv");
    url.searchParams.set("id", dates.map(() => id).join(","));
    url.searchParams.set("vintage_date", dates.join(","));
    url.searchParams.set("cosd", "2016-01-01");
    url.searchParams.set("coed", dates.at(-1));
    try {
      const source = await fetchSource(url.href);
      if (source.status !== 200) { sourceFailures.push({ id, dates, reason: `ALFRED HTTP ${source.status}` }); return; }
      const columns = parseVintageCsv(source.body, id, dates);
      for (const date of dates) fredByVintage[date][id] = historyWindow(columns[date], date, 3);
    } catch (error) {
      // Integrity failures are fatal. An unverified/current response is never
      // silently substituted for an unavailable historical vintage.
      if (/header|Malformed|Future|Conflicting|Invalid vintage|integrity|Offline source missing/i.test(error.message)) throw error;
      sourceFailures.push({ id, dates, reason: error.message });
    }
    if ((index + 1) % 10 === 0) console.log(`Archived macro batches ${index + 1}/${jobs.length}`);
  });
  const market = {};
  await mapTwo(symbols, async (symbol) => {
    const url = `https://api.nasdaq.com/api/quote/${symbol}/historical?assetclass=etf&fromdate=2016-01-01&todate=2025-12-31&limit=5000`;
    try {
      const response = await fetchSource(url);
      if (response.status !== 200) throw new Error(`Nasdaq HTTP ${response.status}`);
      const payload = JSON.parse(response.body);
      const raw = payload?.data?.tradesTable?.rows;
      const total = Number(payload?.data?.totalRecords);
      if (!Array.isArray(raw) || !Number.isInteger(total) || total < 0 || total !== raw.length) throw new Error("Historical prices missing or truncated");
      market[symbol] = parseNasdaqRows(raw);
      if (market[symbol].length !== raw.length) throw new Error("Historical prices contain unusable or duplicate observations");
    } catch (error) {
      if (offline || /integrity/i.test(error.message)) throw error;
      market[symbol] = [];
      sourceFailures.push({ id: symbol, reason: error.message });
    }
  });
  const priceSource = await fetchSource("https://fred.stlouisfed.org/graph/fredgraph.csv?id=SP500&cosd=2016-01-01&coed=2026-11-05");
  if (priceSource.status !== 200 || !/^observation_date,SP500\r?\n/.test(priceSource.body)) throw new Error("S&P price outcome source unavailable or malformed");
  const prices = parseFredCsv(priceSource.body);
  if (!prices.length) throw new Error("No S&P price observations");

  async function replay(input) {
    await writeFile(path.join(runtime, "historical-input.json"), JSON.stringify(input));
    await writeFile(path.join(runtime, "dashboard-cache.json"), "{}");
    const reservation = net.createServer();
    await new Promise((resolve) => reservation.listen(0, "127.0.0.1", resolve));
    const port = reservation.address().port;
    await new Promise((resolve) => reservation.close(resolve));
    const child = spawn(process.execPath, ["--import", path.join(runtime, "historical-preload.mjs"), path.join(runtime, "server.mjs")], {
      cwd: runtime, env: { ...process.env, HOST: "127.0.0.1", PORT: String(port) }, stdio: ["ignore", "pipe", "pipe"],
    });
    activeChild = child;
    let logs = "";
    child.stdout.on("data", (chunk) => logs += chunk);
    child.stderr.on("data", (chunk) => logs += chunk);
    try {
      const deadline = Date.now() + 15_000;
      while (Date.now() < deadline && child.exitCode === null) {
        if (logs.includes("已启动")) {
          const result = await new Promise((resolve, reject) => {
            const request = http.get({ hostname: "127.0.0.1", port, path: "/api/dashboard", agent: false }, (response) => {
              let body = "";
              response.setEncoding("utf8");
              response.on("data", (chunk) => body += chunk);
              response.on("end", () => { try { resolve({ status: response.statusCode, body: JSON.parse(body) }); } catch (error) { reject(error); } });
              response.on("error", reject);
            });
            request.on("error", reject);
            request.setTimeout(2000, () => request.destroy(new Error("Replay HTTP deadline")));
          });
          if (result.status === 200 && !result.body.refreshing) return result.body;
        }
        await new Promise((resolve) => setTimeout(resolve, 50));
      }
      throw new Error(`Production replay did not finish for ${input.asOf}: ${logs.slice(-1000)}`);
    } finally {
      if (child.exitCode === null && child.signalCode === null) { const ended = once(child, "exit"); child.kill("SIGTERM"); await ended; }
      activeChild = null;
    }
  }

  const rows = [];
  for (const asOf of vintages) {
    const fred = { ...fredByVintage[asOf], SP500: historyWindow(prices, asOf, 3) };
    const marketAtDate = Object.fromEntries(symbols.map((symbol) => [symbol, historyWindow(market[symbol], asOf, 2)]));
    const input = { asOf, fred, market: marketAtDate };
    const snapshot = await replay(input);
    for (const id of ["aiEarnings", "earningsBreadth", "credit"]) {
      if (snapshot.indicators.find((row) => row.id === id)?.available) throw new Error(`Unsupported historical input became scoreable: ${id}`);
    }
    rows.push({ asOf, inputSha256: hash(JSON.stringify(input)), score: snapshot.score, coverage: snapshot.coverage,
      indicators: snapshot.indicators.map(({ id, risk, weight, available, unavailableReason }) => ({ id, risk, weight, available, unavailableReason })),
      missing: snapshot.indicators.filter((row) => !row.available).map(({ id, weight, unavailableReason }) => ({ id, weight, reason: id === "credit" ? "No archived spread vintage; whole composite excluded" : ["aiEarnings", "earningsBreadth"].includes(id) ? "No historical reviewed judgments" : unavailableReason })),
      sourceErrors: snapshot.errors,
      outcomes: Object.fromEntries([21, 63].map((horizon) => [horizon, forwardOutcome(prices, asOf, horizon)])),
    });
    console.log(`Replayed ${asOf}: coverage ${snapshot.coverage}%, score ${snapshot.score ?? "unavailable"}`);
  }
  const report = {
    schemaVersion: 1, generatedAt: new Date().toISOString(), scoringVersion: SCORING_VERSION, sourceSnapshot,
    status: sourceFailures.length ? "incomplete-source-coverage; full-model-validation-not-established" : "descriptive-partial-model; full-model-validation-not-established",
    validatedClaims: { archivedMacroVintages: true, historicalProviderPriceVintages: false, completeLiveModel: false,
      independentOutOfSample: false, calibratedProbability: false, allocationThresholds: false },
    design: { sample: "Every calendar quarter-end, 2019–2025, specified before inspecting outcomes; no event selection", observations: vintages.length,
      macroInputs: "Archived ALFRED vintages with exact requested column dates; no latest-revision fallback",
      marketInputs: "Historical market closes retrieved now, without a historical provider-publication vintage guarantee",
      excludedWeights: { aiEarnings: INDICATOR_WEIGHTS.aiEarnings, earningsBreadth: INDICATOR_WEIGHTS.earningsBreadth, credit: INDICATOR_WEIGHTS.credit },
      maximumCoverage: 70, earliestSahmVintage, entryRule: "First available S&P close strictly after as-of date; then 21 or 63 further valid closing observations",
      outcome: "S&P 500 price-index return and peak-to-trough closing drawdown; excludes dividends, execution costs, taxes and strategy allocation",
      tuning: "No coefficient, threshold, band or date selection was fitted to these outcomes", cache: "Independent cold production-server replay at each date; no current release proofs or curated earnings judgments", seed: "No randomness" },
    limitations: [
      "This is a partial automated model; its scores and regimes are not the complete live model and cannot calibrate full-model allocation prompts.",
      "ALFRED dates do not guarantee intraday publication/ingestion times; data are treated as known only after the vintage date and execution waits for a later close.",
      "Market prices are historical data retrieved now and may include later corrections/share adjustments; S&P is a price index without dividends.",
      "The model and indicators were designed with knowledge of past crises. Historical outcomes here are not an independent out-of-sample validation.",
      "Runtime bytes and synthetic overrides are hashed; run against a stable source tree. Drift checks are not an atomic filesystem transaction.",
      "28 quarterly observations are small and some forward windows overlap; no confidence intervals, significance claim, or future forecast is inferred.",
      "No live execution strategy, leverage, turnover, fees, total returns or predictive probability calibration is tested.",
      "Unavailable inputs are excluded under existing production dependency rules, never backfilled with today's judgments or data revisions.",
    ],
    summary: summarizeHistory(rows), sourceFailures, sourceReceipts: receipts, rows,
    references: ["https://alfred.stlouisfed.org/help", "https://alfred.stlouisfed.org/help/downloaddata", "https://fred.stlouisfed.org/docs/api/fred/series_observations.html", "https://fred.stlouisfed.org/series/SP500"],
  };
  await mkdir(path.dirname(out), { recursive: true });
  await writeFile(out, JSON.stringify(report, null, 2) + "\n");
  console.log(JSON.stringify({ report: out, rows: rows.length, scored: rows.filter((row) => Number.isFinite(row.score)).length, coverage: [...new Set(rows.map((row) => row.coverage))], sources: receipts.length, networkRequests: requestCount, failures: sourceFailures.length, summary: report.summary }));
  if (sourceFailures.length) process.exitCode = 2;
} finally {
  if (activeChild?.exitCode === null) { const ended = once(activeChild, "exit"); activeChild.kill("SIGTERM"); await ended; }
  await rm(runtime, { recursive: true, force: true });
}
