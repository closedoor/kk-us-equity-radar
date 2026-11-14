import test from 'node:test';
import assert from 'node:assert/strict';
const symbols=['BTC','ETH','SOL','BNB','XRP','DOGE','ADA','AVAX','LINK','DOT'];
const freshModule=async label=>(await import('../worker/index.js?market-test='+label)).default;
const makeBinance=(age=0)=>symbols.map((s,i)=>({symbol:s+'USDT',lastPrice:String(100+i),priceChangePercent:'1',highPrice:'110',lowPrice:'90',quoteVolume:'1000000',closeTime:Date.now()-age}));
const okx=()=>({code:'0',data:symbols.map((s,i)=>({instId:s+'-USDT',last:String(100+i),open24h:'99',high24h:'110',low24h:'90',volCcy24h:'1000000',ts:String(Date.now())}))});
const originalFetch=globalThis.fetch;
test('fresh Binance quotes use original exchange timestamps and one shared request',async()=>{
 let calls=0;globalThis.fetch=async()=>{calls++;return Response.json(makeBinance());};
 try{const app=await freshModule('fresh');const responses=await Promise.all([1,2,3].map(()=>app.fetch(new Request('https://paper.test/api/quotes'))));for(const r of responses){assert.equal(r.status,200);const d=await r.json();assert.equal(d.provider,'binance');assert.equal(Object.keys(d.quotes).length,10);assert.ok(d.quotes.BTC.ts<=d.servedAt);assert.equal(d.basis,'spot');}assert.equal(calls,1);}finally{globalThis.fetch=originalFetch;}
});
test('Binance outage falls back transparently to real OKX spot data',async()=>{
 globalThis.fetch=async url=>url.includes('binance')?new Response('unavailable',{status:503}):Response.json(okx());
 try{const app=await freshModule('fallback'),r=await app.fetch(new Request('https://paper.test/api/quotes'));assert.equal(r.status,200);const d=await r.json();assert.equal(d.provider,'okx');assert.ok(d.source.includes('备用'));assert.equal(d.quotes.ETH.price,101);}finally{globalThis.fetch=originalFetch;}
});
test('stale source timestamps and total outages never become fake live prices',async()=>{
 globalThis.fetch=async url=>url.includes('binance')?Response.json(makeBinance(120000)):new Response('unavailable',{status:503});
 try{const app=await freshModule('stale'),r=await app.fetch(new Request('https://paper.test/api/quotes'));assert.equal(r.status,503);const d=await r.json();assert.equal(d.quotes,undefined);}finally{globalThis.fetch=originalFetch;}
});
test('candles retain source, sort chronologically, and reject malformed values',async()=>{
 globalThis.fetch=async()=>Response.json([[200,100,110,90,101,10],[100,99,103,98,100,10],...Array.from({length:12},(_,i)=>[300+i,101,103,99,102,1]),[400,NaN,0,0,0,0]]);
 try{const app=await freshModule('candles'),r=await app.fetch(new Request('https://paper.test/api/candles?symbol=ETH&interval=1h&provider=binance'));assert.equal(r.status,200);const d=await r.json();assert.equal(d.symbol,'ETH');assert.equal(d.provider,'binance');assert.equal(d.candles[0].time,100);assert.equal(d.candles.length,14);}finally{globalThis.fetch=originalFetch;}
});
