import { mkdir, readFile, readdir, writeFile, unlink, link } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { randomUUID } from "node:crypto";
import { captureWindow, createEvidence, evaluateEvidence, isEvidence } from "../validation-evidence.mjs";
import { parseFredCsv } from "../market-data.mjs";
import { hydrateSourceLedger, isSourceLedger } from "../source-revisions.mjs";
import { createPublicationService } from "../publication.mjs";
import { createEarningsMonitor } from "../earnings-monitor.mjs";

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const args = process.argv.slice(2);
function option(name, fallback) {
  const index = args.indexOf(name);
  if (index < 0) return fallback;
  if (!args[index + 1] || args[index + 1].startsWith("--")) throw new Error(`Missing ${name} value`);
  return args[index + 1];
}
const source = option("--url", "https://kk-us-equity-radar.onrender.com/api/dashboard?evidence=1");
const outputDir = path.resolve(option("--output-dir", path.join(root, "evidence/forward")));
const summaryFile = path.resolve(option("--summary", path.join(root, "public/forward-validation.json")));
const ledgerFile = path.resolve(option("--ledger-output", path.join(root, "evidence/source-ledger.json")));
const attempts = Number(option("--attempts", "24"));
if (!Number.isInteger(attempts) || attempts < 1 || attempts > 40) throw new Error("Attempts must be between 1 and 40");
const pause = (ms) => new Promise(resolve => setTimeout(resolve, ms));

async function requestText(url, deadline = Infinity) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), Math.max(1, Math.min(20_000, deadline - Date.now())));
  try {
    const response = await fetch(url, { signal: controller.signal, headers: { "user-agent": "kk-us-equity-radar research evidence recorder" } });
    if (!response.ok) throw new Error(`Evidence source HTTP ${response.status}`);
    return await response.text();
  } finally { clearTimeout(timer); controller.abort(); }
}

// A delayed weekday cron or manual dispatch need not fall in an eligible NY session.
const scheduled = captureWindow(Date.now());
if (scheduled.state === "unverified-calendar") throw new Error("NYSE calendar is not verified for this capture date");
if (scheduled.state !== "post-close") {
  console.log(JSON.stringify({ saved: false, skipped: scheduled.state, observationDate: scheduled.date }));
  process.exit(0);
}
await mkdir(outputDir, { recursive: true });
let record;
let capturedLedger;
let capturedPublications;
let capturedEarnings;
let lastError;
const captureDeadline = Date.now() + 180_000;
for (let attempt = 0; attempt < attempts; attempt += 1) {
  if (Date.now() >= captureDeadline) break;
  try {
    const payload = JSON.parse(await requestText(source, captureDeadline));
    record = createEvidence(payload, { source });
    if (isSourceLedger(payload.sourceLedger)) capturedLedger = hydrateSourceLedger(payload.sourceLedger);
    capturedPublications = payload.publicationSchedule;
    capturedEarnings = payload.earningsSchedule;
    break;
  } catch (error) { lastError = error; }
  if (attempt + 1 < attempts) await pause(5000);
}
if (!record) throw new Error(`Could not record a completed nonexpired observation: ${lastError?.message}`);
const name = `${record.observationDate}_model-${record.scoringVersion}.json`;
const file = path.join(outputDir, name);
const temporary = path.join(outputDir, `.${randomUUID()}.tmp`);
let saved = true;
try {
  await writeFile(temporary, JSON.stringify(record, null, 2) + "\n", { flag: "wx" });
  try { await link(temporary, file); }
  catch (error) {
    if (error.code !== "EEXIST") throw error;
    const existing = JSON.parse(await readFile(file, "utf8"));
    if (!isEvidence(existing) || existing.observationDate !== record.observationDate || existing.scoringVersion !== record.scoringVersion) throw new Error("Existing daily evidence is corrupt; refusing to overwrite");
    record = existing;
    saved = false;
  }
} finally { await unlink(temporary).catch(error => { if (error.code !== "ENOENT") throw error; }); }

