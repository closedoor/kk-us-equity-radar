import test from "node:test";
import assert from "node:assert/strict";
import {
  createCalendarService,
  parseBlsIcs,
  parseFomcCalendar,
  parseFredReleaseCalendar,
  parseNasdaqEarningsDate,
} from "./calendar.mjs";

test("parses BLS iCalendar CPI and employment events", () => {
  const parsed = parseBlsIcs(`BEGIN:VCALENDAR
BEGIN:VEVENT
DTSTART;TZID=Eastern Standard Time:20260807T083000
SUMMARY:Employment Situation for July 2026
END:VEVENT
BEGIN:VEVENT
DTSTART;TZID=Eastern Standard Time:20260812T083000
SUMMARY:Consumer Price Index for July 2026
END:VEVENT
END:VCALENDAR`);

  assert.deepEqual(parsed.employment, [{ date: "2026-08-07", period: "7 月" }]);
  assert.deepEqual(parsed.cpi, [{ date: "2026-08-12", period: "7 月" }]);
});

test("parses FRED release calendar fallback", () => {
  const html = `
    <span style="font-weight: bold;">Wednesday August 12, 2026</span>
    <span style="float: right; font-weight: bold;">Updated</span>
    <span style="font-weight: bold;">Friday September 11, 2026</span>`;

  assert.deepEqual(parseFredReleaseCalendar(html), [
    { date: "2026-08-12", period: "7 月" },
    { date: "2026-09-11", period: "8 月" },
  ]);
});

test("parses current and future FOMC panels", () => {
  const html = `
    <h4><a id="2026">2026 FOMC Meetings</a></h4>
    <div class="row fomc-meeting">
      <div class="fomc-meeting__month col"><strong>July</strong></div>
      <div class="fomc-meeting__date col">28-29</div>
    </div>
    <div class="row fomc-meeting">
      <div class="fomc-meeting__month col"><strong>September</strong></div>
      <div class="fomc-meeting__date col">15-16*</div>
    </div>
    <h4><a id="2027">2027 FOMC Meetings</a></h4>
    <div class="row fomc-meeting">
      <div class="fomc-meeting__month col"><strong>January</strong></div>
      <div class="fomc-meeting__date col">26-27</div>
    </div>`;

  assert.deepEqual(parseFomcCalendar(html), [
    { startDate: "2026-07-28", date: "2026-07-29", projections: false },
    { startDate: "2026-09-15", date: "2026-09-16", projections: true },
    { startDate: "2027-01-26", date: "2027-01-27", projections: false },
  ]);
});

test("parses Nasdaq earnings date and timing", () => {
  const event = parseNasdaqEarningsDate({
    data: {
      announcement: "Earnings announcement* for MSFT: Jul 29, 2026",
      reportText: "Microsoft is expected* to report earnings on 07/29/2026 after market close.",
    },
  });

  assert.equal(event.date, "2026-07-29");
  assert.equal(event.timing, "盘后");
  assert.equal(event.status, "estimated");
});

test("calendar service uses automatic dates and keeps confirmed company dates", async () => {
  const aiEarnings = [{
    company: "Microsoft",
    ticker: "MSFT",
    released: "2026-04-29",
    nextReportDate: "2026-07-29",
    nextReportLabel: "2026-07-29",
    nextReportStatus: "confirmed",
    nextReportSource: "https://example.com/microsoft",
  }];
  const fetchText = async (url) => {
    if (url.includes("bls.ics")) return `BEGIN:VEVENT\nDTSTART:20260812T083000\nSUMMARY:Consumer Price Index for July 2026\nEND:VEVENT\nBEGIN:VEVENT\nDTSTART:20260807T083000\nSUMMARY:Employment Situation for July 2026\nEND:VEVENT`;
    if (url.includes("fomccalendars")) return `<h4><a>2026 FOMC Meetings</a></h4><div class="fomc-meeting__month"><strong>July</strong></div><div class="fomc-meeting__date">28-29</div>`;
    if (url.includes("earnings-date")) return JSON.stringify({ data: { announcement: "Earnings announcement* for MSFT: Jul 29, 2026", reportText: "expected after market close" } });
    throw new Error(`unexpected URL ${url}`);
  };
  const service = createCalendarService({
    fetchText,
    aiEarnings,
    now: () => new Date("2026-07-15T12:00:00Z"),
  });

  await service.refresh({ force: true });
  const reminders = service.buildReminders();
  assert.equal(reminders[0].date, "2026-08-12");
  assert.equal(reminders[1].date, "2026-07-29");
  assert.equal(reminders[2].date, "2026-08-07");
  assert.equal(reminders[4].companies[0].next, "2026-07-29 · 盘后");
  assert.equal(reminders[4].companies[0].status, "confirmed");
});

