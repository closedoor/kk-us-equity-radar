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