let ledgerSaved = false;
if (capturedLedger) {
  let previous;
  try { previous = JSON.parse(await readFile(ledgerFile, "utf8")); } catch {}
  if (!isSourceLedger(previous)) previous = null;
  const dominates = !previous || Object.entries(previous.sources).every(([id, source]) => capturedLedger.sources[id]
    && Date.parse(capturedLedger.sources[id].checkedAt) >= Date.parse(source.checkedAt));
  if (dominates) {
    const events = new Map([...(previous?.revisions || []), ...capturedLedger.revisions].map(row => [JSON.stringify(row), row]));
    const checkpoint = { ...capturedLedger, revisions: [...events.values()].sort((a, b) => Date.parse(a.firstDetectedAt) - Date.parse(b.firstDetectedAt)).slice(-100) };
    // Preserve a previous checkpoint if a partial/older host cannot establish a consistent chain.
    if (isSourceLedger(checkpoint)) {
      const offline = async () => { throw new Error("Checkpoint merge must not fetch"); };
      const publication = createPublicationService({ fetchText: offline });
      const earnings = createEarningsMonitor({ fetchText: offline });
      publication.hydrate(previous?.publicationSchedule);
      publication.hydrate(capturedPublications);
      earnings.hydrate(previous?.earningsSchedule);
      earnings.hydrate(capturedEarnings);
      checkpoint.publicationSchedule = publication.snapshot();
      checkpoint.earningsSchedule = earnings.snapshot();
      await mkdir(path.dirname(ledgerFile), { recursive: true });
      const checkpointTemp = `${ledgerFile}.${randomUUID()}.tmp`;
      await writeFile(checkpointTemp, JSON.stringify(checkpoint, null, 2) + "\n", { flag: "wx" });
      const { rename } = await import("node:fs/promises");
      await rename(checkpointTemp, ledgerFile);
      ledgerSaved = true;
    }
  }
}

