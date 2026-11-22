import test from "node:test";
import assert from "node:assert/strict";
import { explainCoverage } from "./public/coverage-gaps.js";
import { INDICATOR_WEIGHTS, computeScores } from "./public/risk-model.js";

const all = () => Object.entries(INDICATOR_WEIGHTS).map(([id,weight]) => ({ id, weight, title:id, available:true, risk:0 }));
function missing(rows, id, reason, extras={}) { Object.assign(rows.find(row=>row.id===id), {available:false,risk:null,unavailableReason:reason},extras); }
function sample() {
  const rows = all();
  for (const [id, value, date] of [["inflation","+0.4% 环比","2026-10-01"],["fed","3.75%–4%","2026-11-21"],["unemployment","4.1%","2026-10-01"],["payrolls","165k","2026-10-01"]])
    missing(rows,id,"CPI 同比缺基期",{value,date,detail:id==="inflation"?"整体 CPI 同比缺少 2025-10 基期":""});
  missing(rows,"earningsBreadth","待接入",{value:"待接入"});
  return rows;
}
test("October CPI gap groups four different published readings, not four missing releases",()=>{
  const rows=sample(), gap=explainCoverage(rows);
  assert.equal(gap.covered,computeScores(rows).coverage);
  assert.deepEqual([gap.covered,gap.missing,gap.shortfall],[57,43,3]);
  assert.deepEqual(gap.groups.map(g=>[g.reason,g.weight]),[["CPI 同比缺基期",33],["待接入",10]]);
  assert.deepEqual(gap.groups[0].items[2].reading,{value:"4.1%",date:"2026-10-01"});
  assert.match(gap.groups[0].source,/bls.gov.+12m-changes-202610.htm$/);
  assert.equal(gap.groups[1].items[0].reading,null);
});
test("a recovered or explicitly reconfirmed zero is available weight; equality with the score threshold is not a shortfall",()=>{
  const rows=sample();
  Object.assign(rows.find(r=>r.id==="earningsBreadth"),{risk:0,available:true});
  assert.deepEqual([explainCoverage(rows).covered,explainCoverage(rows).shortfall,explainCoverage(rows).groups.length],[67,0,1]);
  const full=all(); assert.deepEqual(explainCoverage(full),{covered:100,missing:0,shortfall:0,threshold:60,groups:[]});
  for(const id of ["inflation","fed","rates","breadth"]) missing(full,id,"资料待补");
  assert.equal(computeScores(full).coverage,60);assert.equal(explainCoverage(full).shortfall,0);
});
test("another reference month or cause must never inherit the 2026 notice or the claim about the October base",()=>{
  for (const change of [{date:"2027-10-01"},{detail:"同比缺 2024-10 基期"},{unavailableReason:"官方新期待同步"}]) {
    const rows=sample();Object.assign(rows.find(r=>r.id==="inflation"),change);
    for(const g of explainCoverage(rows).groups) {assert.equal(g.source,undefined);assert.doesNotMatch(g.explanation??"",/2025 年 10 月/);}
  }
});
test("statuses and invalid dates do not become published observations; a recorded zero reading is kept",()=>{
  const rows=all();
  missing(rows,"fed","政策区间无效",{date:"2026-11-21",value:"政策区间无效"});
  missing(rows,"payrolls","资料待补",{date:"2026-02-31",value:"0k"});
  missing(rows,"breadth","资料待补",{date:"2026-10-01",value:"0"});
  const r=explainCoverage(rows).groups.flatMap(g=>g.items);
  assert.deepEqual(r.find(x=>x.id==="breadth").reading,{date:"2026-10-01",value:"0"});
  assert.equal(r.find(x=>x.id==="payrolls").reading,null);assert.equal(r.find(x=>x.id==="fed").reading,null);
});