test("marks a company snapshot stale after its confirmed next report has passed", () => {
  const service = createCalendarService({
    fetchText: async () => "",
    aiEarnings: [{
      company: "NVIDIA",
      ticker: "NVDA",
      released: "2026-05-20",
      nextReportDate: "2026-08-26",
      nextReportLabel: "2026-08-26",
      nextReportStatus: "confirmed",
    }],
    now: () => new Date("2026-08-31T12:00:00Z"),
  });

  const [company] = service.resolvedAiEarnings();
  assert.equal(company.snapshotStale, true);
  assert.equal(company.snapshotLabel, "财报解读待更新");
  assert.match(company.nextReportLabel, /待官宣/);
});

test("marks a company snapshot stale after an automatically estimated report date passes", () => {
  const service = createCalendarService({
    fetchText: async () => "",
    aiEarnings: [{
      company: "Broadcom",
      ticker: "AVGO",
      released: "2026-06-03",
      nextReportDate: null,
      nextReportLabel: "预计 9 月上旬 · 待官宣",
      nextReportStatus: "estimated",
    }],
    now: () => new Date("2026-09-05T12:00:00Z"),
  });
  service.hydrate({
    earnings: {
      AVGO: { date: "2026-09-03", timing: "盘后", status: "estimated" },
    },
  });

  const [company] = service.resolvedAiEarnings();
  assert.equal(company.snapshotStale, true);
  assert.equal(company.snapshotLabel, "财报解读待更新");
  assert.match(company.nextReportLabel, /2026-12-03/);
});

test("does not stale a fresh snapshot when the automatic estimate is only one day later", () => {
  const service = createCalendarService({
    fetchText: async () => "",
    aiEarnings: [{
      company: "Broadcom",
      ticker: "AVGO",
      released: "2026-09-02",
      nextReportDate: null,
      nextReportLabel: "预计 12 月上旬 · 待官宣",
      nextReportStatus: "estimated",
    }],
    now: () => new Date("2026-09-05T12:00:00Z"),
  });
  service.hydrate({
    earnings: {
      AVGO: { date: "2026-09-03", timing: "盘后", status: "estimated" },
    },
  });

  const [company] = service.resolvedAiEarnings();
  assert.equal(company.snapshotStale, false);
  assert.equal(company.snapshotLabel, "资料截至 2026-09-02");
  assert.match(company.nextReportLabel, /2026-12-02/);
});

test("rejects impossible automatic earnings dates", () => {
  const service = createCalendarService({
    fetchText: async () => "",
    aiEarnings: [{
      company: "Example",
      ticker: "TEST",
      released: "2026-01-01",
      nextReportDate: null,
      nextReportLabel: "待官宣",
      nextReportStatus: "estimated",
    }],
    now: () => new Date("2026-02-01T12:00:00Z"),
  });
  service.hydrate({
    earnings: {
      TEST: { date: "2026-02-31", timing: "盘后", status: "estimated" },
    },
  });

  const [company] = service.resolvedAiEarnings();
  assert.equal(company.nextReportDate, null);
  assert.match(company.nextReportLabel, /2026-04-01/);
});

test("clamps a month-end quarterly estimate to the last valid day", () => {
  const service = createCalendarService({
    fetchText: async () => "",
    aiEarnings: [{
      company: "Example",
      ticker: "TEST",
      released: "2026-01-31",
      nextReportDate: null,
      nextReportLabel: "待官宣",
      nextReportStatus: "estimated",
    }],
    now: () => new Date("2026-02-01T12:00:00Z"),
  });

  const [company] = service.resolvedAiEarnings();
  assert.match(company.nextReportLabel, /2026-04-30/);
});

test("uses the Nasdaq-listed symbol in SK hynix earnings links", () => {
  const service = createCalendarService({
    fetchText: async () => "",
    aiEarnings: [{
      company: "SK hynix",
      ticker: "000660.KS",
      released: "2026-07-29",
      nextReportDate: null,
      nextReportLabel: "待官宣",
      nextReportStatus: "estimated",
    }],
    now: () => new Date("2026-09-06T12:00:00Z"),
  });
  service.hydrate({
    earnings: {
      "000660.KS": { date: "2026-10-29", timing: "盘后", status: "estimated" },
    },
  });

  const [company] = service.resolvedAiEarnings();
  assert.equal(company.nextReportSource, "https://www.nasdaq.com/market-activity/stocks/skhy/earnings");
});

