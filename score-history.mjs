import { readFile, readdir } from "node:fs/promises";
import path from "node:path";
import { isEvidence } from "./validation-evidence.mjs";
import { SCORING_VERSION } from "./public/risk-model.js";

const recentLimit = 20;
const round = (value, scale = 10) => Math.round(value * scale) / scale || 0;
const evidenceDir = new URL("./evidence/forward/", import.meta.url);
const sourceBase = "https://github.com/closedoor/kk-us-equity-radar/blob/main/evidence/forward/";
const points = (row, coverage) => row.available && coverage ? row.risk * row.weight / coverage : 0;
const base = record => record.coverage ? round(record.indicators.reduce((sum, row) => sum + points(row, record.coverage), 0)) : null;

function compare(current, prior) {
  if (!prior) return null;
  const rows = new Map(prior.indicators.map(r => [r.id, r]));
  const lost = [], gained = [], drivers = [];
  for (const row of current.indicators) {
    const old = rows.get(row.id);
    if (row.available && !old.available) gained.push(row.id);
    if (old.available && !row.available) lost.push(row.id);
    if (current.coverage && prior.coverage) {
      const deltaPoints = round(points(row, current.coverage) - points(old, prior.coverage), 100);
      if (deltaPoints) drivers.push({ id: row.id, deltaPoints });
    }
  }
  drivers.sort((a,b) => Math.abs(b.deltaPoints) - Math.abs(a.deltaPoints) || a.id.localeCompare(b.id));
  const currBase = base(current), prevBase = base(prior);
  const totalDelta = current.score !== null && prior.score !== null ? round(current.score - prior.score) : null;
  const baseDelta = currBase !== null && prevBase !== null ? round(currBase - prevBase) : null;
  return { previousDate: prior.observationDate, totalDelta, baseDelta,
    adjustmentDelta: totalDelta === null || baseDelta === null ? null : round(totalDelta - baseDelta),
    gained, lost, drivers: drivers.slice(0,3) };
}

// Read the daily records from this deployment, never the local browser or a reconstructed historical series.
export async function readScoreHistory(dir = evidenceDir, now = Date.now()) {
  const suffix = `_model-${SCORING_VERSION}.json`;
  const names = (await readdir(dir)).filter(n => n.endsWith(suffix)).sort().reverse().slice(0, recentLimit + 1);
  const records = await Promise.all(names.map(async name => {
    const location = dir instanceof URL ? new URL(name, dir) : path.join(dir, name);
    const record = JSON.parse(await readFile(location, "utf8"));
    if (!isEvidence(record) || record.scoringVersion !== SCORING_VERSION || name !== record.observationDate + suffix
      || Date.parse(record.capturedAt) > now) throw new Error("Invalid dated score record");
    return record;
  }));
  return { version: 1, scoringVersion: SCORING_VERSION, observations: records.slice(0,recentLimit).map((r,i) => ({
    date: r.observationDate, capturedAt: new Date(r.capturedAt).toISOString(), referenceDate: r.marketReference?.date ?? null,
    score: r.score, coverage: r.coverage, baseScore: base(r),
    sourceUrl: sourceBase + names[i], change: compare(r, records[i+1])
  })) };
}
