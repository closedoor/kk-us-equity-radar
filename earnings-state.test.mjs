import test from "node:test";
import assert from "node:assert/strict";
import { applyEarningsChecks, isEarningsSchedule } from "./public/earnings-state.js";

const now = Date.parse("2026-11-05T12:00:00.000Z");
const row = { ticker: "GOOG", period: "2026 Q2", released: "2026-07-22", guidanceTone: "mixed", guidance: "Reviewed guidance", revenue: "$119.796B" };
const proof = {
  period: "2026 Q3", periodEnd: "2026-09-30", publishedAt: "2026-10-29T00:29:06.000Z",
  source: "https://www.sec.gov/Archives/edgar/data/1652044/000165204426000084/goog-20260930.htm",
  form: "10-Q", title: "Alphabet Inc. 10-Q for period ended 2026-09-30",
};
const saved = (reports = [proof], error = null) => ({ version: 1, sources: { GOOG: {
  checkedAt: "2026-11-05T11:00:00.000Z", attemptedAt: "2026-11-05T11:00:00.000Z", error, reports: structuredClone(reports),
} } });

test("new official report creates a review requirement without replacing reviewed facts or tones", () => {
  const schedule = saved();
  assert.equal(isEarningsSchedule(schedule), true);
  const result = applyEarningsChecks([row], schedule, now);
  assert.equal(result.aiEarnings[0].reviewRequired, true);
  assert.equal(result.aiEarnings[0].earningsReviewStatus, "review-required");
  assert.deepEqual(result.aiEarnings[0].latestReport, proof);
  for (const key of ["period", "released", "revenue", "guidance", "guidanceTone"]) assert.equal(result.aiEarnings[0][key], row[key]);
  assert.equal(row.reviewRequired, undefined);
  assert.match(result.errors.join(" "), /待复核/);
});

test("manual review of the same report naturally clears the derived requirement", () => {
  const first = applyEarningsChecks([row], saved(), now).aiEarnings[0];
  const reviewed = { ...first, period: "2026 Q3", released: "2026-10-28" };
  const result = applyEarningsChecks([reviewed], saved(), now).aiEarnings[0];
  assert.equal(result.reviewRequired, false);
  assert.equal(result.earningsReviewStatus, "no-newer-report");
});

test("same-quarter SEC filing after the press release is not a new quarter", () => {
  const reviewed = { ...row, period: "2026 Q3", released: "2026-10-28" };
  assert.equal(applyEarningsChecks([reviewed], saved(), now).aiEarnings[0].reviewRequired, false);
  const lateManualDate = { ...row, released: "2026-11-01" };
  assert.equal(applyEarningsChecks([lateManualDate], saved(), now).aiEarnings[0].reviewRequired, true);
  const labelOnly = { ...row, period: "2026 Q3" };
  assert.equal(applyEarningsChecks([labelOnly], saved(), now).aiEarnings[0].reviewRequired, true, "Changing only the quarter label cannot hide a report ending after the reviewed release");
});

test("future publications and future report periods never retire reviewed guidance", () => {
  for (const next of [
    { ...proof, publishedAt: "2026-11-06T12:00:00.000Z" },
    { ...proof, period: "2026 Q4", periodEnd: "2026-12-31" },
    { ...proof, period: "2027 Q1", periodEnd: null },
  ]) {
    const result = applyEarningsChecks([row], saved([next]), now);
    assert.equal(result.aiEarnings[0].reviewRequired, false);
    assert.equal(result.aiEarnings[0].earningsReviewStatus, "unknown");
  }
});

test("unavailable sources disclose uncertainty while retaining earlier conclusive evidence", () => {
  const failed = saved([proof], "HTTP 403");
  const result = applyEarningsChecks([row], failed, now);
  assert.equal(result.aiEarnings[0].reviewRequired, true);
  assert.match(result.errors.join(" "), /403/);
  const empty = applyEarningsChecks([row], saved([], "HTTP 403"), now);
  assert.equal(empty.aiEarnings[0].earningsReviewStatus, "unknown");
  assert.equal(empty.aiEarnings[0].reviewRequired, false);
  assert.equal(applyEarningsChecks([row], null, now).aiEarnings[0].reviewRequired, false);
});