test("does not replace upcoming reminders with past-only source calendars", async () => {
  const fetchText = async (url) => {
    if (url.includes("bls.ics")) return `BEGIN:VEVENT\nDTSTART:20260812T083000\nSUMMARY:Consumer Price Index for July 2026\nEND:VEVENT\nBEGIN:VEVENT\nDTSTART:20260807T083000\nSUMMARY:Employment Situation for July 2026\nEND:VEVENT`;
    if (url.includes("cpi.htm")) return `<table><tr><td>September 2026</td><td>Wednesday, October 14, 2026</td></tr></table>`;
    if (url.includes("empsit.htm")) return `<table><tr><td>September 2026</td><td>Friday, October 2, 2026</td></tr></table>`;
    if (url.includes("fomccalendars")) return `<h4><a>2026 FOMC Meetings</a></h4><div class="fomc-meeting__month"><strong>July</strong></div><div class="fomc-meeting__date">28-29</div>`;
    throw new Error(`unexpected URL ${url}`);
  };
  const service = createCalendarService({
    fetchText,
    aiEarnings: [],
    now: () => new Date("2026-09-06T12:00:00Z"),
  });

  await service.refresh({ force: true });
  const reminders = service.buildReminders();
  assert.equal(reminders[0].date, "2026-10-14");
  assert.equal(reminders[1].date, "2026-09-16");
  assert.equal(reminders[2].date, "2026-10-02");
  assert.match(reminders[0].source, /cpi\.htm$/);
  assert.match(reminders[2].source, /empsit\.htm$/);
  assert.match(service.syncStatus().sources.fomc.error, /future/i);
});

test("uses New York year and the matching FRED calendar link across year-end", async () => {
  const requested = [];
  const fetchText = async (url) => {
    requested.push(url);
    if (url.includes("bls.gov")) throw new Error("BLS unavailable");
    if (url.includes("rid=10")) return `<span style="font-weight: bold;">Wednesday January 13, 2027</span>`;
    if (url.includes("rid=50")) return `<span style="font-weight: bold;">Friday January 8, 2027</span>`;
    if (url.includes("fomccalendars")) return `<h4><a>2027 FOMC Meetings</a></h4><div class="fomc-meeting__month"><strong>January</strong></div><div class="fomc-meeting__date">26-27</div>`;
    throw new Error(`unexpected URL ${url}`);
  };
  const service = createCalendarService({
    fetchText,
    aiEarnings: [],
    now: () => new Date("2027-01-01T01:00:00Z"),
  });

  await service.refresh({ force: true });
  const reminders = service.buildReminders();
  assert.ok(requested.some((url) => url.includes("rid=10") && url.includes("y=2026")));
  assert.ok(requested.some((url) => url.includes("rid=50") && url.includes("y=2026")));
  assert.match(reminders[0].source, /rid=10.*y=2027/);
  assert.match(reminders[2].source, /rid=50.*y=2027/);
});

test("keeps usable next-year FRED dates when the current-year page fails", async () => {
  const fetchText = async (url) => {
    if (url.includes("bls.gov")) throw new Error("BLS unavailable");
    if (url.includes("y=2026")) throw new Error("current-year page unavailable");
    if (url.includes("rid=10")) return `<span style="font-weight: bold;">Wednesday January 13, 2027</span>`;
    if (url.includes("rid=50")) return `<span style="font-weight: bold;">Friday January 8, 2027</span>`;
    if (url.includes("fomccalendars")) return `<h4><a>2027 FOMC Meetings</a></h4><div class="fomc-meeting__month"><strong>January</strong></div><div class="fomc-meeting__date">26-27</div>`;
    throw new Error(`unexpected URL ${url}`);
  };
  const service = createCalendarService({
    fetchText,
    aiEarnings: [],
    now: () => new Date("2027-01-01T01:00:00Z"),
  });

  await service.refresh({ force: true });
  const reminders = service.buildReminders();
  assert.equal(reminders[0].date, "2027-01-13");
  assert.equal(reminders[2].date, "2027-01-08");
});

test("retries failed calendar sources sooner than the normal refresh interval", async () => {
  let current = new Date("2026-09-06T12:00:00Z");
  let requests = 0;
  const service = createCalendarService({
    fetchText: async () => {
      requests += 1;
      throw new Error("temporary outage");
    },
    aiEarnings: [],
    now: () => current,
    cacheTtlMs: 6 * 60 * 60 * 1000,
    failureRetryMs: 30 * 60 * 1000,
  });

  await service.refresh();
  const firstAttemptRequests = requests;
  current = new Date("2026-09-06T12:10:00Z");
  await service.refresh();
  assert.equal(requests, firstAttemptRequests);
  current = new Date("2026-09-06T12:31:00Z");
  await service.refresh();
  assert.ok(requests > firstAttemptRequests);
});
