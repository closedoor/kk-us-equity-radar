import test from "node:test";
import assert from "node:assert/strict";
import {
  parseFredCsv,
  parseNasdaqRows,
  requireFreshSeries,
  monthlyPercentChange,
  monthlyAnnualizedChange,
  monthlyDifference,
  nearestPrior,
  fredMaxAgeDays,
  relativePerformance,
} from "./market-data.mjs";

test("parses only valid FRED observations", () => {
  const rows = parseFredCsv(`observation_date,TEST
2026-09-04,100.5
2026-02-31,101
not-a-date,102
2026-09-05,.
2026-09-06,NA`);

  assert.deepEqual(rows, [{ date: "2026-09-04", value: 100.5 }]);
});

test("normalizes and sorts usable Nasdaq historical rows", () => {
  const rows = parseNasdaqRows([
    { date: "9/4/2026", close: "$102.50" },
    { date: "9/2/2026", close: "$100.00" },
    { date: "2/31/2026", close: "$99.00" },
    { date: "9/3/2026", close: "N/A" },
  ]);

  assert.deepEqual(rows, [
    { date: "2026-09-02", value: 100 },
    { date: "2026-09-04", value: 102.5 },
  ]);
});

test("rejects empty, stale, and implausibly future series", () => {
  const now = new Date("2026-09-20T12:00:00Z");

  assert.throws(
    () => requireFreshSeries([], { name: "TEST", maxAgeDays: 10, now }),
    /没有可用数据/,
  );
  assert.throws(
    () => requireFreshSeries([{ date: "2026-09-04", value: 1 }], { name: "TEST", maxAgeDays: 10, now }),
    /16 天前/,
  );
  assert.throws(
    () => requireFreshSeries([{ date: "2026-09-23", value: 1 }], { name: "TEST", maxAgeDays: 10, now }),
    /未来日期/,
  );
});

test("accepts a series within its freshness window", () => {
  const rows = [{ date: "2026-09-15", value: 1 }];
  assert.equal(
    requireFreshSeries(rows, { name: "TEST", maxAgeDays: 10, now: new Date("2026-09-20T12:00:00Z") }),
    rows,
  );
});

test("rejects blank, zero, and negative Nasdaq closing prices", () => {
  const rows = ["", " ", "$", "0", "-$1", null, undefined].map((close) => ({ date: "9/4/2026", close }));
  assert.deepEqual(parseNasdaqRows(rows), []);
});

const monthly = [
  { date: "2024-12-01", value: 100 },
  { date: "2025-01-01", value: 101 },
  { date: "2025-10-01", value: 110 },
  { date: "2025-12-01", value: 112 },
  { date: "2026-01-01", value: 113 },
];

test("monthly comparisons use calendar months across missing observations and year-end", () => {
  assert.ok(Math.abs(monthlyPercentChange(monthly, 1) - (113 / 112 - 1) * 100) < 1e-9);
  assert.ok(Math.abs(monthlyPercentChange(monthly, 12) - (113 / 101 - 1) * 100) < 1e-9);
  assert.ok(Math.abs(monthlyPercentChange(monthly, 12, 1) - 12) < 1e-9);
  assert.ok(Math.abs(monthlyAnnualizedChange(monthly, 3) - ((113 / 110) ** 4 - 1) * 100) < 1e-9);
  assert.equal(monthlyDifference(monthly, 3), 3);
});

test("missing comparison months return null instead of substituting another month", () => {
  assert.equal(monthlyPercentChange(monthly.slice(0, -1), 1), null);
  assert.equal(monthlyAnnualizedChange(monthly, 2), null);
  assert.equal(monthlyDifference(monthly, 6), null);
  assert.equal(monthlyPercentChange(monthly.filter((p) => p.date !== "2025-12-01"), 12, 1), null);
  assert.equal(monthlyPercentChange([], 12), null);
});

test("month-end observations compare the right month without date overflow", () => {
  assert.equal(monthlyDifference([{ date: "2024-02-29", value: 1 }, { date: "2024-03-31", value: 2 }], 1), 1);
});

test("lookbacks require an observation at or before the actual target date", () => {
  const rows = [{ date: "2026-07-01", value: 4 }, { date: "2026-07-03", value: 5 }, { date: "2026-09-30", value: 6 }];
  assert.equal(nearestPrior(rows, 90), rows[0]);
  assert.equal(nearestPrior(rows.slice(1), 90), null);
  assert.equal(nearestPrior([], 90), null);
});

test("PCE remains usable through its normal month-end publication lag, but cannot stay fresh indefinitely", () => {
  const series = [{ date: "2026-07-01", value: 125 }];
  for (const name of ["PCEPI", "PCEPILFE"]) {
    assert.equal(requireFreshSeries(series, { name, maxAgeDays: fredMaxAgeDays[name], now: new Date("2026-09-29T12:00:00Z") }), series);
    assert.throws(() => requireFreshSeries(series, { name, maxAgeDays: fredMaxAgeDays[name], now: new Date("2026-10-15T12:00:00Z") }), /最新数据停留/);
  }
  assert.throws(() => requireFreshSeries(series, { name: "CPIAUCSL", maxAgeDays: fredMaxAgeDays.CPIAUCSL, now: new Date("2026-09-29T12:00:00Z") }), /最新数据停留/);
});

test("identical daily records count once, not as extra history", () => {
  assert.deepEqual(parseFredCsv("date,value\n2026-09-28,10\n2026-09-28,10"), [{ date: "2026-09-28", value: 10 }]);
  assert.deepEqual(parseNasdaqRows(Array.from({ length: 200 }, () => ({ date: "09/28/2026", close: "$10" }))), [{ date: "2026-09-28", value: 10 }]);
});

test("conflicting prices on the same date cannot silently enter a score", () => {
  assert.throws(() => parseFredCsv("date,value\n2026-09-28,10\n2026-09-28,11"), /冲突/);
  assert.throws(() => parseNasdaqRows([{ date: "09/28/2026", close: "$10" }, { date: "09/28/2026", close: "$11" }]), /冲突/);
});

test("relative performance uses matching endpoints and tolerates missing interior observations", () => {
  const reference = [100, 110, 120, 130, 140].map((value, index) => ({ date: `2026-09-0${index + 1}`, value }));
  const comparison = [reference[0], reference[1], reference[3]].map((point) => ({ ...point, value: point.value * 2 }));
  assert.deepEqual(relativePerformance(reference, comparison, 2), { startDate: "2026-09-02", date: "2026-09-04", value: 0 });
  assert.equal(relativePerformance(reference, comparison.filter((point) => point.date !== "2026-09-02"), 2), null);
  assert.equal(relativePerformance(reference, [], 2), null);
  assert.equal(relativePerformance(reference, comparison, 60), null);
  assert.equal(relativePerformance(reference, comparison, 0), null);
  assert.equal(relativePerformance(reference.filter((point) => point.date !== "2026-09-04"), comparison, 1), null);
});
