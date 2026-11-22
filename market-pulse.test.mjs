import test from "node:test";
import assert from "node:assert/strict";
import { isMarketPulseSnapshot, projectMarketPulse, MARKET_PULSE_THRESHOLDS } from "./public/market-pulse.js";

const source = "https://www.cboe.com/";
const now = "2026-11-05T23:16:00.000Z";
const quote = (symbol, changePercent, options = {}) => ({ symbol, value: 100, date: "2026-11-05", at: "2026-11-05T21:00:00.000Z",
  session: "close", changePercent, source, ...options });
const snapshot = (quotes, options = {}) => ({ quotes, checkedAt: "2026-11-05T23:15:46.000Z", errors: [], ...options });
const frame = (spx, rsp) => snapshot([quote("SPX", spx), quote("RSP", rsp)]);

test("the observed Nov 5 close recognizes broad and sector stress separately without a score", () => {
  const data = snapshot([
    quote("SPX", -4.3557, { value: 7353.73, at: "2026-11-05T21:14:59.000Z" }),
    quote("RSP", -2.8, { value: 217.0799 }),
    quote("SMH", -11.5, { value: 446.29 }),
    quote("QQQ", -6.27, { value: 648.58 }),
    quote("VIX", 69.6568, { value: 28.18, at: "2026-11-05T21:15:01.000Z" }),
    quote("VXSMH", null, { value: 65.89, at: "2026-11-05T21:02:02.681Z" }),
  ], { mode: "reference" });
  const original = structuredClone(data);
  assert.equal(isMarketPulseSnapshot(data), true);
  const view = projectMarketPulse(data, now);
  assert.equal(view.status, "current");
  assert.equal(view.mode, "reference");
  assert.equal(view.date, "2026-11-05");
  assert.equal(view.session, "close");
  assert.equal(view.broad.level, "severe");
  assert.equal(view.sector.level, "severe");
  assert.deepEqual(view.sector.flags.map(({ symbol }) => symbol), ["SMH", "QQQ", "VXSMH"]);
  assert.equal(view.volatility.level, "elevated");
  assert.match(view.ruleNote, /经验阈值.*未经回测校准/);
  assert.equal(Object.hasOwn(view, "score"), false);
  assert.deepEqual(data, original);
});

test("broad thresholds are inclusive and both market measures must meet them", () => {
  const { broadSevere, broadPressure } = MARKET_PULSE_THRESHOLDS;
  assert.equal(projectMarketPulse(frame(broadSevere.SPX, broadSevere.RSP), now).broad.level, "severe");
  assert.equal(projectMarketPulse(frame(broadPressure.SPX, broadPressure.RSP), now).broad.level, "pressure");
  assert.equal(projectMarketPulse(frame(-4.1, -1.99), now).broad.level, "pressure");
  const narrow = projectMarketPulse(frame(-4.1, -0.8), now).broad;
  assert.equal(narrow.level, "none");
  assert.match(narrow.label, /未确认广泛扩散/);
  assert.equal(projectMarketPulse(frame(-0.9, -3.1), now).broad.level, "none");
});

test("semiconductor and volatility shocks cannot become a broad alert by themselves", () => {
  const view = projectMarketPulse(snapshot([quote("SMH", -11.5), quote("QQQ", -6.27), quote("VXSMH", null, { value: 65.89 }), quote("VIX", 70, { value: 30 })]), now);
  assert.equal(view.broad.level, "unconfirmed");
  assert.equal(view.sector.level, "severe");
  assert.equal(view.volatility.level, "elevated");
  const withoutRsp = projectMarketPulse(snapshot([quote("SPX", -4.2), quote("RSP", null), quote("SMH", -11.5)]), now);
  assert.equal(withoutRsp.broad.level, "unconfirmed");
  assert.match(withoutRsp.broad.label, /扩散待确认/);
});

