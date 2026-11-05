const SOURCE_URLS = Object.freeze({
  cpi: "https://www.bls.gov/news.release/cpi.nr0.htm",
  employment: "https://www.bls.gov/news.release/empsit.nr0.htm",
});
const MONTHS = Object.freeze({
  january: 1, february: 2, march: 3, april: 4, may: 5, june: 6,
  july: 7, august: 8, september: 9, october: 10, november: 11, december: 12,
});
const WEEKDAYS = ["sunday", "monday", "tuesday", "wednesday", "thursday", "friday", "saturday"];
const newYorkClock = new Intl.DateTimeFormat("en-US", {
  timeZone: "America/New_York", hourCycle: "h23", year: "numeric", month: "2-digit", day: "2-digit",
  hour: "2-digit", minute: "2-digit", second: "2-digit",
});

function validPeriod(value) {
  const match = typeof value === "string" && value.match(/^(\d{4})-(0[1-9]|1[0-2])$/);
  return Boolean(match && Number(match[1]) >= 1900);
}

function utcDate(year, month, day, hour = 0, minute = 0, second = 0) {
  const result = new Date(Date.UTC(year, month - 1, day, hour, minute, second));
  return result.getUTCFullYear() === year && result.getUTCMonth() + 1 === month && result.getUTCDate() === day
    && result.getUTCHours() === hour && result.getUTCMinutes() === minute && result.getUTCSeconds() === second
    ? result.getTime() : null;
}

function isoTimestamp(value) {
  if (value instanceof Date) return Number.isFinite(value.getTime()) ? value.toISOString() : null;
  if (typeof value !== "string") return null;
  const match = value.match(/^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.(\d{1,3}))?Z$/);
  if (!match) return null;
  const [, year, month, day, hour, minute, second, fraction] = match;
  const instant = utcDate(Number(year), Number(month), Number(day), Number(hour), Number(minute), Number(second));
  return instant === null ? null : new Date(instant + Number((fraction || "").padEnd(3, "0"))).toISOString();
}

