import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { parseBlsPublication, createPublicationService } from "./publication.mjs";
import * as publication from "./publication.mjs";

const BEA = JSON.parse(readFileSync(new URL("./fixtures/bea-pce-publication.json", import.meta.url)));

const URLS = {
  cpi: "https://www.bls.gov/news.release/cpi.nr0.htm",
  employment: "https://www.bls.gov/news.release/empsit.nr0.htm",
  pce: BEA.indexUrl,
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
  const value = overrides[url] ?? (url === URLS.cpi ? CPI : url === URLS.employment ? JOBS : url === URLS.pce ? BEA.indexHtml : url === BEA.releaseUrl ? BEA.releaseHtml : new Error(`Unexpected source ${url}`));
  if (value instanceof Error) throw value;
  return value;
};
function record(kind, period, publishedAt, checkedAt = NOW, extra = {}) {
  return { period, publishedAt, checkedAt, source: URLS[kind], error: null, ...extra };
}
function saved(sources) { return { version: 1, sources: { cpi: null, employment: null, pce: null, ...sources } }; }

test("actual BEA current-release link and embargo header establish the stated PCE month", () => {
  assert.equal(typeof publication.findBeaReleaseUrl, "function");
  assert.equal(typeof publication.parseBeaPublication, "function");
  assert.equal(publication.findBeaReleaseUrl(BEA.indexHtml), BEA.releaseUrl);
  const html = BEA.releaseHtml + '<p>Next release: November 25, 2026, at 8:30 a.m. EST<br>Personal Income and Outlays, October 2026</p>';
  assert.deepEqual(publication.parseBeaPublication(html, BEA.releaseUrl, NOW), record("pce", "2026-09", "2026-10-29T12:30:00.000Z", NOW, { releaseUrl: BEA.releaseUrl }));
  const wrapped = BEA.releaseHtml.replace('8:30 a.m.', '<strong>8:30</strong>&nbsp;a.m.').replace('September 2026', '<span>SEPTEMBER</span>\n2026');
  assert.deepEqual(publication.parseBeaPublication(wrapped, BEA.releaseUrl, NOW), publication.parseBeaPublication(BEA.releaseHtml, BEA.releaseUrl, NOW));
});

test("BEA discovery follows only one official dated Current Release link", () => {
  assert.equal(publication.findBeaReleaseUrl(`<script>${BEA.indexHtml}</script><!--${BEA.indexHtml}-->${BEA.indexHtml}`), BEA.releaseUrl);
  assert.equal(publication.findBeaReleaseUrl(BEA.indexHtml.replace('href="/', 'href="https://www.bea.gov/')), BEA.releaseUrl);
  for (const html of [
    '<a href="/news/2026/personal-income-and-outlays-september-2026">Next release</a>',
    BEA.indexHtml + BEA.indexHtml,
    BEA.indexHtml.replace('/news/', '//example.com/news/'),
    BEA.indexHtml.replace('/news/', 'https://www.bea.gov.evil.test/news/'),
    BEA.indexHtml.replace('-september-', '-unknown-'),
    BEA.indexHtml.replace('-2026"', '-2026?download=1"'),
    BEA.indexHtml.replace('/news/2026/', '/news/%32%30%32%36/'),
    BEA.indexHtml.replace('-2026"', '-2026\n"'),
  ]) assert.throws(() => publication.findBeaReleaseUrl(html), /BEA/);
});

test("BEA embargo conversion validates DST, weekday, future instants, and cross-year delayed reports", () => {
  const winter = BEA.releaseHtml.replace('EDT, Thursday, October 29, 2026', 'EST, Friday, January 8, 2027').replace('September 2026', 'November 2026');
  const url = 'https://www.bea.gov/news/2027/personal-income-and-outlays-november-2026';
  assert.equal(publication.parseBeaPublication(winter, url, '2027-01-08T15:00:00Z').publishedAt, '2027-01-08T13:30:00.000Z');
  assert.throws(() => publication.parseBeaPublication(BEA.releaseHtml, BEA.releaseUrl, '2026-10-29T12:29:59.999Z'), /embargo/);
  assert.equal(publication.parseBeaPublication(BEA.releaseHtml, BEA.releaseUrl, '2026-10-29T12:30:00.000Z').period, '2026-09');
  assert.throws(() => publication.parseBeaPublication(BEA.releaseHtml.replace('EDT,', 'EST,'), BEA.releaseUrl, NOW), /timezone/);
  assert.throws(() => publication.parseBeaPublication(BEA.releaseHtml.replace('Thursday,', 'Friday,'), BEA.releaseUrl, NOW), /weekday/);
  const ambiguous = BEA.releaseHtml.replace('8:30 a.m. EDT, Thursday, October 29, 2026', '1:30 a.m. ET, Sunday, November 1, 2026');
  assert.throws(() => publication.parseBeaPublication(ambiguous, BEA.releaseUrl, NOW), /ambiguous/);
});