test("close comparisons require the same NY date and timestamps within 15 minutes", () => {
  const rsp = quote("RSP", -2.8);
  const pair = (time) => snapshot([quote("SPX", -4.2, { at: `2026-11-05T${time}Z` }), rsp]);
  assert.equal(projectMarketPulse(pair("21:15:00"), now).broad.level, "severe");
  assert.equal(projectMarketPulse(pair("21:15:01"), now).broad.level, "unconfirmed");
  const prior = quote("RSP", -3, { date: "2026-11-04", at: "2026-11-04T21:00:00Z" });
  const mixed = projectMarketPulse(snapshot([quote("SPX", -4.2), prior]), now);
  assert.equal(mixed.broad.level, "unconfirmed");
  assert.equal(mixed.quotes.find((row) => row.symbol === "RSP").state, "stale");
});

test("regular quotes have both a 45 minute age limit and 30 minute pairing limit", () => {
  const at = "2026-11-05T20:45:00Z";
  const regular = (symbol, changePercent, clock) => quote(symbol, changePercent, { session: "regular", at: `2026-11-05T${clock}Z` });
  const input = (spxTime) => snapshot([regular("SPX", -4, spxTime), regular("RSP", -3, "20:00:00")], { mode: "feed", checkedAt: at });
  assert.equal(projectMarketPulse(input("20:30:00"), at).broad.level, "severe");
  assert.equal(projectMarketPulse(input("20:30:01"), at).broad.level, "unconfirmed");
  const expired = projectMarketPulse(input("20:30:00"), "2026-11-05T20:45:01Z");
  assert.equal(expired.broad.level, "unconfirmed");
  assert.equal(expired.quotes.find((row) => row.symbol === "RSP").state, "stale");
});

test("a confirmed early close cannot be compared with a still-cached regular-session quote", () => {
  const at = "2026-11-27T18:05:00Z";
  const day = "2026-11-27";
  const data = snapshot([
    quote("SPX", -4.2, { date: day, at: "2026-11-27T17:58:00Z", session: "regular" }),
    quote("RSP", -2.8, { date: day, at: "2026-11-27T18:00:00Z" }),
  ], { checkedAt: at });
  const view = projectMarketPulse(data, at);
  assert.equal(view.status, "current");
  assert.equal(view.session, "close");
  assert.equal(view.broad.level, "unconfirmed");
  assert.equal(view.quotes[0].state, "stale");
});

test("a mislabeled midafternoon close is not a confirmed early or standard close", () => {
  const at = "2026-11-05T19:32:00Z";
  const data = snapshot([quote("SPX", -4.2, { at: "2026-11-05T19:30:00Z" }), quote("RSP", -2.8, { at: "2026-11-05T19:30:00Z" })], { checkedAt: at });
  const view = projectMarketPulse(data, at);
  assert.equal(view.status, "unavailable");
  assert.equal(view.broad.level, "unconfirmed");
  assert.ok(view.quotes.every((row) => row.state === "unconfirmed"));
});

test("Friday close is a dated reference through the weekend and Monday pre-open, not an active intraday alert", () => {
  const day = "2026-11-06";
  const data = snapshot([quote("SPX", -4.2, { date: day, at: `${day}T21:00:00Z` }), quote("RSP", -2.8, { date: day, at: `${day}T21:00:00Z` })],
    { checkedAt: `${day}T21:16:00Z`, mode: "reference" });
  assert.equal(projectMarketPulse(data, "2026-11-07T02:00:00Z").status, "current", "UTC Saturday is still Friday in New York");
  for (const time of ["2026-11-07T17:00:00Z", "2026-11-08T17:00:00Z", "2026-11-09T14:29:59Z"]) {
    const view = projectMarketPulse(data, time);
    assert.equal(view.status, "last-close");
    assert.equal(view.broad.level, "severe");
    assert.match(view.label, /非当前盘中/);
    assert.match(view.broad.label, /^上次收盘/);
  }
  const monday = projectMarketPulse(data, "2026-11-09T14:30:00Z");
  assert.equal(monday.status, "stale");
  assert.equal(monday.broad.level, "unconfirmed");
  assert.match(monday.label, /历史参考.*缺数/);
});

