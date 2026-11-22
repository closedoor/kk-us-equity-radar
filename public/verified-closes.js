import {dailyCloseReferences, latestCompletedCloseDate} from "./market-pulse.js";

// A dated editorial observation, not a quotation feed. These are the CLOSE columns;
// the timestamp records our review, not an exchange quote time.
export const closeReview = Object.freeze({
  date: "2026-11-20", previousDate: "2026-11-19", checkedAt: "2026-11-22T03:22:46Z",
  readings: Object.freeze([
    {symbol:"VIX", value:35.89, previousValue:28.44},
    {symbol:"VXSMH", value:78.16, previousValue:59.65},
  ]),
});
export function verifiedCloses(dashboard, now=Date.now()) {
  const rows = dailyCloseReferences(dashboard, now).map(row=>({...row, basis:"model"}));
  const bySymbol = new Map(rows.map(row=>[row.symbol,row]));
  const stamp = now instanceof Date ? now.getTime() : typeof now === "string" ? Date.parse(now) : now;
  if (Number.isFinite(stamp) && stamp >= Date.parse(closeReview.checkedAt)) {
    for (const {symbol,value,previousValue} of closeReview.readings) {
      const model = bySymbol.get(symbol);
      if (model && model.date > closeReview.date) continue;
      const expectedDate = latestCompletedCloseDate(symbol,stamp);
      bySymbol.set(symbol,{symbol, value, date:closeReview.date, previousDate:closeReview.previousDate,
        changePercent:(value/previousValue-1)*100, expectedDate, isLatest:expectedDate===closeReview.date,
        basis:"review", source:"https://cdn-api.cboe.com/api/global/us_indices/daily_prices/"+symbol+"_History.csv",
        model: model && (model.date!==closeReview.date || model.value!==value) ? model : null});
    }
  }
  return ["VIX","VXSMH","SPX"].map(s=>bySymbol.get(s)).filter(Boolean);
}
