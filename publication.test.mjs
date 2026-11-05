import test from "node:test";
import assert from "node:assert/strict";
import { parseBlsPublication, createPublicationService } from "./publication.mjs";

const URLS = {
  cpi: "https://www.bls.gov/news.release/cpi.nr0.htm",
  employment: "https://www.bls.gov/news.release/empsit.nr0.htm",
};
const CPI = `<html><head><title>Consumer Price Index Summary</title></head><body><nav>Release calendars</nav><pre>
Transmission of material in this release is embargoed until
8:30 a.m. (ET) Wednesday, October 14, 2026          USDL-26-1574
Technical information: cpi_info@bls.gov
CONSUMER PRICE INDEX - SEPTEMBER 2026
The Consumer Price Index was reported today.
</pre><p>The next release is scheduled for November 10, 2026.</p></body></html>`;
const JOBS = `<pre>Transmission of material in this news release is embargoed until USDL-26-1549
8:30 a.m. (ET) Friday, October 2, 2026
Technical information: Household data and Establishment data
THE EMPLOYMENT SITUATION - SEPTEMBER 2026
Both nonfarm payroll employment and the unemployment rate changed little.</pre>`;
const NOW = "2026-11-05T12:00:00.000Z";
const quiet = { warn() {} };
const responses = (overrides = {}) => async (url) => {
  const value = overrides[url] ?? (url === URLS.cpi ? CPI : JOBS);
  if (value instanceof Error) throw value;
  return value;
};
function record(kind, period, publishedAt, checkedAt = NOW, extra = {}) {
  return { period, publishedAt, checkedAt, source: URLS[kind], error: null, ...extra };
}
function saved(sources) { return { version: 1, sources: { cpi: null, employment: null, ...sources } }; }

test("actual BLS CPI and employment headers establish published September periods, not their next scheduled dates", () => {
  assert.deepEqual(parseBlsPublication(CPI, "cpi", NOW), record("cpi", "2026-09", "2026-10-14T12:30:00.000Z"));
  assert.deepEqual(parseBlsPublication(JOBS, "employment", new Date(NOW)), record("employment", "2026-09", "2026-10-02T12:30:00.000Z"));
});

test("HTML tags, entities, case, and wrapped release headers keep the same evidence", () => {
  const html = CPI.replace("8:30 a.m. (ET)", "<strong>8:30</strong>&nbsp;A.M.&#160;(et)")
    .replace("Wednesday, October", "Wednesday,\n October")
    .replace("CONSUMER PRICE INDEX - SEPTEMBER", "Consumer <span>Price Index</span> &ndash; September");
  assert.deepEqual(parseBlsPublication(html, "cpi", NOW), parseBlsPublication(CPI, "cpi", NOW));
  const poison = '<script>Transmission of material in this release is embargoed until 8:30 a.m. (ET) November 10, 2026 CONSUMER PRICE INDEX - OCTOBER 2026</script>';
  assert.deepEqual(parseBlsPublication(poison + CPI, "cpi", NOW), parseBlsPublication(CPI, "cpi", NOW));
});

test("Eastern time conversion follows winter, summer, and the November DST change", () => {
  for (const [date, check, expected] of [
    ["Friday, February 13, 2026", "2026-02-13T14:00:00Z", "2026-02-13T13:30:00.000Z"],
    ["Wednesday, July 15, 2026", "2026-07-15T14:00:00Z", "2026-07-15T12:30:00.000Z"],
    ["Tuesday, November 10, 2026", "2026-11-10T14:00:00Z", "2026-11-10T13:30:00.000Z"],
  ]) {
    const html = CPI.replace("Wednesday, October 14, 2026", date).replace("SEPTEMBER 2026", "JANUARY 2026");
    assert.equal(parseBlsPublication(html, "cpi", check).publishedAt, expected);
  }
});

test("cross-year or delayed releases use the stated report month instead of subtracting one month", () => {
  const html = CPI.replace("Wednesday, October 14, 2026", "Friday, January 8, 2027").replace("SEPTEMBER 2026", "NOVEMBER 2026");
  const result = parseBlsPublication(html, "cpi", "2027-01-08T15:00:00Z");
  assert.equal(result.period, "2026-11");
  assert.equal(result.publishedAt, "2027-01-08T13:30:00.000Z");
});