test("after the regular session, a final intraday tick is not promoted to a confirmed close", () => {
  const at = "2026-11-05T21:02:00Z";
  const data = snapshot([quote("SPX", -4.2, { session: "regular", at: "2026-11-05T20:59:00Z" }), quote("RSP", -2.8, { session: "regular", at: "2026-11-05T20:59:00Z" })], { checkedAt: at });
  const view = projectMarketPulse(data, at);
  assert.equal(view.status, "stale");
  assert.equal(view.broad.level, "unconfirmed");
});

test("an editorial reference cannot masquerade as an intraday feed", () => {
  const at = "2026-11-05T20:45:00Z";
  const data = snapshot([quote("SPX", -4.2, { session: "regular", at: "2026-11-05T20:44:00Z" }), quote("RSP", -2.8, { session: "regular", at: "2026-11-05T20:44:00Z" })], { checkedAt: at });
  assert.equal(projectMarketPulse({ ...data, mode: "feed" }, at).broad.level, "severe");
  assert.equal(projectMarketPulse({ ...data, mode: "reference" }, at).broad.level, "unconfirmed");
  assert.equal(projectMarketPulse({ ...data, mode: "reference" }, at).status, "stale");
});

test("future, weekend and unconfirmed quotes cannot trigger market conditions", () => {
  const future = projectMarketPulse(snapshot([quote("SPX", -4.2), quote("RSP", -2.8)]), "2026-11-05T23:15:00Z");
  assert.equal(future.status, "unavailable");
  assert.match(future.errors.join(), /未来/);
  const beforeClose = projectMarketPulse(snapshot([quote("SPX", -4.2), quote("RSP", -2.8)], { checkedAt: "2026-11-05T20:59:00Z" }), "2026-11-05T20:59:59Z");
  assert.equal(beforeClose.broad.level, "unconfirmed");
  assert.ok(beforeClose.quotes.every((row) => row.state === "unconfirmed"));
  const saturday = quote("SPX", -4.2, { date: "2026-11-07", at: "2026-11-07T21:00:00Z" });
  const weekend = projectMarketPulse(snapshot([saturday], { checkedAt: "2026-11-07T21:01:00Z" }), "2026-11-07T21:02:00Z");
  assert.equal(weekend.status, "unavailable");
});

test("warming and missing volatility inputs remain distinguishable from a complete below-threshold reading", () => {
  const warm = { quotes: [], errors: [], checkedAt: null, mode: "feed" };
  assert.equal(isMarketPulseSnapshot(warm), true);
  assert.equal(projectMarketPulse(warm, now).status, "unavailable");
  assert.equal(projectMarketPulse(warm, now).broad.level, "unconfirmed");
  const noVxsmhChange = projectMarketPulse(snapshot([quote("SMH", 0), quote("QQQ", 0), quote("VXSMH", null, { value: 36 })]), now);
  assert.equal(noVxsmhChange.sector.level, "unconfirmed");
  assert.equal(noVxsmhChange.volatility.level, "unconfirmed");
  const complete = projectMarketPulse(snapshot([quote("SMH", 0), quote("QQQ", 0), quote("VXSMH", null, { value: 30 }), quote("VIX", 0, { value: 18 })]), now);
  assert.equal(complete.sector.level, "none");
  assert.equal(complete.volatility.level, "none");
});

test("the payload guard rejects unknown symbols, duplicate rows, unsafe URLs and inconsistent dates", () => {
  const original = quote("SPX", -4.2);
  const bad = [
    snapshot([quote("XYZ", -4.2)]), snapshot([original, original]), snapshot([original], { mode: "unknown" }),
    snapshot([{ ...original, source: "javascript:alert(1)" }]), snapshot([{ ...original, source: "https://user:pass@www.cboe.com/" }]),
    snapshot([{ ...original, date: "2026-11-04" }]), snapshot([{ ...original, date: "2026-02-31", at: "2026-02-31T21:00:00Z" }]),
    snapshot([{ ...original, at: "2026-11-05 16:00:00" }]), snapshot([{ ...original, session: "after-hours" }]),
    snapshot([{ ...original, changePercent: "-4.2%" }]), snapshot([{ ...original, changePercent: -100 }]),
    snapshot([{ ...original, value: null }]), snapshot([original], { checkedAt: null }), snapshot([original], { errors: [null] }),
  ];
  assert.ok(bad.every((value) => !isMarketPulseSnapshot(value)));
  for (const invalid of bad) assert.equal(projectMarketPulse(invalid, now).status, "unavailable");
  const unknown = snapshot([quote("SPX", null, { value: null, date: null, at: null, session: "unconfirmed" })]);
  assert.equal(isMarketPulseSnapshot(unknown), true);
  assert.equal(projectMarketPulse(unknown, now).quotes[0].state, "unconfirmed");
});

