import test from "node:test";
import assert from "node:assert/strict";
import { quarterDates, parseVintageCsv, historyWindow, forwardOutcome, summarizeHistory } from "./history-validation.mjs";

test("the historical sample covers every predetermined quarter, without event selection", () => {
  const dates = quarterDates();
  assert.equal(dates.length, 28);
  assert.equal(dates[0], "2019-03-31");
  assert.equal(dates.at(-1), "2025-12-31");
  assert.equal(new Set(dates).size, 28);
  for (let year = 2019; year <= 2025; year += 1) assert.equal(dates.filter((date) => date.startsWith(String(year))).length, 4);
  assert.throws(() => quarterDates(2025, 2020));
});

test("archived columns preserve actual different vintages and missing future releases", () => {
  const columns = parseVintageCsv("observation_date,PAYEMS_20200331,PAYEMS_20200430\n2020-02-01,152544,152487\n2020-03-01,,151786\n", "PAYEMS", ["2020-03-31", "2020-04-30"]);
  assert.deepEqual(columns["2020-03-31"], [{ date: "2020-02-01", value: 152544 }]);
  assert.deepEqual(columns["2020-04-30"], [{ date: "2020-02-01", value: 152487 }, { date: "2020-03-01", value: 151786 }]);
});

test("a current-vintage substitution, missing column or reordered date cannot pass the archive guard", () => {
  for (const header of ["observation_date,PAYEMS_20261105", "observation_date,PAYEMS_20200331", "observation_date,PAYEMS_20200430,PAYEMS_20200331"]) {
    assert.throws(() => parseVintageCsv(header + "\n", "PAYEMS", ["2020-03-31", "2020-04-30"]), /header mismatch/);
  }
});

test("archive parsing rejects future observations, conflicting duplicates and malformed numeric values", () => {
  const header = "observation_date,TEST_20200331\n";
  for (const body of ["2020-04-01,10", "2020-02-31,10", "2020-03-01,0x10", "2020-03-01,NaN", "2020-03-01,1\n2020-03-01,2", "2020-03-01,1,2"]) {
    assert.throws(() => parseVintageCsv(header + body, "TEST", ["2020-03-31"]));
  }
  assert.deepEqual(parseVintageCsv(header + "2020-03-01,0\n2020-03-01,0\n2020-02-01,.\n", "TEST", ["2020-03-31"])["2020-03-31"], [{ date: "2020-03-01", value: 0 }]);
});

test("each series is cut independently to its as-of date and the production lookback window", () => {
  const rows = ["2016-01-01", "2017-03-31", "2019-03-31", "2019-04-01"].map((date) => ({ date, value: 1 }));
  assert.deepEqual(historyWindow(rows, "2019-03-31", 2), rows.slice(1, 3));
  assert.equal(rows.length, 4);
});

const prices = [
  { date: "2020-01-02", value: 100 },
  { date: "2020-01-03", value: 120 },
  { date: "2020-01-06", value: 90 },
  { date: "2020-01-07", value: 110 },
  { date: "2020-01-08", value: 121 },
];

test("outcomes enter strictly after the signal date and distinguish drawdown from entry loss", () => {
  const outcome = forwardOutcome(prices, "2020-01-01", 3);
  assert.equal(outcome.entryDate, "2020-01-02");
  assert.equal(outcome.exitDate, "2020-01-07");
  assert.equal(outcome.returnPct, 10);
  assert.equal(outcome.maxDrawdownPct, -25);
  assert.equal(outcome.worstFromEntryPct, -10);
  assert.equal(forwardOutcome(prices, "2020-01-02", 1).entryDate, "2020-01-03");
  assert.equal(forwardOutcome(prices, "2020-01-02", 1).returnPct, -25);
});

test("an incomplete forward horizon stays missing instead of shortening the outcome window", () => {
  assert.equal(forwardOutcome(prices, "2020-01-07", 1), null);
  assert.equal(forwardOutcome(prices, "2020-01-08", 1), null);
  assert.equal(forwardOutcome(prices.slice(0, 4), "2020-01-01", 4), null);
  assert.throws(() => forwardOutcome(prices, "invalid", 1));
});

test("invalid or unsorted outcome prices cannot silently create returns", () => {
  for (const broken of [[...prices].reverse(), [prices[0], prices[0]], [{ ...prices[0], value: 0 }], [{ ...prices[0], value: Infinity }]]) {
    assert.throws(() => forwardOutcome(broken, "2020-01-01", 1));
  }
});

test("band summaries compare the same scored sample with its baseline and retain empty bands", () => {
  const outcome = (returnPct, maxDrawdownPct, entryDate, exitDate) => ({ returnPct, maxDrawdownPct, entryDate, exitDate });
  const rows = [
    { score: 20, outcomes: { 21: outcome(10, -3, "2020-01-02", "2020-02-03") } },
    { score: 40, outcomes: { 21: outcome(-5, -12, "2020-04-01", "2020-05-01") } },
    { score: null, outcomes: { 21: outcome(100, -1, "2020-07-01", "2020-08-01") } },
    { score: 80, outcomes: { 21: null } },
  ];
  const summary = summarizeHistory(rows, [21])[0];
  assert.equal(summary.matureCount, 3);
  assert.equal(summary.scoredMatureCount, 2);
  assert.equal(summary.scheduledBaseline.meanReturnPct, 35);
  assert.equal(summary.scoredSampleBaseline.meanReturnPct, 2.5);
  assert.equal(summary.scoredSampleBaseline.lossRatePct, 50);
  assert.equal(summary.bands[0].n, 1);
  assert.equal(summary.bands[1].n, 1);
  assert.equal(summary.bands[2].n, 0);
  assert.equal(summary.bands[2].meanReturnPct, null);
  assert.equal(summary.bands[1].drawdownAtLeast10PctRate, 100);
});

test("overlapping forward windows are disclosed and no empty sample invents a zero loss rate", () => {
  const rows = [
    { score: 30, outcomes: { 63: { returnPct: 1, maxDrawdownPct: -1, entryDate: "2020-01-02", exitDate: "2020-04-03" } } },
    { score: 40, outcomes: { 63: { returnPct: 2, maxDrawdownPct: -2, entryDate: "2020-04-01", exitDate: "2020-07-03" } } },
  ];
  assert.equal(summarizeHistory(rows, [63])[0].overlappingAdjacentWindows, 1);
  const empty = summarizeHistory([], [21])[0];
  assert.equal(empty.matureCount, 0);
  assert.equal(empty.scoredSampleBaseline.lossRatePct, null);
  assert.ok(empty.bands.every((band) => band.n === 0 && band.meanReturnPct === null));
});
