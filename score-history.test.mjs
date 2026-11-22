import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, cp, rm, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { readScoreHistory } from "./score-history.mjs";

const name = date => date + "_model-4.7.0.json";
const original = date => new URL("./evidence/forward/" + name(date),import.meta.url);
async function fixture(t, dates) {
  const dir = await mkdtemp(path.join(tmpdir(), "radar-score-history-"));
  t.after(() => rm(dir, { force: true, recursive: true }));
  for (const date of dates) await cp(original(date),path.join(dir,name(date)));
  return dir;
}
test("real archived scores distinguish weighted base changes from total changes and a coverage pause", async t => {
  const dir = await fixture(t, ["2026-11-05", "2026-11-06", "2026-11-09", "2026-11-10"]);
  const report = await readScoreHistory(dir, Date.parse("2026-11-22T12:00:00Z"));
  const [pause, nine, six, first] = report.observations;
  assert.equal(first.change, null);
  assert.equal(six.change.totalDelta, -1.1);
  // 44.3 -> 44.4 even though the normalized base dropped from 36.3 to 35.9.
  assert.equal(nine.change.previousDate, "2026-11-06");
  assert.equal(nine.change.totalDelta, 0.1);
  assert.equal(nine.change.baseDelta, -0.4);
  assert.equal(nine.change.adjustmentDelta, 0.5);
  assert.equal(pause.score, null);
  assert.equal(pause.coverage, 57);
  assert.equal(pause.change.totalDelta, null);
  assert.equal(pause.change.adjustmentDelta, null);
  assert.equal(pause.change.baseDelta, -1.9);
  assert.deepEqual(pause.change.lost.sort(), ["fed","inflation","payrolls","unemployment"]);
  assert.ok(pause.change.drivers.length > 0);
  assert.match(pause.sourceUrl, /\/2026-11-10_model-4\.7\.0\.json$/);
});
test("missing files, wrong day, damages and future observations do not produce a plausible chart", async t => {
  const dir = await fixture(t, []);
  assert.deepEqual((await readScoreHistory(dir)).observations, []);
  await assert.rejects(readScoreHistory(path.join(dir,"missing")));
  const real = await readFile(original("2026-11-09"),"utf8");
  const wrong = path.join(dir,name("2026-11-10"));
  await writeFile(wrong,real);
  await assert.rejects(readScoreHistory(dir), /Invalid dated/);
  await rm(wrong);
  const right = path.join(dir,name("2026-11-09"));
  await writeFile(right,real);
  await assert.rejects(readScoreHistory(dir,Date.parse("2026-11-09T10:00:00Z")), /Invalid dated/);
  await writeFile(right,real.replace('"score": 44.4','"score": 44.9'));
  await assert.rejects(readScoreHistory(dir), /Invalid dated/);
});

test("the pre-open Nov 5 and after-close Nov 9 observations retain their actual time and benchmark date", async t => {
  const {observationTiming,isScoreHistory} = await import('./public/score-history-client.js');
  const dir = await fixture(t, ["2026-11-05","2026-11-06","2026-11-09"]);
  const report=await readScoreHistory(dir,Date.parse('2026-11-22T10:00Z'));
  assert.equal(isScoreHistory(report),true);
  const [nine,,five]=report.observations;
  assert.equal(five.capturedAt, "2026-11-05T13:19:25.286Z");
  assert.equal(five.referenceDate,"2026-11-03");
  assert.match(observationTiming(five),/纽约 08:19 采集（盘前）。标普基准收盘日：2026-11-03。.*未覆盖当日收盘/);
  assert.match(observationTiming(nine),/纽约 23:15 采集（收盘后）。标普基准收盘日：2026-11-05/);
  assert.match(observationTiming({...nine,referenceDate:null}),/基准收盘日未知/);
  for(const mutate of [
    r=>{r.referenceDate="2026-11-10";},r=>{r.capturedAt="2026-11-09T00:05:00.000Z";},
    r=>{r.change.adjustmentDelta=70;},r=>{r.change.lost=['credit'];},r=>{r.change.lost=['credit'];r.change.gained=['credit'];},
  ]) {
    const wrong=structuredClone(report); mutate(wrong.observations[0]);
    assert.equal(isScoreHistory(wrong),false);
  }
});

test("comparison only warns about skipped verified cash sessions, never weekends or Thanksgiving alone",async()=>{
  const {hasInterveningSession,observationTiming}=await import('./public/score-history-client.js');
  assert.equal(hasInterveningSession('2026-11-06','2026-11-09'),false);
  assert.equal(hasInterveningSession('2026-11-05','2026-11-09'),true);
  assert.equal(hasInterveningSession('2026-11-25','2026-11-27'),false);
  assert.equal(hasInterveningSession('2028-12-27','2029-01-08'),false);
  const half={date:'2026-11-27',capturedAt:'2026-11-27T18:00:00.000Z',referenceDate:null};
  assert.match(observationTiming(half),/13:00 采集（收盘后）/);
  assert.match(observationTiming({...half,capturedAt:'2026-11-27T17:59:00.000Z'}),/12:59 采集（盘中）/);
  assert.equal(observationTiming({date:'2026-11-05'}),null);
});