test("future embargoes are not proof and become usable exactly at the published instant", () => {
  assert.throws(() => parseBlsPublication(CPI, "cpi", "2026-10-14T12:29:59.999Z"), /embargo has not passed/);
  assert.equal(parseBlsPublication(CPI, "cpi", "2026-10-14T12:30:00.000Z").period, "2026-09");
});

test("an explicit EST or EDT label must agree with actual New York daylight saving time", () => {
  assert.equal(parseBlsPublication(CPI.replace("(ET)", "(EDT)"), "cpi", NOW).publishedAt, "2026-10-14T12:30:00.000Z");
  assert.throws(() => parseBlsPublication(CPI.replace("(ET)", "(EST)"), "cpi", NOW), /timezone conflicts/);
});

test("ambiguous or nonexistent daylight saving wall times are rejected", () => {
  const nonexistent = CPI.replace("Wednesday, October 14, 2026", "Sunday, March 8, 2026")
    .replace("8:30 a.m.", "2:30 a.m.").replace("SEPTEMBER 2026", "FEBRUARY 2026");
  const ambiguous = CPI.replace("Wednesday, October 14, 2026", "Sunday, November 1, 2026").replace("8:30 a.m.", "1:30 a.m.");
  assert.throws(() => parseBlsPublication(nonexistent, "cpi", NOW), /ambiguous or nonexistent/);
  assert.throws(() => parseBlsPublication(ambiguous, "cpi", NOW), /ambiguous or nonexistent/);
});

test("wrong pages, invalid dates, missing fields, and conflicting report periods do not create evidence", () => {
  for (const html of [
    "<h1>Access Denied</h1>", JOBS,
    CPI.replace("embargoed until", "scheduled for"),
    CPI.replace("CONSUMER PRICE INDEX - SEPTEMBER 2026", "Consumer Price Index Summary"),
    CPI.replace("SEPTEMBER 2026", "UNDECEMBER 2026"),
    CPI.replace("SEPTEMBER 2026", "NOVEMBER 2026"),
    CPI.replace("Wednesday, October 14, 2026", "Wednesday, February 30, 2026"),
    CPI.replace("Wednesday, October 14, 2026", "Thursday, October 14, 2026"),
    CPI.replace("8:30 a.m.", "13:30 a.m."),
    CPI.replace("8:30 a.m.", "8:65 a.m."),
    CPI + "CONSUMER PRICE INDEX - AUGUST 2026",
    CPI + CPI,
  ]) assert.throws(() => parseBlsPublication(html, "cpi", NOW), /BLS/);
  assert.throws(() => parseBlsPublication(CPI, "unknown", NOW), /Unknown/);
  assert.throws(() => parseBlsPublication(CPI, "cpi", "2026-02-30T12:00:00Z"), /verification time/);
});

test("refresh verifies two canonical news releases and snapshots are independent copies", async () => {
  const calls = [];
  const fetchText = responses();
  const service = createPublicationService({ fetchText: async (url, headers) => { calls.push([url, headers]); return fetchText(url); }, now: () => new Date(NOW) });
  assert.deepEqual(service.snapshot(), saved({}));
  const result = await service.refresh();
  assert.deepEqual(calls.map(([url]) => url).sort(), Object.values(URLS).sort());
  assert.ok(calls.every(([, headers]) => headers.accept.includes("text/html")));
  assert.equal(result.sources.cpi.period, "2026-09");
  assert.equal(result.sources.employment.period, "2026-09");
  result.sources.cpi.period = "1900-01";
  assert.equal(service.snapshot().sources.cpi.period, "2026-09");
});

test("failed sources without proof disclose unknown periods instead of inventing publication dates", async () => {
  const service = createPublicationService({ fetchText: async () => { throw new Error("403 Forbidden"); }, now: () => new Date(NOW), logger: quiet });
  const result = await service.refresh();
  for (const [kind, row] of Object.entries(result.sources)) {
    assert.deepEqual(row, { period: null, publishedAt: null, checkedAt: NOW, source: URLS[kind], error: "403 Forbidden" });
  }
});