test("BEA unsupported pages, changed titles, unsafe URLs, and conflicting evidence cannot establish a release", () => {
  for (const html of [
    '<h1>Access Denied</h1>',
    BEA.releaseHtml.replace('EMBARGOED UNTIL RELEASE AT', 'Scheduled for'),
    BEA.releaseHtml.replace('September 2026', 'October 2026'),
    BEA.releaseHtml.replace('October 29, 2026', 'February 30, 2026'),
    BEA.releaseHtml + BEA.releaseHtml,
    BEA.releaseHtml.replace(/<h1>[\s\S]*?<\/h1>/, '<p>Personal Income and Outlays, September 2026</p>'),
  ]) assert.throws(() => publication.parseBeaPublication(html, BEA.releaseUrl, NOW), /BEA/);
  for (const url of [BEA.releaseUrl.replace('www.bea.gov', 'example.com'), BEA.releaseUrl + '?fake=1', BEA.releaseUrl.replace('/2026/', '/2025/'), BEA.releaseUrl.replace('-september-', '-august-')]) {
    assert.throws(() => publication.parseBeaPublication(BEA.releaseHtml, url, NOW), /BEA/);
  }
  assert.throws(() => publication.parseBeaPublication(BEA.releaseHtml, BEA.releaseUrl, 'invalid'), /verification time/);
  assert.throws(() => parseBlsPublication(CPI, 'pce', NOW), /Unknown/);
});

test("BEA article failures preserve prior proof, release URL, and last successful check time", async () => {
  for (const [badResponse, expectedError] of [
    [new Error('BEA article unavailable'), /article unavailable/],
    ['<h1>Access Denied</h1>', /report period/],
    [BEA.releaseHtml.replace('Thursday, October 29, 2026', 'Wednesday, November 25, 2026').replace('EDT,', 'EST,'), /embargo has not passed/],
  ]) {
    let current = new Date('2026-11-04T12:00:00Z');
    let failure = null;
    const service = createPublicationService({ fetchText: (url) => responses(failure && url === BEA.releaseUrl ? { [url]: failure } : {})(url), now: () => current, logger: quiet });
    await service.refresh();
    failure = badResponse;
    current = new Date(NOW);
    const row = (await service.refresh()).sources.pce;
    assert.equal(row.period, '2026-09');
    assert.equal(row.releaseUrl, BEA.releaseUrl);
    assert.equal(row.checkedAt, '2026-11-04T12:00:00.000Z');
    assert.equal(row.attemptedAt, NOW);
    assert.match(row.error, expectedError);
  }
});

test("same-period BEA corrections retain the provenance of the first proven publication", () => {
  const service = createPublicationService({ fetchText: responses(), now: () => new Date('2027-01-10T15:00:00Z') });
  service.hydrate(saved({ pce: record('pce', '2026-09', '2026-10-29T12:30:00Z', NOW, { releaseUrl: BEA.releaseUrl }) }));
  service.hydrate(saved({ pce: record('pce', '2026-09', '2027-01-08T13:30:00Z', '2027-01-08T15:00:00Z', { releaseUrl: 'https://www.bea.gov/news/2027/personal-income-and-outlays-september-2026' }) }));
  const row = service.snapshot().sources.pce;
  assert.equal(row.publishedAt, '2026-10-29T12:30:00.000Z');
  assert.equal(row.releaseUrl, BEA.releaseUrl);
  assert.equal(row.checkedAt, '2027-01-08T15:00:00.000Z');
});

test("BEA cache evidence stays monotone while legacy two-source caches remain hydratable", async () => {
  const service = createPublicationService({ fetchText: responses(), now: () => new Date(NOW), logger: quiet });
  service.hydrate({ version: 1, sources: { cpi: record('cpi', '2026-09', '2026-10-14T12:30:00Z'), employment: null } });
  assert.equal(service.snapshot().sources.cpi.period, '2026-09');
  const newer = record('pce', '2026-10', '2026-11-02T13:30:00Z', '2026-11-03T12:00:00Z', { releaseUrl: 'https://www.bea.gov/news/2026/personal-income-and-outlays-october-2026' });
  service.hydrate(saved({ pce: newer }));
  service.hydrate(saved({ pce: record('pce', '2026-09', '2026-10-29T12:30:00Z', '2026-11-01T12:00:00Z', { releaseUrl: BEA.releaseUrl }) }));
  const row = (await service.refresh()).sources.pce;
  assert.equal(row.period, '2026-10');
  assert.equal(row.releaseUrl, newer.releaseUrl);
  assert.equal(row.checkedAt, '2026-11-03T12:00:00.000Z');
  assert.match(row.error, /moved backward/);
});

test("BEA cache hydration rejects foreign or inconsistent article provenance", () => {
  const good = record('pce', '2026-09', '2026-10-29T12:30:00Z', NOW, { releaseUrl: BEA.releaseUrl });
  for (const row of [
    { ...good, releaseUrl: undefined }, { ...good, releaseUrl: BEA.releaseUrl.replace('www.bea.gov', 'evil.test') },
    { ...good, releaseUrl: BEA.releaseUrl + '#body' }, { ...good, period: '2026-08' },
    { ...good, releaseUrl: BEA.releaseUrl.replace('/2026/', '/2025/') },
  ]) {
    const service = createPublicationService({ fetchText: responses(), now: () => new Date(NOW) });
    service.hydrate(saved({ pce: row }));
    assert.equal(service.snapshot().sources.pce, null);
  }
});

