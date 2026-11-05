export const FRED_SERIES_IDS = Object.freeze([
  "DCOILBRENTEU", "CPIAUCSL", "CPIAUCNS", "CPILFESL", "CPILFENS", "PCEPI", "PCEPILFE",
  "DFEDTARL", "DFEDTARU", "DGS2", "DGS10", "DFII10", "T10Y3M", "VIXCLS", "SP500",
  "BAMLH0A0HYM2", "DRTSCILM", "SAHMREALTIME", "ICSA", "NFCI", "UNRATE", "PAYEMS",
]);

const SERIES = new Set(FRED_SERIES_IDS);
const MAX_POINTS = 400;
const MAX_REVISIONS = 100;
const object = (value) => value !== null && typeof value === "object" && !Array.isArray(value);
const emptyLedger = () => ({ version: 1, sources: {}, revisions: [] });
const nyClock = new Intl.DateTimeFormat("en-CA", { timeZone: "America/New_York", year: "numeric", month: "2-digit", day: "2-digit" });

function sourceDate(instant) {
  const parts = Object.fromEntries(nyClock.formatToParts(new Date(instant)).map(({ type, value }) => [type, value]));
  return `${parts.year}-${parts.month}-${parts.day}`;
}

function validDate(value) {
  return typeof value === "string" && /^\d{4}-(0[1-9]|1[0-2])-(0[1-9]|[12]\d|3[01])$/.test(value)
    && Number(value.slice(0, 4)) >= 1900 && Number.isFinite(Date.parse(value))
    && new Date(value).toISOString().slice(0, 10) === value;
}

function timestamp(value) {
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}T(?:[01]\d|2[0-3]):[0-5]\d:[0-5]\d(?:\.\d{1,3})?Z$/.test(value)
    || !validDate(value.slice(0, 10))) return null;
  const ms = Date.parse(value);
  return Number.isFinite(ms) ? { ms, iso: new Date(ms).toISOString() } : null;
}

function validLedger(value, nowMs) {
  if (!object(value) || value.version !== 1 || !object(value.sources) || !Array.isArray(value.revisions)
    || value.revisions.length > MAX_REVISIONS) return false;
  const checks = new Map();
  const observations = new Map();
  for (const [id, source] of Object.entries(value.sources)) {
    if (!SERIES.has(id) || !object(source) || !Array.isArray(source.points) || !source.points.length || source.points.length > MAX_POINTS) return false;
    const checked = timestamp(source.checkedAt);
    if (!checked || checked.iso !== source.checkedAt || checked.ms > nowMs) return false;
    const today = sourceDate(checked.ms);
    let previousDate = "";
    for (const point of source.points) {
      if (!object(point) || !validDate(point.date) || !Number.isFinite(point.value) || point.date > today || point.date <= previousDate) return false;
      previousDate = point.date;
    }
    checks.set(id, checked.ms);
    observations.set(id, new Map(source.points.map(({ date, value }) => [date, value])));
  }
  let previousTime = -Infinity;
  const events = new Set();
  const transitions = new Map();
  for (const revision of value.revisions) {
    if (!object(revision) || !SERIES.has(revision.series) || !checks.has(revision.series) || !validDate(revision.date)
      || !Number.isFinite(revision.before) || !Number.isFinite(revision.after) || revision.before === revision.after) return false;
    const detected = timestamp(revision.firstDetectedAt);
    if (!detected || detected.iso !== revision.firstDetectedAt || detected.ms > nowMs || detected.ms < previousTime
      || detected.ms > checks.get(revision.series) || revision.date > sourceDate(detected.ms)) return false;
    const key = JSON.stringify([revision.series, revision.date, revision.before, revision.after, revision.firstDetectedAt]);
    if (events.has(key)) return false;
    const observation = `${revision.series}|${revision.date}`;
    if (transitions.has(observation) && transitions.get(observation).after !== revision.before) return false;
    transitions.set(observation, revision);
    events.add(key);
    previousTime = detected.ms;
  }
  for (const { series, date, after } of transitions.values()) {
    const points = observations.get(series);
    if (points.has(date) && points.get(date) !== after) return false;
  }
  return true;
}

function cloneLedger(value) {
  return {
    version: 1,
    sources: Object.fromEntries(Object.entries(value.sources).map(([id, source]) => [id, {
      checkedAt: source.checkedAt, points: source.points.map(({ date, value }) => ({ date, value })),
    }])),
    revisions: value.revisions.map(({ series, date, before, after, firstDetectedAt }) => ({ series, date, before, after, firstDetectedAt })),
  };
}

export function isSourceLedger(value, nowMs = Date.now()) {
  return Number.isFinite(nowMs) && validLedger(value, nowMs);
}

// Disk input is all-or-nothing: a malformed or future record is not trusted history.
export function hydrateSourceLedger(saved, nowMs = Date.now()) {
  return isSourceLedger(saved, nowMs) ? cloneLedger(saved) : emptyLedger();
}

function candidatePoints(rows, today) {
  if (!Array.isArray(rows) || !rows.length) return null;
  const points = new Map();
  for (const point of rows) {
    if (!object(point) || !validDate(point.date) || !Number.isFinite(point.value) || point.date > today
      || (points.has(point.date) && points.get(point.date) !== point.value)) return null;
    points.set(point.date, point.value);
  }
  return [...points].sort(([left], [right]) => left.localeCompare(right));
}

// checkedAt is supplied by the caller's clock, never by an upstream observation.
// Previously hydrated memory stays intact when an out-of-order response arrives.
export function updateSourceLedger(previous, candidates, checkedAt) {
  const checked = timestamp(checkedAt);
  if (!checked) throw new Error("Invalid source revision check time");
  if (!object(candidates)) throw new Error("Source revision candidates must be a source map");
  const ledger = validLedger(previous, Infinity) ? cloneLedger(previous) : emptyLedger();
  const today = sourceDate(checked.ms);
  const latestEventTime = ledger.revisions.length ? Date.parse(ledger.revisions.at(-1).firstDetectedAt) : -Infinity;
  // A global clock rollback cannot insert an event before already-recorded history.
  if (checked.ms < latestEventTime) return { ledger, revisions: ledger.revisions };
  for (const id of FRED_SERIES_IDS) {
    if (!Object.hasOwn(candidates, id)) continue;
    const incoming = candidatePoints(candidates[id], today);
    if (!incoming) continue;
    const prior = ledger.sources[id];
    if (prior && checked.ms <= Date.parse(prior.checkedAt)) continue;
    const points = new Map((prior?.points || []).map(({ date, value }) => [date, value]));
    for (const [date, value] of incoming) {
      if (points.has(date) && points.get(date) !== value) {
        ledger.revisions.push({ series: id, date, before: points.get(date), after: value, firstDetectedAt: checked.iso });
      }
      points.set(date, value);
    }
    ledger.sources[id] = {
      checkedAt: checked.iso,
      points: [...points].sort(([left], [right]) => left.localeCompare(right)).slice(-MAX_POINTS).map(([date, value]) => ({ date, value })),
    };
  }
  ledger.revisions = ledger.revisions.slice(-MAX_REVISIONS);
  return { ledger, revisions: ledger.revisions };
}