test("quarter comparison respects fiscal years and SK publication timezone", () => {
  const sk = { ticker: "000660.KS", period: "2026 Q3", released: "2026-10-28", guidanceTone: "mixed" };
  const skProof = { ...proof, period: "2026 Q3", periodEnd: "2026-09-30", publishedAt: "2026-10-27T23:29:15.000Z",
    source: "https://news.skhynix.com/en/q3-2026-business-results/", form: "earnings-release", title: "SK hynix Announces 3Q26 Financial Results" };
  const schedule = { version: 1, sources: { "000660.KS": { ...saved().sources.GOOG, reports: [skProof] } } };
  assert.equal(applyEarningsChecks([sk], schedule, now).aiEarnings[0].reviewRequired, false);
  const nvda = { ticker: "NVDA", period: "FY2027 Q2", released: "2026-08-26" };
  const nvdaProof = { ...proof, period: "FY2027 Q3", periodEnd: "2026-10-25", publishedAt: "2026-11-17T21:01:00.000Z",
    source: "https://nvidianews.nvidia.com/news/nvidia-announces-financial-results-for-third-quarter-fiscal-2027", form: "earnings-release" };
  const nvdaSchedule = { version: 1, sources: { NVDA: { ...saved().sources.GOOG, reports: [nvdaProof] } } };
  nvdaSchedule.sources.NVDA.checkedAt = "2026-11-18T11:00:00.000Z";
  nvdaSchedule.sources.NVDA.attemptedAt = "2026-11-18T11:00:00.000Z";
  assert.equal(applyEarningsChecks([nvda], nvdaSchedule, Date.parse("2026-11-18T12:00:00Z")).aiEarnings[0].reviewRequired, true);
});

test("proof boundaries reject malformed dates, unofficial and cross-company sources", () => {
  for (const edit of [
    (x) => { x.version = 2; },
    (x) => { x.sources.GOOG.reports[0].periodEnd = "2026-02-30"; },
    (x) => { x.sources.GOOG.reports[0].publishedAt = "broken"; },
    (x) => { x.sources.GOOG.reports[0].source = "https://www.sec.gov.evil.test/report"; },
    (x) => { x.sources.GOOG.reports[0].source = "https://www.sec.gov/Archives/edgar/data/789019/a/msft.htm"; },
    (x) => { x.sources.GOOG.reports[0].form = "8-K"; },
    (x) => { x.sources.GOOG.reports[0].period = "Q5 2026"; },
    (x) => { x.sources.GOOG.reports[0].title = {}; },
    (x) => { x.sources.GOOG.checkedAt = null; },
    (x) => { x.sources.GOOG.reports[0].publishedAt = "2026-11-05T11:30:00.000Z"; },
    (x) => { x.sources.GOOG.reports[0].periodEnd = "2026-06-30"; },
  ]) {
    const schedule = saved(); edit(schedule);
    assert.equal(isEarningsSchedule(schedule), false, edit.toString());
    assert.equal(applyEarningsChecks([row], schedule, now).aiEarnings[0].reviewRequired, false);
  }
});

test("a stale check or a source that cannot see the reviewed quarter discloses unknown coverage", () => {
  const old = saved([{ ...proof, period: "2026 Q1", periodEnd: "2026-03-31" }]);
  assert.equal(applyEarningsChecks([row], old, now).aiEarnings[0].earningsReviewStatus, "unknown");
  const same = { ...row, period: "2026 Q3", released: "2026-10-28" };
  assert.equal(applyEarningsChecks([same], saved(), now + 2 * 86_400_000).aiEarnings[0].earningsReviewStatus, "unknown");
});