const datedPair = (date, time, session, checkedAt) => snapshot(["SPX", "RSP"].map((s) =>
  quote(s, -4, { date, session, at: date + "T" + time + "Z" })), { mode: "feed", checkedAt });

test("Thanksgiving closure preserves the preceding close until the next session and rejects holiday prints", () => {
  const wed = datedPair("2026-11-25", "21:00:00", "close", "2026-11-25T21:17:00Z");
  const holiday = "2026-11-26T18:03:00Z";
  const view = projectMarketPulse(wed, holiday);
  assert.equal(view.status, "last-close");
  assert.match(view.broad.label, /^上次收盘/);
  assert.equal(projectMarketPulse(wed, "2026-11-27T14:29:59Z").status, "last-close");
  assert.equal(projectMarketPulse(wed, "2026-11-27T14:30:00Z").status, "stale");
  const fabricated = datedPair("2026-11-26", "18:00:00", "regular", holiday);
  assert.equal(projectMarketPulse(fabricated, holiday).broad.level, "unconfirmed");
});

test("only scheduled half days may close at 13:00, and the session ends without needing a provider close", () => {
  const normal = "2026-11-25T18:09:00Z", half = "2026-11-27T18:09:00Z";
  assert.equal(projectMarketPulse(datedPair("2026-11-25", "18:00:00", "close", normal), normal).broad.level, "unconfirmed");
  assert.equal(projectMarketPulse(datedPair("2026-11-27", "18:00:00", "close", half), half).broad.level, "severe");
  assert.equal(projectMarketPulse(datedPair("2026-11-27", "17:58:00", "regular", half), half).broad.level, "unconfirmed");
  const later = "2026-11-27T21:19:00Z";
  assert.equal(projectMarketPulse(datedPair("2026-11-27", "21:00:00", "close", later), later).broad.level, "unconfirmed");
});

test("observations later than the collection instant do not turn current as the browser clock advances", () => {
  const checked = "2026-11-05T20:59:00Z";
  const data = datedPair("2026-11-05", "21:00:00", "close", checked);
  const view = projectMarketPulse(data, "2026-11-05T21:10:00Z");
  assert.equal(view.broad.level, "unconfirmed");
  assert.ok(view.quotes.every(row => row.state === "unconfirmed"));
});

test("valid independent sector evidence is not hidden by a later unrelated broad-index timestamp or row order", () => {
  const checkedAt = "2026-11-05T20:50:00Z";
  const intraday = (symbol, time, move) => quote(symbol, move, { session: "regular", at: "2026-11-05T" + time + "Z" });
  const rsp = intraday("RSP", "20:50:00", 0), smh = intraday("SMH", "20:10:00", -6.6);
  const qq = intraday("QQQ", "20:48:00", 0);
  for (const rows of [[rsp, smh, qq], [qq, smh, rsp], [smh, qq]]) {
    const view = projectMarketPulse(snapshot(rows, { checkedAt }), checkedAt);
    assert.equal(view.broad.level, "unconfirmed");
    assert.deepEqual(view.sector.flags.map(f => f.symbol), ["SMH"]);
    assert.equal(view.sector.level, "severe");
  }
  const allCalm = [intraday("SMH", "20:10:00", 0), qq, { ...intraday("VXSMH", "20:45:00", 0), value: 30 }];
  assert.equal(projectMarketPulse(snapshot(allCalm, { checkedAt }), checkedAt).sector.level, "unconfirmed",
    "widely separated non-alerts cannot be presented as a simultaneous three-leg observation");
});

