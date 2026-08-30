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
  assert.equal(reminders[4].companies[0].next, "2026-07-29");
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
