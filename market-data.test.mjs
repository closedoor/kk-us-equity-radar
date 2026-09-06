import test from "node:test";
import assert from "node:assert/strict";
import {
  parseFredCsv,
  parseNasdaqRows,
  requireFreshSeries,
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