test("the published calendar covers later-year boundaries without assuming all federal holidays or unverified weekdays", () => {
  const sessionAt = (day, time, phase = "close") => {
    const clock = day + "T23:00:00Z";
    return projectMarketPulse(datedPair(day, time, phase, clock), clock);
  };
  assert.equal(sessionAt("2027-12-31", "21:00:00").broad.level, "severe", "no Friday observance for New Year's Day 2028");
  assert.equal(sessionAt("2028-07-03", "17:00:00").broad.level, "severe", "scheduled early close in daylight time");
  assert.equal(sessionAt("2028-07-04", "20:00:00").broad.level, "unconfirmed");
  assert.equal(sessionAt("2029-01-03", "21:00:00").broad.level, "unconfirmed");
  assert.match(sessionAt("2029-01-03", "21:00:00").errors.join(), /日历未覆盖/);
});

import { dailyCloseReferences, latestCompletedCloseDate } from "./public/market-pulse.js";

function dailyBoard(vixDate = "2026-11-19", spDate = vixDate, generatedAt = "2026-11-22T02:00:00Z") {
  return { generatedAt, indicators: [
    { id: "vix", date: vixDate, value: "28.44", sparkline: [{ date: "2026-11-18", value: 24.56 }, { date: vixDate, value: 28.44 }],
      source: {url: "https://www.cboe.com/tradable_products/vix/"} },
    { id: "sp500", date: spDate, value: "-8.2%", sparkline: [{ date: "2026-11-18", value: 7323.63 }, { date: spDate, value: 7175.83 }],
      source: {url: "https://fred.stlouisfed.org/series/SP500"} },
  ], validationReference: { series: "SP500", date: spDate, close: 7175.83 } };
}
test("daily references show verified VIX and SPX with their own dates, isolated from any intraday assessment", () => {
  const d = dailyBoard(), at = "2026-11-22T03:00:00Z", copy = structuredClone(d);
  const rows = dailyCloseReferences(d, at);
  assert.deepEqual(rows.map(r=>[r.symbol,r.value,r.date,r.previousDate,r.expectedDate,r.isLatest,r.source]), [
    ["VIX",28.44,"2026-11-19","2026-11-18","2026-11-20",false,"https://fred.stlouisfed.org/series/VIXCLS"],
    ["SPX",7175.83,"2026-11-19","2026-11-18","2026-11-20",false,"https://fred.stlouisfed.org/series/SP500"],
  ]);
  assert.equal(rows[0].changePercent.toFixed(2),"15.80"); assert.equal(rows[1].changePercent.toFixed(2),"-2.02");
  assert.deepEqual(d,copy);
  const differing=dailyCloseReferences(dailyBoard("2026-11-19","2026-11-20"),at);
  assert.deepEqual(differing.map(r=>r.isLatest),[false,true]);
  assert.equal(differing[1].previousDate,null); assert.equal(differing[1].changePercent,null);
  const old = dailyCloseReferences(d,"2026-12-01T19:00:00Z"); assert.equal(old[0].date,"2026-11-19");assert.equal(old[0].isLatest,false);
  assert.equal(dailyCloseReferences(null,at).length,0);
});
test("a dated daily close must already have existed when the snapshot was made, including early closes and VIX delay",()=>{
  for(const [check,counted] of [["2026-11-27T17:59:59Z",[]],["2026-11-27T18:00:00Z",["SPX"]],["2026-11-27T18:14:59Z",["SPX"]],["2026-11-27T18:15:00Z",["VIX","SPX"]]]) {
    const d=dailyBoard("2026-11-27","2026-11-27",check);
    assert.deepEqual(dailyCloseReferences(d,"2026-11-28T17:00:00Z").map(x=>x.symbol),counted);
  }
  const d=dailyBoard("2026-11-25","2026-11-25","2026-11-25T22:00:00Z");
  assert.ok(dailyCloseReferences(d,"2026-11-26T22:00:00Z").every(x=>x.expectedDate==="2026-11-25" && x.isLatest));
  assert.ok(dailyCloseReferences(d,"2026-11-27T18:02:00Z").find(x=>x.symbol==="VIX").isLatest);
  assert.equal(dailyCloseReferences(d,"2026-11-27T18:02:00Z").find(x=>x.symbol==="SPX").isLatest,false);
  const unknown=dailyCloseReferences(d,"2029-01-03T12:00:00Z");assert.equal(unknown.length,2);assert.ok(unknown.every(x=>x.expectedDate===null&&!x.isLatest));
  for(const day of ["2026-11-26","2026-11-28","2029-01-03"]) assert.deepEqual(dailyCloseReferences(dailyBoard(day,day,day+"T22:00:00Z"),day+"T23:00:00Z"),[]);
});
test("bad identities, contradictory levels, ambiguous observations and future snapshots cannot become daily reference prices",()=>{
  const at="2026-11-22T03:00:00Z";
  for(const damage of [
    d=>d.validationReference.series="VIXCLS", d=>d.validationReference.close+=1, d=>d.validationReference.date="2026-11-20",
    d=>d.indicators[1].source.url="https://fred.stlouisfed.org/series/VIXCLS",
    d=>d.indicators[1].sparkline.push({date:"2026-11-19",value:7150}), d=>d.indicators[1].sparkline.reverse(),
    d=>d.indicators[1].sparkline[1].value=0, d=>d.indicators[1].date="2026-11-20", d=>d.indicators.push(structuredClone(d.indicators[1]))
  ]){const d=dailyBoard();damage(d);assert.deepEqual(dailyCloseReferences(d,at).map(x=>x.symbol),["VIX"]);}
  const issue=dailyBoard();issue.indicators[0].value="";assert.deepEqual(dailyCloseReferences(issue,at).map(x=>x.symbol),["SPX"]);
  for(const stamp of ["bad","2026-11-22T04:00:00Z","2026-11-22T03:00:00"]) assert.deepEqual(dailyCloseReferences({...dailyBoard(),generatedAt:stamp},at),[]);
});