test("a failed BEA discovery never follows a foreign URL or invents a release", async () => {
  const calls = [];
  const service = createPublicationService({ fetchText: async (url) => { calls.push(url); return responses({ [URLS.pce]: BEA.indexHtml.replace('/news/', 'https://evil.test/news/') })(url); }, now: () => new Date(NOW), logger: quiet });
  const row = (await service.refresh()).sources.pce;
  assert.deepEqual(calls.sort(), Object.values(URLS).sort());
  assert.equal(row.period, null);
  assert.equal(row.publishedAt, null);
  assert.equal(row.source, URLS.pce);
  assert.ok(row.error);
});

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

test("refresh verifies three canonical sources and snapshots are independent copies", async () => {
  const calls = [];
  const fetchText = responses();
  const service = createPublicationService({ fetchText: async (url, headers) => { calls.push([url, headers]); return fetchText(url); }, now: () => new Date(NOW) });
  assert.deepEqual(service.snapshot(), saved({}));
  const result = await service.refresh();
  assert.deepEqual(calls.map(([url]) => url).sort(), [...Object.values(URLS), BEA.releaseUrl].sort());
  assert.ok(calls.every(([, headers]) => headers.accept.includes("text/html")));
  assert.equal(result.sources.cpi.period, "2026-09");
  assert.equal(result.sources.employment.period, "2026-09");
  assert.equal(result.sources.pce.period, "2026-09");
  result.sources.cpi.period = "1900-01";
  assert.equal(service.snapshot().sources.cpi.period, "2026-09");
});

test("each completed publication notifies independently while another source remains pending", async () => {
  let releasePce;
  const pceGate = new Promise((resolve) => { releasePce = resolve; });
  const changes = [];
  const service = createPublicationService({
    fetchText: async (url) => { if (url === URLS.pce) await pceGate; return responses()(url); },
    now: () => new Date(NOW), logger: quiet,
    onChange: async (snapshot, { kind }) => { changes.push({ snapshot, kind }); },
  });
  const pending = service.refresh();
  await new Promise(setImmediate);
  assert.deepEqual(changes.map(({ kind }) => kind).sort(), ["cpi", "employment"]);
  assert.equal(changes.find(({ kind }) => kind === "cpi").snapshot.sources.cpi.period, "2026-09");
  assert.equal(service.snapshot().sources.pce, null);
  assert.strictEqual(service.refresh({ force: true }), pending);
  releasePce();
  await pending;
  assert.equal(changes.length, 3);
  assert.equal(changes.at(-1).kind, "pce");
  assert.equal(changes.at(-1).snapshot.sources.pce.period, "2026-09");
  changes.at(-1).snapshot.sources.pce.period = "1900-01";
  assert.equal(service.snapshot().sources.pce.period, "2026-09");
  await service.refresh();
  assert.equal(changes.length, 3, "A TTL cache hit must not report another source update");
});

test("notification failures remain separate from provider proof and still notify failed sources", async () => {
  const warnings = [];
  const notified = [];
  const service = createPublicationService({
    fetchText: responses({ [URLS.pce]: new Error("403 BEA unavailable") }), now: () => new Date(NOW),
    logger: { warn(message) { warnings.push(message); } },
    onChange: async (_snapshot, { kind }) => { notified.push(kind); throw new Error("disk unavailable"); },
  });
  const result = await service.refresh();
  assert.deepEqual(notified.sort(), ["cpi", "employment", "pce"]);
  assert.equal(result.sources.cpi.error, null);
  assert.equal(result.sources.employment.error, null);
  assert.equal(result.sources.pce.error, "403 BEA unavailable");
  assert.equal(warnings.filter((message) => message.includes("change callback failed") && message.includes("disk unavailable")).length, 3);
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
  assert.equal(calls, 3);
  release();
  await first;
  await service.refresh();
  assert.equal(calls, 4);
  current = new Date(Date.parse(NOW) + 14 * 60_000);
  await service.refresh();
  assert.equal(calls, 4);
  current = new Date(Date.parse(NOW) + 15 * 60_000);
  await service.refresh();
  assert.equal(calls, 8);
  await service.refresh({ force: true });
  assert.equal(calls, 12);
});

test("source failures retry after five minutes and successful recovery clears failure metadata", async () => {
  let current = new Date(NOW);
  let calls = 0;
  let failing = true;
  const service = createPublicationService({ fetchText: async (url) => { calls += 1; if (failing) throw new Error("offline"); return responses()(url); }, now: () => current, logger: quiet });
  await service.refresh();
  current = new Date(Date.parse(NOW) + 299_999);
  await service.refresh();
  assert.equal(calls, 3);
  current = new Date(Date.parse(NOW) + 300_000);
  failing = false;
  await service.refresh();
  assert.equal(calls, 7);
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
