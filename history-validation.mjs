const finite = (value) => Number.isFinite(value);
const round = (value) => finite(value) ? Math.round(value * 1e6) / 1e6 : null;

export function validDay(value) {
  return typeof value === "string" && /^\d{4}-\d{2}-\d{2}$/.test(value)
    && finite(Date.parse(value)) && new Date(value).toISOString().slice(0, 10) === value;
}

export function quarterDates(firstYear = 2019, lastYear = 2025) {
  if (!Number.isInteger(firstYear) || !Number.isInteger(lastYear) || firstYear < 1900 || lastYear < firstYear || lastYear > 9998) throw new Error("Invalid evaluation years");
  return Array.from({ length: (lastYear - firstYear + 1) * 4 }, (_, index) => {
    const year = firstYear + Math.floor(index / 4);
    const month = (index % 4 + 1) * 3;
    return new Date(Date.UTC(year, month, 0)).toISOString().slice(0, 10);
  });
}

// The public graph endpoint can silently substitute a current vintage. A column
// is never accepted unless its exact requested series/date is in the header.
export function parseVintageCsv(text, id, vintages) {
  if (!/^[A-Z][A-Z0-9]*$/.test(id) || !Array.isArray(vintages) || !vintages.length
    || !vintages.every(validDay) || new Set(vintages).size !== vintages.length) throw new Error("Invalid vintage request");
  const lines = String(text).replace(/^\uFEFF/, "").trim().split(/\r?\n/);
  const expected = ["observation_date", ...vintages.map((date) => `${id}_${date.replaceAll("-", "")}`)];
  const header = lines.shift()?.split(",");
  if (JSON.stringify(header) !== JSON.stringify(expected)) throw new Error(`Vintage header mismatch for ${id}`);
  const columns = Object.fromEntries(vintages.map((date) => [date, new Map()]));
  for (const line of lines) {
    if (!line.trim()) continue;
    const values = line.split(",");
    if (values.length !== expected.length || !validDay(values[0])) throw new Error(`Malformed vintage row for ${id}`);
    for (let index = 0; index < vintages.length; index += 1) {
      const raw = values[index + 1].trim();
      if (!raw || raw === ".") continue;
      if (!/^[+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:e[+-]?\d+)?$/i.test(raw) || !finite(Number(raw))) throw new Error(`Invalid vintage value for ${id}`);
      const date = values[0];
      if (date > vintages[index]) throw new Error(`Future observation in ${id} vintage ${vintages[index]}`);
      const previous = columns[vintages[index]].get(date);
      if (previous !== undefined && previous !== Number(raw)) throw new Error(`Conflicting vintage observation for ${id}`);
      columns[vintages[index]].set(date, Number(raw));
    }
  }
  return Object.fromEntries(vintages.map((vintage) => [vintage,
    [...columns[vintage]].map(([date, value]) => ({ date, value })).sort((a, b) => a.date.localeCompare(b.date)),
  ]));
}

export function historyWindow(series, asOf, years) {
  if (!validDay(asOf) || !Number.isInteger(years) || years < 1) throw new Error("Invalid history window");
  const start = new Date(`${asOf}T12:00:00Z`);
  start.setUTCFullYear(start.getUTCFullYear() - years);
  const first = start.toISOString().slice(0, 10);
  return series.filter((row) => row.date >= first && row.date <= asOf);
}

export function forwardOutcome(prices, asOf, horizon) {
  if (!validDay(asOf) || !Number.isInteger(horizon) || horizon < 1) throw new Error("Invalid outcome request");
  for (let index = 0; index < prices.length; index += 1) {
    if (!validDay(prices[index].date) || !finite(prices[index].value) || prices[index].value <= 0
      || (index && prices[index - 1].date >= prices[index].date)) throw new Error("Outcome prices must be unique, ordered positive closes");
  }
  // Enter at the first available close strictly AFTER the vintage date. A value
  // loaded late on the vintage date cannot be used to trade that day's close.
  const entryIndex = prices.findIndex((row) => row.date > asOf);
  if (entryIndex < 0 || entryIndex + horizon >= prices.length) return null;
  const path = prices.slice(entryIndex, entryIndex + horizon + 1);
  const entry = path[0];
  const exit = path.at(-1);
  let peak = entry.value;
  let maxDrawdown = 0;
  let worstFromEntry = 0;
  for (const row of path) {
    peak = Math.max(peak, row.value);
    maxDrawdown = Math.min(maxDrawdown, (row.value / peak - 1) * 100);
    worstFromEntry = Math.min(worstFromEntry, (row.value / entry.value - 1) * 100);
  }
  return { horizon, entryDate: entry.date, exitDate: exit.date,
    returnPct: round((exit.value / entry.value - 1) * 100),
    maxDrawdownPct: round(maxDrawdown), worstFromEntryPct: round(worstFromEntry) };
}

export const HISTORY_BANDS = Object.freeze([
  { key: "low", label: "0–20", min: 0, max: 20 },
  { key: "normal", label: ">20–40", min: 20, max: 40 },
  { key: "watch", label: ">40–60", min: 40, max: 60 },
  { key: "high", label: ">60–75", min: 60, max: 75 },
  { key: "critical", label: ">75–100", min: 75, max: 100 },
]);

function summarizeOutcomes(values) {
  if (!values.length) return { n: 0, meanReturnPct: null, medianReturnPct: null, lossRatePct: null, meanMaxDrawdownPct: null, worstMaxDrawdownPct: null, drawdownAtLeast10PctRate: null };
  const returns = values.map((row) => row.returnPct).sort((a, b) => a - b);
  const mid = Math.floor(returns.length / 2);
  const median = returns.length % 2 ? returns[mid] : (returns[mid - 1] + returns[mid]) / 2;
  return { n: values.length,
    meanReturnPct: round(returns.reduce((sum, value) => sum + value, 0) / values.length), medianReturnPct: round(median),
    lossRatePct: round(100 * values.filter((row) => row.returnPct < 0).length / values.length),
    meanMaxDrawdownPct: round(values.reduce((sum, row) => sum + row.maxDrawdownPct, 0) / values.length),
    worstMaxDrawdownPct: Math.min(...values.map((row) => row.maxDrawdownPct)),
    drawdownAtLeast10PctRate: round(100 * values.filter((row) => row.maxDrawdownPct <= -10).length / values.length) };
}

export function summarizeHistory(rows, horizons = [21, 63]) {
  return horizons.map((horizon) => {
    const scheduled = rows.filter((row) => row.outcomes?.[horizon]);
    const scored = scheduled.filter((row) => finite(row.score));
    const overlappingWindows = scheduled.slice(1).filter((row, index) => row.outcomes[horizon].entryDate <= scheduled[index].outcomes[horizon].exitDate).length;
    return { horizon, scheduledCount: rows.length, matureCount: scheduled.length, scoredMatureCount: scored.length, overlappingAdjacentWindows: overlappingWindows,
      scheduledBaseline: summarizeOutcomes(scheduled.map((row) => row.outcomes[horizon])),
      scoredSampleBaseline: summarizeOutcomes(scored.map((row) => row.outcomes[horizon])),
      bands: HISTORY_BANDS.map((band, index) => ({ ...band,
        ...summarizeOutcomes(scored.filter((row) => row.score <= band.max && (index === 0 ? row.score >= 0 : row.score > band.min)).map((row) => row.outcomes[horizon])),
      })) };
  });
}

