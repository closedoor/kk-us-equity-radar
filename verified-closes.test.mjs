import test from 'node:test';
import assert from 'node:assert/strict';
import {verifiedCloses} from './public/verified-closes.js';
const date='2026-11-19';
function dash(day=date,value=28.44, generatedAt='2026-11-22T02:00:00Z') {
  return {generatedAt, indicators:[{id:'vix',source:{url:'https://www.cboe.com/tradable_products/vix/'},date:day,value:String(value),sparkline:[{date:day,value}]}]};
}
test('editorial closes are observable only after review, distinguish a dated model value and have independent source URLs',()=>{
  assert.deepEqual(verifiedCloses(null,'2026-11-22T03:22:45Z'),[]);
  const rows=verifiedCloses(dash(),'2026-11-22T03:22:46Z');const [v,semi]=rows;
  assert.deepEqual([v.value,v.date,v.isLatest,v.changePercent.toFixed(2),v.model.value,v.model.date],[35.89,'2026-11-20',true,'26.20',28.44,date]);
  assert.deepEqual([semi.symbol,semi.value,semi.changePercent.toFixed(2),semi.basis,semi.model],['VXSMH',78.16,'31.03','review',null]);
  assert.ok(rows.every(row=>row.source.endsWith(row.symbol+'_History.csv')));
});
test('after another close the dated review ages and an updated verified model VIX supersedes it',()=>{
  const later='2026-11-24T11:00:00Z',old=verifiedCloses(dash(),later);
  assert.ok(old.every(row=>!row.isLatest&&row.expectedDate==='2026-11-23'));
  const [v,semi]=verifiedCloses(dash('2026-11-23',34,later),later);
  assert.deepEqual([v.value,v.date,v.isLatest,v.basis,semi.date,semi.isLatest],[34,'2026-11-23',true,'model','2026-11-20',false]);
});
test('source agreement on the same date needs only one displayed value',()=>{
  const rows=verifiedCloses(dash('2026-11-20',35.89),'2026-11-22T04:00:00Z');
  assert.equal(rows[0].model,null);assert.equal(rows.length,2);
});