test("partial or malformed refresh failures retain the last proof and its successful verification time", async () => {
  let current = new Date("2026-11-04T12:00:00Z");
  let fail = false;
  const service = createPublicationService({
    fetchText: (url) => fail && url === URLS.cpi ? Promise.resolve("<h1>Access Denied</h1>") : responses()(url),
    now: () => current, logger: quiet,
  });
  await service.refresh();
  fail = true;
  current = new Date(NOW);
  const result = await service.refresh();
  assert.equal(result.sources.cpi.period, "2026-09");
  assert.equal(result.sources.cpi.checkedAt, "2026-11-04T12:00:00.000Z");
  assert.equal(result.sources.cpi.attemptedAt, NOW);
  assert.match(result.sources.cpi.error, /header/);
  assert.equal(result.sources.employment.checkedAt, NOW);
  assert.equal(result.sources.employment.error, null);
});

test("future releases preserve prior proof rather than establishing an unpublished period", async () => {
  const service = createPublicationService({ fetchText: responses({ [URLS.cpi]: CPI.replace("Wednesday, October 14, 2026", "Tuesday, November 10, 2026").replace("SEPTEMBER 2026", "OCTOBER 2026") }), now: () => new Date(NOW), logger: quiet });
  service.hydrate(saved({ cpi: record("cpi", "2026-09", "2026-10-14T12:30:00Z", "2026-11-04T12:00:00Z") }));
  const row = (await service.refresh()).sources.cpi;
  assert.equal(row.period, "2026-09");
  assert.equal(row.checkedAt, "2026-11-04T12:00:00.000Z");
  assert.equal(row.attemptedAt, NOW);
  assert.match(row.error, /embargo/);
});

test("cache hydration and stale successful pages cannot roll a verified period backward", async () => {
  const service = createPublicationService({ fetchText: responses(), now: () => new Date("2026-11-11T12:00:00Z"), logger: quiet });
  const recent = record("cpi", "2026-10", "2026-11-10T13:30:00Z", "2026-11-10T14:00:00Z");
  service.hydrate(saved({ cpi: recent }));
  service.hydrate(saved({ cpi: record("cpi", "2026-09", "2026-10-14T12:30:00Z", NOW) }));
  assert.equal(service.snapshot().sources.cpi.period, "2026-10");
  assert.equal(service.snapshot().sources.cpi.error, null);
  const row = (await service.refresh()).sources.cpi;
  assert.equal(row.period, "2026-10");
  assert.equal(row.publishedAt, "2026-11-10T13:30:00.000Z");
  assert.equal(row.checkedAt, "2026-11-10T14:00:00.000Z");
  assert.equal(row.attemptedAt, "2026-11-11T12:00:00.000Z");
  assert.match(row.error, /moved backward/);
});

test("same-period corrections cannot postpone the first already-proven publication", () => {
  const service = createPublicationService({ fetchText: responses(), now: () => new Date(NOW) });
  service.hydrate(saved({ cpi: record("cpi", "2026-09", "2026-10-14T12:30:00Z", "2026-10-15T12:00:00Z") }));
  service.hydrate(saved({ cpi: record("cpi", "2026-09", "2026-10-15T12:30:00Z", NOW) }));
  assert.equal(service.snapshot().sources.cpi.publishedAt, "2026-10-14T12:30:00.000Z");
  assert.equal(service.snapshot().sources.cpi.checkedAt, NOW);
});