function releaseText(html) {
  return String(html || "")
    .replace(/<!--[\s\S]*?-->/g, " ")
    .replace(/<(script|style)\b[^>]*>[\s\S]*?<\/\1\s*>/gi, " ")
    .replace(/<[^>]*>/g, " ")
    .replace(/&nbsp;|&#160;|&#x0*a0;/gi, " ")
    .replace(/&ndash;|&#8211;|&#x2013;/gi, "–")
    .replace(/&mdash;|&#8212;|&#x2014;/gi, "—")
    .replace(/&amp;/gi, "&")
    .replace(/\s+/g, " ").trim();
}

function newYorkParts(instant) {
  return Object.fromEntries(newYorkClock.formatToParts(new Date(instant))
    .filter(({ type }) => type !== "literal").map(({ type, value }) => [type, Number(value)]));
}

function newYorkTimestamp(year, month, day, hour, minute, zone) {
  const nominal = utcDate(year, month, day, hour, minute);
  if (nominal === null) throw new Error("BLS release contains an invalid date or time");
  let instant = nominal;
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const parts = newYorkParts(instant);
    const local = utcDate(parts.year, parts.month, parts.day, parts.hour, parts.minute, parts.second);
    const difference = nominal - local;
    instant += difference;
    if (!difference) break;
  }
  const matches = (value) => {
    const parts = newYorkParts(value);
    return parts.year === year && parts.month === month && parts.day === day && parts.hour === hour && parts.minute === minute;
  };
  if (!matches(instant) || matches(instant - 3_600_000) || matches(instant + 3_600_000)) {
    throw new Error("BLS release contains an ambiguous or nonexistent Eastern time");
  }
  const offsetHours = (instant - nominal) / 3_600_000;
  if ((zone === "EST" && offsetHours !== 5) || (zone === "EDT" && offsetHours !== 4)) {
    throw new Error("BLS release timezone conflicts with America/New_York");
  }
  return new Date(instant).toISOString();
}

// Evidence is the report's own header and embargo time, never a scheduled date.
export function parseBlsPublication(html, kind, checkedAt) {
  if (!Object.hasOwn(SOURCE_URLS, kind)) throw new Error("Unknown BLS publication kind");
  const checked = isoTimestamp(checkedAt);
  if (!checked) throw new Error("Invalid publication verification time");
  const text = releaseText(html);
  const markers = [...text.matchAll(/Transmission\s+of\s+material\s+in\s+this\s+(?:news\s+)?release\s+is\s+embargoed\s+until/gi)];
  if (markers.length !== 1) throw new Error("BLS publication header is missing or ambiguous");
  const header = text.slice(markers[0].index + markers[0][0].length, markers[0].index + 3000);
  const titlePattern = kind === "cpi"
    ? /\bCONSUMER\s+PRICE\s+INDEX\s*[-–—]\s*([A-Za-z]+)\s+(\d{4})\b/gi
    : /\b(?:THE\s+)?EMPLOYMENT\s+SITUATION\s*[-–—]\s*([A-Za-z]+)\s+(\d{4})\b/gi;
  const titles = [...header.matchAll(titlePattern)];
  const periods = titles.map((match) => {
    const month = MONTHS[match[1].toLowerCase()];
    return month ? `${match[2]}-${String(month).padStart(2, "0")}` : null;
  });
  if (!periods.length || periods.some((period) => !validPeriod(period)) || new Set(periods).size !== 1) {
    throw new Error("BLS report period is missing, invalid, or conflicting");
  }
  const stamp = header.slice(0, 400).match(/\b(\d{1,2}):(\d{2})\s*([ap])\.?\s*m\.?\s*\((ET|EST|EDT)\)\s*(?:(Monday|Tuesday|Wednesday|Thursday|Friday|Saturday|Sunday)\s*,?\s*)?([A-Za-z]+)\s+(\d{1,2})\s*,\s*(\d{4})\b/i);
  if (!stamp) throw new Error("BLS embargo timestamp is missing or unsupported");
  const [, rawHour, rawMinute, meridiem, zone, weekday, monthName, rawDay, rawYear] = stamp;
  const hour12 = Number(rawHour);
  const minute = Number(rawMinute);
  const year = Number(rawYear);
  const month = MONTHS[monthName.toLowerCase()];
  const day = Number(rawDay);
  if (hour12 < 1 || hour12 > 12 || minute > 59 || year < 1900 || !month || utcDate(year, month, day) === null) {
    throw new Error("BLS release contains an invalid date or time");
  }
  if (weekday && WEEKDAYS[new Date(Date.UTC(year, month - 1, day)).getUTCDay()] !== weekday.toLowerCase()) {
    throw new Error("BLS release weekday conflicts with its date");
  }
  const hour = hour12 % 12 + (meridiem.toLowerCase() === "p" ? 12 : 0);
  const publishedAt = newYorkTimestamp(year, month, day, hour, minute, zone.toUpperCase());
  if (periods[0] > `${year}-${String(month).padStart(2, "0")}`) throw new Error("BLS report period is later than its publication month");
  if (Date.parse(publishedAt) > Date.parse(checked)) throw new Error("BLS release embargo has not passed");
  return { period: periods[0], publishedAt, checkedAt: checked, source: SOURCE_URLS[kind], error: null };
}

function object(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function hydratedRecord(record, kind, nowMs) {
  if (!object(record) || record.source !== SOURCE_URLS[kind] || !(record.error === null || typeof record.error === "string")) return null;
  const checkedAt = isoTimestamp(record.checkedAt);
  const attemptedAt = record.attemptedAt === undefined ? null : isoTimestamp(record.attemptedAt);
  if (!checkedAt || Date.parse(checkedAt) > nowMs || (record.attemptedAt !== undefined
    && (!attemptedAt || Date.parse(attemptedAt) > nowMs || Date.parse(attemptedAt) < Date.parse(checkedAt)))) return null;
  const attempt = attemptedAt ? { attemptedAt } : {};
  if (record.period === null && record.publishedAt === null && record.error) {
    return { period: null, publishedAt: null, checkedAt, source: SOURCE_URLS[kind], error: record.error.slice(0, 500), ...attempt };
  }
  const publishedAt = isoTimestamp(record.publishedAt);
  if (!validPeriod(record.period) || !publishedAt || Date.parse(publishedAt) > Date.parse(checkedAt)
    || record.period > publishedAt.slice(0, 7)) return null;
  return { period: record.period, publishedAt, checkedAt, source: SOURCE_URLS[kind], error: record.error?.slice(0, 500) || null, ...attempt };
}

function mergeRecord(previous, next) {
  if (!previous) return next;
  const previousAttempt = previous.attemptedAt || previous.checkedAt;
  const nextAttempt = next.attemptedAt || next.checkedAt;
  if (!previous.period && next.period && Date.parse(previousAttempt) > Date.parse(nextAttempt)) {
    return { ...next, attemptedAt: previousAttempt, error: previous.error };
  }
  if (previous.period && (!next.period || next.period < previous.period)) {
    if (Date.parse(nextAttempt) < Date.parse(previousAttempt)) return previous;
    return { ...previous, attemptedAt: nextAttempt, error: next.period
      ? `BLS report period moved backward from ${previous.period} to ${next.period}; retaining verified evidence`
      : next.error };
  }
  if (next.period === previous.period) {
    const newer = Date.parse(nextAttempt) >= Date.parse(previousAttempt) ? next : previous;
    const publishedAt = previous.publishedAt && next.publishedAt
      ? (previous.publishedAt < next.publishedAt ? previous.publishedAt : next.publishedAt) : newer.publishedAt;
    const checkedAt = previous.period && next.period
      ? (previous.checkedAt > next.checkedAt ? previous.checkedAt : next.checkedAt) : newer.checkedAt;
    return { ...newer, publishedAt, checkedAt };
  }
  return next;
}

export function createPublicationService({
  fetchText, now = () => new Date(), logger = console,
  cacheTtlMs = 15 * 60 * 1000, failureRetryMs = 5 * 60 * 1000,
}) {
  let state = { version: 1, sources: { cpi: null, employment: null } };
  let lastAttemptAt = null;
  let refreshPromise = null;
  const snapshot = () => JSON.parse(JSON.stringify(state));

  function hydrate(saved) {
    if (!object(saved) || saved.version !== 1 || !object(saved.sources)) return;
    const nowMs = now().getTime();
    for (const kind of Object.keys(SOURCE_URLS)) {
      const record = hydratedRecord(saved.sources[kind], kind, nowMs);
      if (record) state.sources[kind] = mergeRecord(state.sources[kind], record);
    }
  }

  async function runRefresh() {
    await Promise.all(Object.entries(SOURCE_URLS).map(async ([kind, source]) => {
      try {
        const html = await fetchText(source, { accept: "text/html,text/plain,*/*" });
        const record = parseBlsPublication(html, kind, now());
        state.sources[kind] = mergeRecord(state.sources[kind], record);
      } catch (error) {
        const message = String(error?.message || error || "BLS publication verification failed").slice(0, 500);
        logger.warn?.(`[publication] ${kind}: ${message}`);
        state.sources[kind] = mergeRecord(state.sources[kind], {
          period: null, publishedAt: null, checkedAt: now().toISOString(), source, error: message,
        });
      }
    }));
    return snapshot();
  }

  function refresh({ force = false } = {}) {
    if (refreshPromise) return refreshPromise;
    const timestamp = now().getTime();
    const hasErrors = Object.values(state.sources).some((source) => source?.error);
    const interval = hasErrors ? Math.min(cacheTtlMs, failureRetryMs) : cacheTtlMs;
    if (!force && lastAttemptAt !== null && timestamp >= lastAttemptAt && timestamp - lastAttemptAt < interval) {
      return Promise.resolve(snapshot());
    }
    lastAttemptAt = timestamp;
    refreshPromise = runRefresh().finally(() => { refreshPromise = null; });
    return refreshPromise;
  }

  return { refresh, hydrate, snapshot };
}
