// One dated market review, not an automatically updated quotation feed.
const cboe = (symbol) => `https://www.cboe.com/us/indices/dashboard/${symbol.toLowerCase()}/`;
const nasdaq = (symbol) => `https://www.nasdaq.com/market-activity/etf/${symbol.toLowerCase()}`;

export const marketPulseReference = {
  mode: "reference",
  checkedAt: "2026-11-05T23:16:00.000Z",
  quotes: [
    ["SPX", 7353.73, -4.3557, "21:14:59.000", cboe("SPX")],
    ["RSP", 217.0799, -2.80, "21:00:00.000", nasdaq("RSP")],
    ["QQQ", 648.58, -6.27, "21:00:00.000", nasdaq("QQQ")],
    ["SMH", 446.29, -11.50, "21:00:00.000", nasdaq("SMH")],
    ["VIX", 28.18, 69.6568, "21:15:01.000", cboe("VIX")],
    ["VXSMH", 65.89, 43.8018, "21:02:02.681", cboe("VXSMH")],
  ].map(([symbol, value, changePercent, time, source]) => ({
    symbol, value, changePercent, source, date: "2026-11-05", at: `2026-11-05T${time}Z`, session: "close",
  })),
  errors: [],
};