test("cache hydration ignores unsupported, malformed, foreign-source, or future proof records", () => {
  const good = record("cpi", "2026-09", "2026-10-14T12:30:00Z");
  for (const snapshot of [null, [], { version: 2, sources: { cpi: good } },
    ...[
      { ...good, period: "2026-13" }, { ...good, source: "https://example.com/fake" },
      { ...good, publishedAt: "2026-11-06T12:30:00Z" }, { ...good, checkedAt: "2026-11-06T12:30:00Z" },
      { ...good, error: {} }, { ...good, period: null },
      { ...good, attemptedAt: "2026-11-06T12:30:00Z" }, { ...good, attemptedAt: "2026-11-04T12:30:00Z" },
      { period: null, publishedAt: null, source: URLS.cpi, checkedAt: NOW, error: null },
    ].map((row) => saved({ cpi: row })),
  ]) {
    const service = createPublicationService({ fetchText: responses(), now: () => new Date(NOW) });
    service.hydrate(snapshot);
    assert.equal(service.snapshot().sources.cpi, null);
  }
});

test("hydration preserves last proof when a newer error-only record arrives", () => {
  const service = createPublicationService({ fetchText: responses(), now: () => new Date(NOW) });
  service.hydrate(saved({ cpi: record("cpi", "2026-09", "2026-10-14T12:30:00Z", "2026-11-04T12:00:00Z") }));
  service.hydrate(saved({ cpi: { period: null, publishedAt: null, checkedAt: NOW, source: URLS.cpi, error: "offline" } }));
  assert.deepEqual(service.snapshot().sources.cpi, record("cpi", "2026-09", "2026-10-14T12:30:00.000Z", "2026-11-04T12:00:00.000Z", { error: "offline", attemptedAt: NOW }));
});

test("older cached proof fills an unknown record without erasing a newer verification failure", () => {
  const service = createPublicationService({ fetchText: responses(), now: () => new Date(NOW) });
  service.hydrate(saved({ cpi: { period: null, publishedAt: null, checkedAt: NOW, source: URLS.cpi, error: "latest outage" } }));
  service.hydrate(saved({ cpi: record("cpi", "2026-09", "2026-10-14T12:30:00Z", "2026-11-04T12:00:00Z") }));
  assert.deepEqual(service.snapshot().sources.cpi, record("cpi", "2026-09", "2026-10-14T12:30:00.000Z", "2026-11-04T12:00:00.000Z", { error: "latest outage", attemptedAt: NOW }));
});

test("normal refresh TTL, forced retries, and in-flight coalescing do not multiply source requests", async () => {
  let current = new Date(NOW);
  let calls = 0;
  let release;
  const gate = new Promise((resolve) => { release = resolve; });
  const service = createPublicationService({ fetchText: async (url) => { calls += 1; await gate; return responses()(url); }, now: () => current });
  const first = service.refresh();
  assert.strictEqual(service.refresh({ force: true }), first);
  assert.equal(calls, 2);
  release();
  await first;
  await service.refresh();
  assert.equal(calls, 2);
  current = new Date(Date.parse(NOW) + 14 * 60_000);
  await service.refresh();
  assert.equal(calls, 2);
  current = new Date(Date.parse(NOW) + 15 * 60_000);
  await service.refresh();
  assert.equal(calls, 4);
  await service.refresh({ force: true });
  assert.equal(calls, 6);
});

test("source failures retry after five minutes and successful recovery clears failure metadata", async () => {
  let current = new Date(NOW);
  let calls = 0;
  let failing = true;
  const service = createPublicationService({ fetchText: async (url) => { calls += 1; if (failing) throw new Error("offline"); return responses()(url); }, now: () => current, logger: quiet });
  await service.refresh();
  current = new Date(Date.parse(NOW) + 299_999);
  await service.refresh();
  assert.equal(calls, 2);
  current = new Date(Date.parse(NOW) + 300_000);
  failing = false;
  await service.refresh();
  assert.equal(calls, 4);
  assert.equal(service.snapshot().sources.cpi.error, null);
  assert.equal(service.snapshot().sources.cpi.attemptedAt, undefined);
});

test("the verification instant is measured after the body arrives, including an embargo crossing", async () => {
  let current = new Date("2026-10-14T12:29:59.000Z");
  const service = createPublicationService({ fetchText: async (url) => { current = new Date("2026-10-14T12:30:00.000Z"); return responses()(url); }, now: () => current });
  const row = (await service.refresh()).sources.cpi;
  assert.equal(row.period, "2026-09");
  assert.equal(row.checkedAt, "2026-10-14T12:30:00.000Z");
});