test("VIX and VXSMH use separate settlement windows; being past the window alone supplies no price", () => {
  const rightAfterClose = "2026-11-20T21:00:00Z", summer = "2026-07-07T20:14:59Z";
  assert.equal(latestCompletedCloseDate("VXSMH", rightAfterClose), "2026-11-20");
  assert.equal(latestCompletedCloseDate("VIX", rightAfterClose), "2026-11-19");
  assert.equal(latestCompletedCloseDate("VXSMH", summer), "2026-07-07");
  assert.equal(latestCompletedCloseDate("VIX", summer), "2026-07-06");
  assert.equal(latestCompletedCloseDate("VIX", "2026-07-07T20:15:00Z"), "2026-07-07");
  for(const [symbol,clock] of [["OTHER",summer],["VIX","junk"],["VIX","2029-01-01T12:00:00Z"],["VIX",Infinity]]) assert.equal(latestCompletedCloseDate(symbol,clock),null);
});
test("a missing or rejected quote cannot redate a historical reference in the market summary", () => {
  const holiday = quote("VXSMH", null, {value:65.89, date:"2026-11-07", at:"2026-11-07T16:00:00Z"});
  const unknown = quote("VIX",null,{value:null,date:"2026-11-08",at:null,session:"unconfirmed"});
  const historical = quote("SPX",-4.2), checkedAt="2026-11-09T18:00:00Z";
  for(const quotes of [[holiday, historical, unknown],[unknown, historical, holiday]]) {
    const view=projectMarketPulse(snapshot(quotes,{mode:"reference",checkedAt}),checkedAt);
    assert.equal(view.status,"stale"); assert.equal(view.date,historical.date);
    assert.deepEqual(view.quotes.filter(r=>r.state==="stale").map(r=>r.symbol),["SPX"]);
  }
  assert.equal(projectMarketPulse(snapshot([holiday,unknown],{mode:"reference",checkedAt}),checkedAt).date,null);
});
