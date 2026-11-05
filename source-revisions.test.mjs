import test from "node:test";
import assert from "node:assert/strict";
import { FRED_SERIES_IDS, hydrateSourceLedger, isSourceLedger, updateSourceLedger } from "./source-revisions.mjs";

const time = "2026-11-05T12:00:00.000Z";
const later = "2026-11-05T12:01:00.000Z";
const asOf = Date.parse(later);
const initial = () => updateSourceLedger(null, { CPIAUCSL: [{ date: "2026-09-01", value: 336.298123456 }] }, time).ledger;

test("the revision ledger uses exactly the production twenty-two FRED series", () => {
  assert.deepEqual(FRED_SERIES_IDS, ["DCOILBRENTEU", "CPIAUCSL", "CPIAUCNS", "CPILFESL", "CPILFENS", "PCEPI", "PCEPILFE", "DFEDTARL", "DFEDTARU", "DGS2", "DGS10", "DFII10", "T10Y3M", "VIXCLS", "SP500", "BAMLH0A0HYM2", "DRTSCILM", "SAHMREALTIME", "ICSA", "NFCI", "UNRATE", "PAYEMS"]);
  assert.equal(Object.isFrozen(FRED_SERIES_IDS), true);
});

test("first capture preserves raw numbers without inventing historical revisions or mutating inputs", () => {
  const candidates = { CPIAUCSL: [{ date: "2026-09-01", value: 336.298123456 }, { date: "2026-08-01", value: 334.131 }], UNRATE: [{ date: "2026-09-01", value: 0 }] };
  const before = structuredClone(candidates);
  const { ledger, revisions } = updateSourceLedger(null, candidates, time);
  assert.equal(isSourceLedger(ledger, asOf), true);
  assert.deepEqual(revisions, []);
  assert.strictEqual(revisions, ledger.revisions);
  assert.deepEqual(ledger.sources.CPIAUCSL.points, [...candidates.CPIAUCSL].reverse());
  assert.equal(ledger.sources.UNRATE.points[0].value, 0);
  assert.deepEqual(candidates, before);
  ledger.sources.CPIAUCSL.points[1].value = 1;
  assert.deepEqual(candidates, before);
});

test("same-date decimal changes use original precision and repeated refreshes do not duplicate detection", () => {
  const previous = initial();
  const before = structuredClone(previous);
  const afterValue = 336.298123457;
  assert.equal(previous.sources.CPIAUCSL.points[0].value.toFixed(3), afterValue.toFixed(3));
  const changed = updateSourceLedger(previous, { CPIAUCSL: [{ date: "2026-09-01", value: afterValue }] }, later);
  assert.deepEqual(changed.revisions, [{ series: "CPIAUCSL", date: "2026-09-01", before: 336.298123456, after: afterValue, firstDetectedAt: later }]);
  assert.deepEqual(previous, before);
  const repeated = updateSourceLedger(changed.ledger, { CPIAUCSL: [{ date: "2026-09-01", value: afterValue }] }, "2026-11-05T12:02:00.000Z");
  assert.deepEqual(repeated.revisions, changed.revisions);
  assert.equal(repeated.ledger.sources.CPIAUCSL.checkedAt, "2026-11-05T12:02:00.000Z");
});

test("new months and trading dates are observations, not revisions, and missing rows remain known", () => {
  const first = updateSourceLedger(initial(), { SP500: [{ date: "2026-11-03", value: 6000 }] }, time).ledger;
  const next = updateSourceLedger(first, { CPIAUCSL: [{ date: "2026-10-01", value: 338 }], SP500: [{ date: "2026-11-04", value: 6100 }] }, later);
  assert.deepEqual(next.revisions, []);
  assert.deepEqual(next.ledger.sources.CPIAUCSL.points.map((row) => row.date), ["2026-09-01", "2026-10-01"]);
  assert.equal(next.ledger.sources.SP500.points.length, 2);
});

test("missing, failed, unknown and malformed source batches cannot erase or partially alter prior observations", () => {
  const previous = initial();
  for (const candidate of [undefined, null, [], new Error("upstream failed"),
    [{ date: "2026-09-01", value: "336.4" }],
    [{ date: "2026-09-01", value: NaN }],
    [{ date: "2026-09-01", value: 337 }, { date: "2026-02-30", value: 338 }],
    [{ date: "2026-09-01", value: 337 }, { date: "2026-09-01", value: 338 }],
    [{ date: "2026-11-06", value: 337 }],
  ]) {
    const result = updateSourceLedger(previous, { CPIAUCSL: candidate, UNKNOWN: [{ date: "2026-09-01", value: 1 }] }, later);
    assert.deepEqual(result.ledger, previous);
  }
  const retained = updateSourceLedger(previous, { UNRATE: [{ date: "2026-09-01", value: 4.2 }] }, later);
  assert.deepEqual(retained.ledger.sources.CPIAUCSL, previous.sources.CPIAUCSL);
});

test("numeric rollback is a second revision, while stale or same-time conflicting responses cannot rewind history", () => {
  const first = updateSourceLedger(null, { UNRATE: [{ date: "2026-09-01", value: 4.2 }] }, time).ledger;
  const second = updateSourceLedger(first, { UNRATE: [{ date: "2026-09-01", value: 4.3 }] }, later).ledger;
  const rollback = updateSourceLedger(second, { UNRATE: [{ date: "2026-09-01", value: 4.2 }] }, "2026-11-05T12:02:00.000Z");
  assert.deepEqual(rollback.revisions.map(({ before, after }) => [before, after]), [[4.2, 4.3], [4.3, 4.2]]);
  for (const checkedAt of [time, later, "2026-11-05T12:02:00.000Z"]) {
    assert.deepEqual(updateSourceLedger(rollback.ledger, { UNRATE: [{ date: "2026-09-01", value: 9 }] }, checkedAt).ledger, rollback.ledger);
  }
});

