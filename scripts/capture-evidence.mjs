import { mkdir, readFile, readdir, writeFile, unlink, link } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { randomUUID } from "node:crypto";
import { createEvidence, evaluateEvidence, isEvidence } from "../validation-evidence.mjs";
import { parseFredCsv } from "../market-data.mjs";

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const args = process.argv.slice(2);
function option(name, fallback) {
  const index = args.indexOf(name);
  if (index < 0) return fallback;
  if (!args[index + 1] || args[index + 1].startsWith("--")) throw new Error(`Missing ${name} value`);
  return args[index + 1];
}
const source = option("--url", "https://kk-us-equity-radar.onrender.com/api/dashboard");
const outputDir = path.resolve(option("--output-dir", path.join(root, "evidence/forward")));
const summaryFile = path.resolve(option("--summary", path.join(root, "public/forward-validation.json")));
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

await mkdir(outputDir, { recursive: true });
let record;
let lastError;
const captureDeadline = Date.now() + 180_000;
for (let attempt = 0; attempt < attempts; attempt += 1) {
  if (Date.now() >= captureDeadline) break;
  try {
    const payload = JSON.parse(await requestText(source, captureDeadline));
    record = createEvidence(payload, { source });
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

const records = [];
for (const name of (await readdir(outputDir)).filter(name => /^\d{4}-\d{2}-\d{2}_model-\d+\.\d+\.\d+\.json$/.test(name))) {
  records.push(JSON.parse(await readFile(path.join(outputDir, name), "utf8")));
}
let prices = [];
let benchmarkError = null;
// Validate the stored cohort before treating any later problem as a benchmark outage.
let evaluation = evaluateEvidence(records, [], { scoringVersion: record.scoringVersion });
let retainedResults = false;
try {
  prices = parseFredCsv(await requestText("https://fred.stlouisfed.org/graph/fredgraph.csv?id=SP500"));
  if (!prices.length) throw new Error("Benchmark has no valid observations");
  evaluation = evaluateEvidence(records, prices, { scoringVersion: record.scoringVersion });
} catch (error) {
  benchmarkError = error.message;
  try {
    const previous = JSON.parse(await readFile(summaryFile, "utf8"));
    if (previous.version === 1 && previous.scoringVersions?.length === 1 && previous.scoringVersions[0] === record.scoringVersion
      && Array.isArray(previous.outcomes) && previous.outcomes.every(row => [21, 63].includes(row.tradingDays))) {
      evaluation = { ...evaluation, evaluatedAt: previous.evaluatedAt, status: previous.status, outcomes: previous.outcomes };
      retainedResults = true;
    }
  } catch { /* A first capture may have no previous successful result. */ }
}
const summary = {
  ...evaluation,
  retainedResults,
  generatedAt: new Date().toISOString(),
  source,
  benchmark: { series: "SP500", source: "https://fred.stlouisfed.org/series/SP500", error: benchmarkError },
};
await mkdir(path.dirname(summaryFile), { recursive: true });
const summaryTemp = `${summaryFile}.${randomUUID()}.tmp`;
await writeFile(summaryTemp, JSON.stringify(summary, null, 2) + "\n", { flag: "wx" });
const { rename } = await import("node:fs/promises");
await rename(summaryTemp, summaryFile);
console.log(JSON.stringify({ saved, file, summary: summaryFile, observedSamples: summary.observedSamples, outcomes: summary.outcomes.map(({ tradingDays, samples, immatureSamples }) => ({ tradingDays, samples, immatureSamples })), benchmarkError }));
