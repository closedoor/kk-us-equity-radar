import { readFile, writeFile, rename, unlink } from "node:fs/promises";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { aiEarnings } from "../earnings-data.mjs";
import { createEarningsMonitor } from "../earnings-monitor.mjs";
import { applyEarningsChecks, isEarningsSchedule, validEarningsTimestamp } from "../public/earnings-state.js";

const usage = `Usage: node scripts/check-earnings.mjs [--ticker NVDA,TSM] [--input saved.json] [--output report.json] [--now ISO_TIMESTAMP] [--strict]

Without --input, checks official SEC / company feeds. Default output is JSON on stdout.
--input replays a saved schedule or dashboard-cache without network requests.
--output explicitly saves the report with an atomic replacement.
--strict exits 2 if a review is required or a source remains unknown.
This command never changes earnings-data.mjs, financial text, guidanceTone, or scoring weights.
`;

async function main() {
  const args = process.argv.slice(2); const options = {};
  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index];
    if (argument === "--help" || argument === "-h") { process.stdout.write(usage); return; }
    if (argument === "--strict") { options.strict = true; continue; }
    if (!["--ticker", "--input", "--output", "--now"].includes(argument) || !args[index + 1] || args[index + 1].startsWith("--")) throw new Error(`Unknown or incomplete option: ${argument}`);
    options[argument.slice(2)] = args[++index];
  }
  if (options.now && !validEarningsTimestamp(options.now)) throw new Error("--now must be an ISO timestamp with a timezone");
  const now = () => options.now ? new Date(options.now) : new Date();
  const tickers = options.ticker?.split(",");
  if (tickers?.some((ticker) => !aiEarnings.some((row) => row.ticker === ticker))) throw new Error("--ticker contains an unsupported company");
  const rows = tickers ? aiEarnings.filter((row) => tickers.includes(row.ticker)) : aiEarnings;
  let schedule;
  if (options.input) {
    const saved = JSON.parse(await readFile(path.resolve(options.input), "utf8"));
    schedule = saved.earningsSchedule || saved.schedule || saved;
    if (!isEarningsSchedule(schedule)) throw new Error("Saved earnings schedule is invalid");
  } else {
    const fetchText = async (url, headers = {}, deadline = Infinity) => {
      const remaining = deadline - Date.now();
      if (remaining <= 0) throw new Error("Earnings monitor fetch budget exhausted");
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), Math.min(20_000, remaining));
      try {
        const response = await fetch(url, { headers, signal: controller.signal });
        if (!response.ok) throw new Error(`HTTP ${response.status}`);
        return await response.text();
      } finally { clearTimeout(timer); controller.abort(); }
    };
    const service = createEarningsMonitor({ fetchText, aiEarnings: rows, now, secUserAgent: process.env.EARNINGS_SEC_USER_AGENT });
    schedule = await service.refresh();
  }
  const evaluatedAt = now().toISOString();
  const result = applyEarningsChecks(rows, schedule, Date.parse(evaluatedAt));
  const report = { version: 1, mode: options.input ? "offline-replay" : "official-source-check", evaluatedAt,
    scope: "Official report metadata only; financial commentary and guidance assessments require human review.",
    schedule, checks: result.checks, errors: result.errors,
    reviewQueue: result.aiEarnings.filter((row) => row.reviewRequired).map((row) => ({ ticker: row.ticker,
      reviewedPeriod: row.period, reviewedReleased: row.released, reviewedSource: row.source, latestReport: row.latestReport })),
  };
  const json = JSON.stringify(report, null, 2) + "\n";
  if (options.output) {
    const target = path.resolve(options.output); const temporary = `${target}.${randomUUID()}.tmp`;
    try { await writeFile(temporary, json, { flag: "wx" }); await rename(temporary, target); }
    finally { await unlink(temporary).catch((error) => { if (error.code !== "ENOENT") throw error; }); }
  }
  process.stdout.write(json);
  if (options.strict && result.checks.some((check) => check.status !== "no-newer-report")) process.exitCode = 2;
}

main().catch((error) => { process.stderr.write(`Earnings check failed: ${error.message}\n`); process.exitCode = 1; });