test("each source retains the newest four hundred dates and revision history retains its newest hundred transitions", () => {
  const points = Array.from({ length: 450 }, (_, index) => ({ date: new Date(Date.parse("2026-11-04") - (449 - index) * 86_400_000).toISOString().slice(0, 10), value: index }));
  const bounded = updateSourceLedger(null, { DGS10: points }, time).ledger;
  assert.equal(bounded.sources.DGS10.points.length, 400);
  assert.deepEqual(bounded.sources.DGS10.points[0], points[50]);
  let ledger = updateSourceLedger(null, { PAYEMS: [{ date: "2026-09-01", value: 100 }] }, time).ledger;
  for (let index = 1; index <= 105; index += 1) {
    ledger = updateSourceLedger(ledger, { PAYEMS: [{ date: "2026-09-01", value: 100 + index }] }, new Date(Date.parse(time) + index * 1000).toISOString()).ledger;
  }
  assert.equal(ledger.revisions.length, 100);
  assert.equal(ledger.revisions[0].before, 105);
  assert.equal(ledger.revisions.at(-1).after, 205);
  assert.equal(isSourceLedger(ledger, Date.parse(time) + 200_000), true);
});

test("valid ledger hydration is independent, and restarting cannot rediscover an existing change", () => {
  const changed = updateSourceLedger(initial(), { CPIAUCSL: [{ date: "2026-09-01", value: 337 }] }, later).ledger;
  const restored = hydrateSourceLedger(JSON.parse(JSON.stringify(changed)), asOf);
  assert.deepEqual(restored, changed);
  const repeated = updateSourceLedger(restored, { CPIAUCSL: [{ date: "2026-09-01", value: 337 }] }, "2026-11-05T12:02:00.000Z");
  assert.deepEqual(repeated.revisions, changed.revisions);
  restored.revisions[0].before = -99;
  assert.equal(changed.revisions[0].before, 336.298123456);
});

test("corrupt or future cache ledgers are rejected in full instead of becoming trusted partial history", () => {
  const valid = updateSourceLedger(initial(), { CPIAUCSL: [{ date: "2026-09-01", value: 337 }] }, later).ledger;
  const empty = { version: 1, sources: {}, revisions: [] };
  for (const edit of [
    (value) => { value.version = 2; },
    (value) => { value.sources.UNKNOWN = value.sources.CPIAUCSL; },
    (value) => { value.sources.CPIAUCSL.checkedAt = "2026-11-06T12:00:00.000Z"; },
    (value) => { value.sources.CPIAUCSL.points[0].date = "2026-02-30"; },
    (value) => { value.sources.CPIAUCSL.points[0].value = Infinity; },
    (value) => { value.sources.CPIAUCSL.points.push({ ...value.sources.CPIAUCSL.points[0] }); },
    (value) => { value.revisions[0].firstDetectedAt = "2026-11-06T12:00:00.000Z"; },
    (value) => { value.revisions[0].after = value.revisions[0].before; },
    (value) => { value.revisions[0].after = 9; },
    (value) => { value.revisions[0].series = "UNKNOWN"; },
    (value) => { value.revisions.push({ ...value.revisions[0] }); },
  ]) {
    const corrupt = structuredClone(valid); edit(corrupt);
    assert.equal(isSourceLedger(corrupt, asOf), false);
    assert.deepEqual(hydrateSourceLedger(corrupt, asOf), empty);
  }
  for (const corrupt of [null, [], {}, { version: 1, sources: [], revisions: [] }]) assert.deepEqual(hydrateSourceLedger(corrupt, asOf), empty);
});

test("saved revision chains must connect and finish at any retained observation", () => {
  let ledger = updateSourceLedger(null, { UNRATE: [{ date: "2026-09-01", value: 4.2 }] }, time).ledger;
  ledger = updateSourceLedger(ledger, { UNRATE: [{ date: "2026-09-01", value: 4.3 }] }, later).ledger;
  const lastCheck = "2026-11-05T12:02:00.000Z";
  ledger = updateSourceLedger(ledger, { UNRATE: [{ date: "2026-09-01", value: 4.4 }] }, lastCheck).ledger;
  assert.equal(isSourceLedger(ledger, Date.parse(lastCheck)), true);
  const corrupt = structuredClone(ledger);
  corrupt.revisions[1].before = 8;
  assert.equal(isSourceLedger(corrupt, Date.parse(lastCheck)), false);
  // The rolling point window may discard this date, but the event remains valid.
  const noLongerObserved = structuredClone(ledger);
  noLongerObserved.sources.UNRATE.points = [{ date: "2026-10-01", value: 4.5 }];
  assert.equal(isSourceLedger(noLongerObserved, Date.parse(lastCheck)), true);
});

test("dates follow the US source calendar and invalid check times never enter a ledger", () => {
  const result = updateSourceLedger(null, { SP500: [{ date: "2026-11-06", value: 6000 }] }, "2026-11-06T01:00:00.000Z");
  assert.deepEqual(result.ledger.sources, {});
  for (const checkedAt of [null, "invalid", "2026-02-30T12:00:00.000Z", "2026-11-05"])
    assert.throws(() => updateSourceLedger(initial(), {}, checkedAt), /time/i);
});
