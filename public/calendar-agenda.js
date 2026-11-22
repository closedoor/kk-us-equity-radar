// Dates and explicit instants are different evidence. Do not invent a release time from a calendar date.
const formatter = zone => new Intl.DateTimeFormat("en-GB", { timeZone: zone, year: "numeric", month: "2-digit", day: "2-digit", hour:"2-digit", minute:"2-digit", hourCycle:"h23" });
const ny = formatter("America/New_York"), bj = formatter("Asia/Shanghai");
function parts(format, ms) {
  const p = Object.fromEntries(format.formatToParts(new Date(ms)).map(x => [x.type,x.value]));
  return { day: p.year + "-" + p.month + "-" + p.day, clock: p.hour + ":" + p.minute };
}
const isDay = value => typeof value === "string" && /^\d{4}-\d{2}-\d{2}$/.test(value) && Number.isFinite(Date.parse(value)) && new Date(value).toISOString().slice(0,10)===value;
function confirmedTime(row) {
  if (typeof row.eventAt !== "string" || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2}(\.\d{1,3})?)?(Z|[+-]\d{2}:\d{2})$/.test(row.eventAt)) return null;
  const n=Date.parse(row.eventAt);
  return Number.isFinite(n) && parts(ny,n).day === row.date ? n : null;
}
function readableSource(row) {
  try {
    const u=new URL(row.source);
    if (u.origin === "https://www.bls.gov" && u.pathname === "/schedule/news_release/bls.ics") {
      return new URL(row.indicatorId === "inflation" ? "cpi.htm" : "empsit.htm",u).href;
    }
  } catch {}
  return row.source;
}
export function calendarAgenda(rows = [], sync, now = Date.now()) {
  const today=parts(ny,now).day, macro=[], companies=[];
  for(const row of rows) {
    if(Array.isArray(row.companies)) { companies.push(row); continue; }
    if(!["inflation","fed","unemployment","payrolls"].includes(row.indicatorId)) continue;
    const date=isDay(row.date) && row.date>=today ? row.date:null;
    const stamp=date ? confirmedTime(row):null;
    const zone=stamp===null?null:parts(bj,stamp);
    const elapsed=stamp!==null && stamp<=now;
    const meta=sync?.sources?.[row.indicatorId==="fed"?"fomc":"bls"];
    const grade=!meta || meta.mode==="built-in" || !meta.lastSuccessAt ? "参考日程 · 待核对" : meta.error ? "上次核对的日程" : meta.mode==="fred-fallback" ? "FRED 日历转引" : "官方日程";
    const title=(row.event || "").replace(/[，,、·\s]*\d{1,2}:\d{2}\s*ET\b/g,"").trim();
    macro.push({...row, date, stamp, elapsed, grade, source:readableSource(row), title,
      nyTime:stamp===null?null:parts(ny,stamp).clock, beijing:zone ? zone.day+" "+zone.clock:null});
  }
  const u=macro.find(r=>r.indicatorId==="unemployment"), p=macro.find(r=>r.indicatorId==="payrolls");
  if(u && p && u.date===p.date && u.stamp===p.stamp && u.source===p.source) {
    u.indicatorId="employment";u.label="美国就业报告";u.title=u.date ? (u.title.match(/(?:\d{4}\s*年\s*)?\d+\s*月/)?.[0] || "")+"就业报告：非农就业人数、失业率"+(u.title.includes("统计期待核对")?"（统计期待核对）":"") : "非农就业人数、失业率：下期日程待核对";
    macro.splice(macro.indexOf(p),1);
  }
  const order=r=>!r.date?2:r.elapsed?1:0;
  macro.sort((a,b)=>order(a)-order(b)||(a.date||"").localeCompare(b.date||"")||(a.stamp??Infinity)-(b.stamp??Infinity));
  const first=macro.find(r=>r.date&&!r.elapsed);
  for(const r of macro) {
    r.next=Boolean(first && r.date===first.date && !r.elapsed && (r.stamp===null || first.stamp===null || r.stamp===first.stamp));
    const days=r.date?(Date.parse(r.date)-Date.parse(today))/86400000:null;
    r.relative=days===null?"":r.elapsed?"计划时刻已到":days===0?"纽约今天":days+" 天后（纽约）";
  }
  const upcoming=macro.map(r=>r.stamp).filter(n=>n!==null&&n>now);
  return {macro,companies,nextBoundary:upcoming.length?Math.min(...upcoming):Infinity};
}