const records = [];
for (const name of (await readdir(outputDir)).filter(name => /^\d{4}-\d{2}-\d{2}_model-\d+\.\d+\.\d+\.json$/.test(name))) {
  records.push(JSON.parse(await readFile(path.join(outputDir, name), "utf8")));
}
let benchmarkError = null;
// Validate the stored cohort first: a corrupt observation is not a benchmark outage.
let evaluation = evaluateEvidence(records, [], { scoringVersion: record.scoringVersion });
let retainedResults = false;
const cohort = new Map(records.filter(row => row.scoringVersion === record.scoringVersion).map(row => [row.observationDate, row]));
const knownReference = [...cohort.values()].map(row => row.marketReference?.date ?? "").sort().at(-1);
let previous = null;
try {
  const prior = JSON.parse(await readFile(summaryFile, "utf8"));
  const at = Date.parse(prior.evaluatedAt);
  const accepted = prior.version === 1 && prior.benchmark?.series === "SP500"
    && (!prior.benchmark.error || prior.retainedResults === true) && Number.isFinite(at) && at <= Date.now()
    && prior.scoringVersions?.length === 1 && prior.scoringVersions[0] === record.scoringVersion
    && Number.isInteger(prior.observedSamples) && prior.observedSamples <= cohort.size
    && Array.isArray(prior.outcomes) && prior.outcomes.length === 2
    && [21, 63].every(days => prior.outcomes.some(h => h.tradingDays === days))
    && prior.outcomes.every(h => Array.isArray(h.outcomes) && h.samples === h.outcomes.length
      && [h.immatureSamples, h.incompleteBenchmarkSamples ?? 0].every(n => Number.isInteger(n) && n >= 0)
      && h.samples + h.immatureSamples + (h.incompleteBenchmarkSamples || 0) <= cohort.size - evaluation.outcomes[0].unavailableScoreSamples
      && new Set(h.outcomes.map(o => o.observationDate)).size === h.samples
      && h.outcomes.every(o => { const r = cohort.get(o.observationDate);
        return r && r.score !== null && r.score === o.score && r.coverage === o.coverage && o.scoringVersion === record.scoringVersion
          && Date.parse(r.capturedAt) <= at && o.observationDate < o.entryDate && o.entryDate < o.exitDate
          && Number.isFinite(o.returnPercent) && Number.isFinite(o.drawdownPercent);
      }));
  if (accepted) previous = prior;
} catch { /* First evaluation or no readable previous summary. */ }
let latestObservationDate = previous?.benchmark.latestObservationDate ?? null;
try {
  const prices = parseFredCsv(await requestText("https://fred.stlouisfed.org/graph/fredgraph.csv?id=SP500"), "SP500");
  if (!prices.length) throw new Error("Benchmark has no valid SP500 observations");
  const last = prices.at(-1).date;
  if (last < (knownReference || "") || last < (latestObservationDate || "")) throw new Error("标普基准价格截断：最新日期早于已核验价格");
  const next = evaluateEvidence(records, prices, { scoringVersion: record.scoringVersion });
  // A non-empty HTTP 200 can contain only a suffix of price history. Never lose or
  // re-date an observed outcome; allow legitimate price revisions on the same dates.
  for (const old of previous?.outcomes || []) {
    const fresh = new Map(next.outcomes.find(h => h.tradingDays === old.tradingDays).outcomes.map(o => [o.observationDate, o]));
    if (!old.outcomes.every(o => fresh.get(o.observationDate)?.entryDate === o.entryDate && fresh.get(o.observationDate)?.exitDate === o.exitDate)) {
      throw new Error("标普基准价格缺失：无法复核已观察到的收益区间");
    }
  }
  evaluation = next;
  latestObservationDate = last;
} catch (error) {
  benchmarkError = error.message;
  retainedResults = Boolean(previous);
  // A scoreless observation is excluded regardless of benchmark health. Preserve
  // old verified counts; new scored observations have unknown maturity during outage.
  const outcomes = evaluation.outcomes.map(h => {
    const old = previous?.outcomes.find(r => r.tradingDays === h.tradingDays);
    const row = { ...(old || h), unavailableScoreSamples: h.unavailableScoreSamples, immatureSamples: old?.immatureSamples ?? 0,
      incompleteBenchmarkSamples: old?.incompleteBenchmarkSamples ?? 0 };
    const unknown = evaluation.observedSamples - row.samples - row.immatureSamples - row.unavailableScoreSamples - row.incompleteBenchmarkSamples;
    if (unknown < 0) throw new Error("Retained results conflict with immutable forward cohort");
    if (unknown > 0) row.unknownSamples = unknown;
    else delete row.unknownSamples;
    return row;
  });
  evaluation = { ...evaluation, evaluatedAt: previous?.evaluatedAt ?? null, status: previous?.status ?? evaluation.status, outcomes };
}
const summary = {
  ...evaluation,
  retainedResults,
  generatedAt: new Date().toISOString(),
  source,
  benchmark: { series: "SP500", source: "https://fred.stlouisfed.org/series/SP500", latestObservationDate, error: benchmarkError },
};
await mkdir(path.dirname(summaryFile), { recursive: true });
const summaryTemp = `${summaryFile}.${randomUUID()}.tmp`;
await writeFile(summaryTemp, JSON.stringify(summary, null, 2) + "\n", { flag: "wx" });
const { rename } = await import("node:fs/promises");
await rename(summaryTemp, summaryFile);
console.log(JSON.stringify({ saved, file, ledgerSaved, summary: summaryFile, observedSamples: summary.observedSamples, outcomes: summary.outcomes.map(({ tradingDays, samples, immatureSamples }) => ({ tradingDays, samples, immatureSamples })), benchmarkError }));
