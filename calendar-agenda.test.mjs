import test from 'node:test';
import assert from 'node:assert/strict';
import {calendarAgenda} from './public/calendar-agenda.js';

const src = 'https://www.bls.gov/schedule/news_release/bls.ics';
const row=(indicatorId,date,eventAt=null,more={})=>({indicatorId,date,eventAt,source:src,label:indicatorId,event:'美国 11 月报告，08:30 ET', ...more});
const sync={sources:{bls:{mode:'bls-live',lastSuccessAt:'2026-11-20'},fomc:{mode:'fed-live',lastSuccessAt:'2026-11-20'}}};
const at=t=>Date.parse(t);
test('following confirmed report is combined and ordered across agencies; companies stay distinct',()=>{
  const job='2026-12-04T13:30:00Z', co={companies:[]};
  const a=calendarAgenda([row('inflation','2026-12-10'),co,row('unemployment','2026-12-04',job),row('fed','2026-12-09'),row('payrolls','2026-12-04',job)],sync,at('2026-11-22T02:00:00Z'));
  assert.deepEqual(a.macro.map(r=>r.indicatorId),['employment','fed','inflation']);
  assert.deepEqual(a.companies,[co]); const e=a.macro[0];
  assert.deepEqual([e.next,e.nyTime,e.beijing,e.relative,e.grade],[true,'08:30','2026-12-04 21:30','13 天后（纽约）','官方日程']);
  assert.match(e.source,/empsit.htm$/); assert.match(a.macro[2].source,/cpi.htm$/);
  assert.match(e.title,/非农就业人数、失业率/); assert.equal(a.nextBoundary,Date.parse(job));
});
test('New York time converts through daylight saving and a Beijing date rollover',()=>{
  const rows=[row('inflation','2026-07-14','2026-07-14T12:30:00Z'),row('fed','2026-07-29','2026-07-29T18:00:00Z')];
  assert.deepEqual(calendarAgenda(rows,sync,at('2026-06-30T00:00:00Z')).macro.map(r=>[r.nyTime,r.beijing]),[['08:30','2026-07-14 20:30'],['14:00','2026-07-30 02:00']]);
});
test('at a known release instant stop marking the report as upcoming; make no claim about publication',()=>{
  const rows=[row('inflation','2026-12-04','2026-12-04T13:30:00Z'),row('fed','2026-12-09')];
  const before=calendarAgenda(rows,sync,at('2026-12-04T13:29:59Z')), after=calendarAgenda(rows,sync,at('2026-12-04T13:30:00Z'));
  assert.equal(before.macro[0].next,true); assert.equal(before.macro[0].relative,'纽约今天');
  assert.deepEqual(after.macro.map(r=>[r.indicatorId,r.next,r.elapsed]),[['fed',true,false],['inflation',false,true]]);
  assert.equal(after.nextBoundary,Infinity);
});
test('date-only, timezone-less and wrong-day times yield no Beijing clock or legacy guessed ET clock',()=>{
  for(const stamp of [null,'2026-12-09T08:30:00','2026-12-10T14:00:00Z','bad']) {
    const r=calendarAgenda([row('fed','2026-12-09',stamp)],sync,at('2026-11-22T00:00:00Z')).macro[0];
    assert.equal(r.beijing,null); assert.equal(r.nyTime,null); assert.doesNotMatch(r.title,/08:30/);
  }
});
test('do not combine different dates, times or sources and do not revive past dates',()=>{
  for(const p of [row('payrolls','2026-12-05'),row('payrolls','2026-12-04','2026-12-04T13:30:00Z'),row('payrolls','2026-12-04',null,{source:'https://fred.stlouisfed.org/'})]){
    const {macro}=calendarAgenda([row('unemployment','2026-12-04'),p,row('fed','2026-11-01'),row('inflation','2026-11-31')],sync,at('2026-11-22T00:00:00Z'));
    assert.equal(macro.length,4); assert.equal(macro[2].date,null); assert.equal(macro[3].next,false);
  }
});
test('calendar provenance distinguishes reference, cached after failure, and FRED fallback',()=>{
  for(const [s,grade] of [[null,'参考日程 · 待核对'],[{mode:'built-in',lastSuccessAt:null},'参考日程 · 待核对'],[{mode:'fred-fallback',lastSuccessAt:'x'},'FRED 日历转引'],[{mode:'bls-live',lastSuccessAt:'x',error:'timeout'},'上次核对的日程']]) {
    assert.equal(calendarAgenda([row('inflation','2026-12-10')],{sources:{bls:s}},at('2026-11-22T00:00:00Z')).macro[0].grade,grade);
  }
});
