// Scheduled cash-equity sessions. Source: https://www.nyse.com/trade/hours-calendars
// Last verified 2026-11-22. Extend the calendar before the published range ends;
// an unverified weekday is not evidence of an open market. Emergency closures
// and unscheduled halts are not inferred from these published dates.
export const EQUITY_OPEN_MINUTE = 9 * 60 + 30;
const FIRST = "2026-01-01", LAST = "2028-12-31";
const HOLIDAYS = new Set([
  "2026-01-01", "2026-01-19", "2026-02-16", "2026-04-03", "2026-05-25",
  "2026-06-19", "2026-07-03", "2026-09-07", "2026-11-26", "2026-12-25",
  "2027-01-01", "2027-01-18", "2027-02-15", "2027-03-26", "2027-05-31",
  "2027-06-18", "2027-07-05", "2027-09-06", "2027-11-25", "2027-12-24",
  "2028-01-17", "2028-02-21", "2028-04-14", "2028-05-29", "2028-06-19",
  "2028-07-04", "2028-09-04", "2028-11-23", "2028-12-25",
]);
const EARLY_CLOSES = new Set(["2026-11-27", "2026-12-24", "2027-11-26", "2028-07-03", "2028-11-24"]);

// Input is a validated New York YYYY-MM-DD. Null means outside coverage.
export function equityCloseMinute(date) {
  if (date < FIRST || date > LAST) return null;
  const day = new Date(date + "T00:00:00Z").getUTCDay();
  if (day === 0 || day === 6 || HOLIDAYS.has(date)) return 0;
  return EARLY_CLOSES.has(date) ? 13 * 60 : 16 * 60;
}

export function matchesEquitySession(date, minutes, phase) {
  const close = equityCloseMinute(date);
  if (!close) return false;
  if (phase === "regular") return minutes >= EQUITY_OPEN_MINUTE && minutes <= close;
  // Close-window index observations may follow the equity close by 15 min.
  return phase === "close" && minutes >= close && minutes < close + 16;
}

export function previousEquitySession(date) {
  if (equityCloseMinute(date) === null) return null;
  const cursor = new Date(date + "T00:00:00Z");
  while (true) {
    cursor.setUTCDate(cursor.getUTCDate() - 1);
    const candidate = cursor.toISOString().slice(0, 10);
    const close = equityCloseMinute(candidate);
    if (close === null) return null;
    if (close > 0) return candidate;
  }
}
