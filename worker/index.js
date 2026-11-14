// Self-contained Worker: public read-only quotes + browser-local paper trading.
export const COINS = [
 {symbol:'BTC',name:'Bitcoin',color:'#f7931a',icon:'₿'},
 {symbol:'ETH',name:'Ethereum',color:'#8797d5',icon:'Ξ'},
 {symbol:'SOL',name:'Solana',color:'#9d7bff',icon:'◎'},
 {symbol:'BNB',name:'BNB',color:'#f0b90b',icon:'B'},
 {symbol:'XRP',name:'XRP',color:'#aab6c5',icon:'X'},
 {symbol:'DOGE',name:'Dogecoin',color:'#c8a952',icon:'Ð'},
 {symbol:'ADA',name:'Cardano',color:'#4b95f2',icon:'A'},
 {symbol:'AVAX',name:'Avalanche',color:'#e85f67',icon:'A'},
 {symbol:'LINK',name:'Chainlink',color:'#5c88ec',icon:'L'},
 {symbol:'DOT',name:'Polkadot',color:'#e76db1',icon:'●'}
];
export const STOCKS = [
 ['NVDA','英伟达','chips','#77b900'],['AMD','超微半导体','chips','#e66b71'],['AVGO','博通','chips','#df4e65'],['INTC','英特尔','chips','#4f9fe3'],['QCOM','高通','chips','#6c8de8'],['ARM','Arm','chips','#22b3b9'],['TSM','台积电 ADR','chips','#be7070'],['ASML','阿斯麦','chips','#7296ed'],['AMAT','应用材料','chips','#92b2d4'],['LRCX','泛林集团','chips','#6f8fc4'],['KLAC','科磊','chips','#da9c62'],['SMH','半导体 ETF','chips','#8ba2d6'],
 ['MU','美光科技','memory','#6d9de3'],['STX','希捷科技','memory','#55bba6'],['WDC','西部数据','memory','#aa8ad9'],['SNDK','闪迪','memory','#e8806c'],
 ['MSFT','微软','software','#6fabe5'],['ORCL','甲骨文','software','#d2786a'],['PLTR','Palantir','software','#a6b5c9'],['CRM','Salesforce','software','#4fb3e2'],['ADBE','Adobe','software','#e37476'],['NOW','ServiceNow','software','#89ba92'],['CRWD','CrowdStrike','software','#e66e82'],['SNOW','Snowflake','software','#66b7dd'],
 ['AAPL','苹果','mega','#a6b5c9'],['GOOGL','Alphabet','mega','#78a3ea'],['AMZN','亚马逊','mega','#e4af66'],['META','Meta','mega','#78a4e3']
].map(([symbol,name,group,color])=>({symbol,name,group,color,market:'stock',icon:symbol.slice(0,2)}));
export const ASSETS=[...COINS.map(c=>({...c,market:'crypto',group:'crypto'})),...STOCKS];
// Policy shared verbatim with the browser. NY calendar from NYSE 2026–2028.
export function createMarketPolicy(){
 const holidays={
  2026:['01-01','01-19','02-16','04-03','05-25','06-19','07-03','09-07','11-26','12-25'],
  2027:['01-01','01-18','02-15','03-26','05-31','06-18','07-05','09-06','11-25','12-24'],
  2028:['01-17','02-21','04-14','05-29','06-19','07-04','09-04','11-23','12-25']
 };
 const early=['2026-11-27','2026-12-24','2027-11-26','2028-07-03','2028-11-24'];
 const formatter=new Intl.DateTimeFormat('en-CA',{timeZone:'America/New_York',year:'numeric',month:'2-digit',day:'2-digit',hour:'2-digit',minute:'2-digit',second:'2-digit',hourCycle:'h23'});
 function parts(time){const out={};for(const p of formatter.formatToParts(new Date(time)))if(p.type!=='literal')out[p.type]=p.value;return out;}
 function dayOf(time){const p=parts(time);return p.year+'-'+p.month+'-'+p.day;}
 function easternTime(text){
  if(typeof text!=='string'||!/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/.test(text))return NaN;
  const a=text.split(/[- :]/).map(Number),guess=Date.UTC(a[0],a[1]-1,a[2],a[3],a[4],a[5]),p=parts(guess);
  const observed=Date.UTC(+p.year,+p.month-1,+p.day,+p.hour,+p.minute,+p.second),result=guess+(guess-observed);
  const actual=parts(result);if([actual.year,actual.month,actual.day].join('-')!==text.slice(0,10)||[actual.hour,actual.minute,actual.second].join(':')!==text.slice(11))return NaN;
  return result;
 }
 function tradingDay(day){const year=+day.slice(0,4);if(!holidays[year])return null;const weekday=new Date(day+'T12:00:00Z').getUTCDay();return weekday!==0&&weekday!==6&&!holidays[year].includes(day.slice(5));}
 function session(now=Date.now()){
  const p=parts(now),day=p.year+'-'+p.month+'-'+p.day,minute=+p.hour*60+(+p.minute),known=tradingDay(day),close=early.includes(day)?780:960;
  let kind=known===null?'unknown':!known?'closed':minute<240?'closed':minute<570?'premarket':minute<close?'regular':minute<(close===780?1020:1200)?'postmarket':'closed';
  let expectedDate=day;
  if(!known||minute<570){for(let i=1;i<15;i++){const candidate=new Date(Date.parse(day+'T12:00:00Z')-i*86400000).toISOString().slice(0,10);if(tradingDay(candidate)){expectedDate=candidate;break;}}}
  return {day,expectedDate,minute,closeMinute:close,isOpen:kind==='regular',kind,known:known!==null,earlyClose:close===780,label:kind==='regular'?'美股常规交易中':kind==='premarket'?'盘前 · 模拟撮合暂停':kind==='postmarket'?'盘后 · 模拟撮合暂停':kind==='unknown'?'交易日历待更新':'美股休市'};
 }
 function assess(asset,q,now=Date.now()){
  const stock=asset?.market==='stock',age=q?now-q.ts:Infinity;
  if(!q||!Number.isFinite(q.price)||q.price<=0||!Number.isFinite(q.ts)||q.ts<=0||age< -5000)return {canTrade:false,quality:'missing',label:'暂无有效报价',age};
  if(!stock)return {canTrade:age<=30000,quality:age<=30000?'fresh':'stale',label:age<=30000?'实时参考价':'报价已过期',age};
  const market=session(now);
  if(q.verification==='conflict')return {canTrade:false,quality:'conflict',label:'行情源价格不一致 · 暂停撮合',age,session:market};
  if(!market.known||dayOf(q.ts)!==market.expectedDate)return {canTrade:false,quality:'stale',label:'历史报价 · 暂停撮合',age,session:market};
  if(q.endOfDay)return {canTrade:false,quality:'eod',label:'日终参考 · 暂停撮合',age,session:market};
  if(!market.isOpen)return {canTrade:false,quality:'closed',label:market.label,age,session:market};
  if(age>1200000)return {canTrade:false,quality:'stale',label:'报价超过 20 分钟 · 暂停撮合',age,session:market};
  return {canTrade:true,quality:age>120000?'delayed':'reference',label:age>120000?'延迟 '+Math.ceil(age/60000)+' 分钟 · 模拟参考':'参考行情 · 可能延迟',age,session:market};
 }
 return {parts,dayOf,easternTime,tradingDay,session,assess};
}
const marketPolicy=createMarketPolicy();

export function createEngine(instruments) {
 const FEE=0.0005, MMR=0.005, CAPITAL=100000;
 const symbols=instruments?instruments.map(x=>x.symbol):['BTC','ETH','SOL','BNB','XRP','DOGE','ADA','AVAX','LINK','DOT'];
 const positive=n=>Number.isFinite(n)&&n>0;
 const id=()=>globalThis.crypto?.randomUUID?.() || Date.now().toString(36)+Math.random().toString(36).slice(2);
 function fresh(){return {version:1,initial:CAPITAL,cash:CAPITAL,positions:[],orders:[],history:[],updatedAt:Date.now()};}
 function valid(s){
  if(!s||s.version!==1||s.initial!==CAPITAL||!Number.isFinite(s.cash)||s.cash<0||!Number.isFinite(s.updatedAt)||!Array.isArray(s.positions)||!Array.isArray(s.orders)||!Array.isArray(s.history)||s.positions.length+s.orders.length>100||s.history.length>10100)return false;
  const timeOk=t=>Number.isFinite(t)&&t>0&&t<8640000000000000;
  const common=p=>p&&typeof p.id==='string'&&p.id.length>0&&p.id.length<128&&symbols.includes(p.symbol)&&['long','short'].includes(p.side)&&positive(p.margin)&&Number.isInteger(p.leverage)&&p.leverage>=1&&p.leverage<=100&&positive(p.fee)&&timeOk(p.time)&&[p.tp,p.sl].every(n=>n==null||positive(n))&&Math.abs(p.fee-p.margin*p.leverage*FEE)<1e-6;
  if(!s.positions.every(p=>common(p)&&positive(p.qty)&&positive(p.entry)&&Math.abs(p.qty*p.entry-p.margin*p.leverage)<1e-5))return false;
  if(!s.orders.every(p=>common(p)&&positive(p.limit)))return false;
  const active=[...s.positions,...s.orders];if(new Set(active.map(p=>p.id)).size!==active.length)return false;
  if(!s.history.every(h=>common(h)&&positive(h.entry)&&positive(h.exit)&&positive(h.qty)&&Number.isFinite(h.net)&&timeOk(h.closedAt)&&Number.isFinite(h.fees)&&h.fees>=0))return false;
  const expected=CAPITAL+s.history.reduce((a,h)=>a+h.net,0)-active.reduce((a,p)=>a+p.margin+p.fee,0);
  return Number.isFinite(expected)&&Math.abs(expected-s.cash)<=Math.max(.0001,Math.abs(s.cash)*1e-10);
 }
 function check(s,o,price){
  if(!positive(price))throw Error('暂无有效行情，请等待报价恢复');
  if(!symbols.includes(o.symbol))throw Error('暂不支持该标的');
  if(!['long','short'].includes(o.side))throw Error('请选择交易方向');
  if(!positive(o.margin)||o.margin<1||o.margin>100000000)throw Error('保证金至少为 1 USDT');
  if(!Number.isInteger(o.leverage)||o.leverage<1||o.leverage>100)throw Error('杠杆须为 1–100 的整数');
  if(s.positions.length+s.orders.length>=100)throw Error('最多同时保留 100 笔持仓和委托');
  if(s.history.length>=10000)throw Error('记录已满，请导出备份后重置账户');
  if(!['market','limit'].includes(o.type))throw Error('请选择有效订单类型');
  if(o.type==='limit'&&!positive(o.limit))throw Error('请输入有效的委托价格');
  const marketable=o.type==='limit'&&!o.queueOnly&&(o.side==='long'?price<=o.limit:price>=o.limit);
  const entry=o.type==='limit'&&!marketable?o.limit:price;
  if(!positive(entry))throw Error('请输入有效的委托价格');
  if(o.tp!=null&&(!positive(o.tp)||(o.side==='long'?o.tp<=entry:o.tp>=entry)))throw Error(o.side==='long'?'做多止盈价须高于开仓价':'做空止盈价须低于开仓价');
  if(o.sl!=null&&(!positive(o.sl)||(o.side==='long'?o.sl>=entry:o.sl<=entry)))throw Error(o.side==='long'?'做多止损价须低于开仓价':'做空止损价须高于开仓价');
  const fee=o.margin*o.leverage*FEE;
  if(o.margin+fee>s.cash+1e-8)throw Error('可用余额不足，请预留开仓手续费');
  return fee;
 }
 function pnl(p,price){return (p.side==='long'?1:-1)*p.qty*(price-p.entry);}
 function liquidation(p){const dir=p.side==='long'?1:-1;return Math.max(0,(dir*p.qty*p.entry-p.margin)/(p.qty*(dir-MMR-FEE)));}
 function open(s,o,price,now=Date.now()){
  const fee=check(s,o,price);
  const p={id:id(),symbol:o.symbol,side:o.side,margin:o.margin,leverage:o.leverage,fee,tp:o.tp||null,sl:o.sl||null,time:now};
  s.cash=Math.max(0,s.cash-o.margin-fee);
  if(o.type==='limit' && (o.queueOnly || (o.side==='long'?price>o.limit:price<o.limit))){
   s.orders.push({...p,limit:o.limit});return {kind:'pending',id:p.id};
  }
  s.positions.push({...p,entry:price,qty:o.margin*o.leverage/price});return {kind:'opened',id:p.id};
 }
 function close(s,positionId,price,reason='手动平仓',now=Date.now()){
  if(!positive(price))throw Error('暂无有效行情，请稍后重试');
  const index=s.positions.findIndex(p=>p.id===positionId);
  if(index<0)throw Error('该持仓已经平仓');
  const p=s.positions[index], gross=pnl(p,price),fee=p.qty*price*FEE;
  const released=Math.max(0,p.margin+gross-fee);
  s.cash+=released;
  const record={...p,exit:price,closedAt:now,reason,gross,fees:p.fee+fee,net:released-p.margin-p.fee,lossCapped:p.margin+gross-fee<0};
  s.history.unshift(record);s.positions.splice(index,1);return record;
 }
 function cancel(s,orderId){const i=s.orders.findIndex(p=>p.id===orderId);if(i<0)throw Error('该委托已成交或撤销');const p=s.orders[i];s.cash+=p.margin+p.fee;s.orders.splice(i,1);}
 function updateStops(s,positionId,tp,sl){const p=s.positions.find(p=>p.id===positionId);if(!p)throw Error('该持仓已经平仓');
  // Validate against current reference in the UI, then retain absolute triggers.
  for(const n of [tp,sl])if(n!=null&&!positive(n))throw Error('请输入大于零的价格');
  p.tp=tp||null;p.sl=sl||null;
 }
 function process(s,quotes,now=Date.now()){
  const events=[];
  for(const o of [...s.orders]){
   const q=quotes[o.symbol];if(!q||q.canTrade===false||!positive(q.price))continue;
   if(o.side==='long'?q.price<=o.limit:q.price>=o.limit){
    s.orders.splice(s.orders.findIndex(x=>x.id===o.id),1);
    s.positions.push({...o,time:now,orderTime:o.time,entry:q.price,qty:o.margin*o.leverage/q.price});
    events.push({kind:'filled',symbol:o.symbol});
   }
  }
  for(const p of [...s.positions]){
   const q=quotes[p.symbol];if(!q||q.canTrade===false||!positive(q.price))continue;
   const price=q.price, equity=p.margin+pnl(p,price), maint=p.qty*price*(MMR+FEE);
   let reason='';
   if(equity<=maint)reason='模拟强平';
   else if(p.sl&&(p.side==='long'?price<=p.sl:price>=p.sl))reason='止损触发';
   else if(p.tp&&(p.side==='long'?price>=p.tp:price<=p.tp))reason='止盈触发';
   if(reason){const h=close(s,p.id,price,reason,now);events.push({kind:'closed',symbol:p.symbol,reason,net:h.net});}
  }
  return events;
 }
 function summary(s,quotes){
  let unrealized=0,margin=0,unpriced=0;
  for(const p of s.positions){margin+=p.margin;if(quotes[p.symbol]?.price>0)unrealized+=pnl(p,quotes[p.symbol].price);else unpriced++;}
  const reserved=s.orders.reduce((a,o)=>a+o.margin+o.fee,0);
  return {free:s.cash,margin,reserved,unrealized,equity:s.cash+margin+reserved+unrealized,realized:s.history.reduce((a,h)=>a+h.net,0),unpriced};
 }
 return {FEE,MMR,CAPITAL,fresh,valid,check,open,close,cancel,process,pnl,liquidation,summary,updateStops};
}

const QUOTE_TTL=3000, STALE=30000;
const coinSymbols=COINS.map(x=>x.symbol);
let quoteCache=null, quotePromise=null, preferred='binance', binanceRetry=0;
const candleCache=new Map();
async function upstream(url,timeoutMs=7000){
 const res=await fetch(url,{headers:{'accept':'application/json'},signal:AbortSignal.timeout(timeoutMs),cf:{cacheTtl:0}});
 if(!res.ok)throw Error('行情服务暂不可用');
 const data=await res.json();if(data.code && String(data.code)!=='0')throw Error('行情服务返回错误');return data;
}
function quoteValid(q,now){return q&&[q.price,q.high,q.low].every(n=>Number.isFinite(n)&&n>0)&&Number.isFinite(q.change)&&Number.isFinite(q.volume)&&q.volume>=0&&q.high>=q.low&&q.high+1e-8>=q.price&&q.low-1e-8<=q.price&&Number.isFinite(q.ts)&&now-q.ts<=STALE&&q.ts-now<5000;}
async function fetchQuotes(provider){
 const now=Date.now();let rows;
 if(provider==='binance'){
  const symbols=coinSymbols.map(s=>s+'USDT');
  const raw=await upstream('https://data-api.binance.vision/api/v3/ticker/24hr?symbols='+encodeURIComponent(JSON.stringify(symbols)));
  if(!Array.isArray(raw))throw Error('行情格式错误');
  rows=raw.map(t=>({symbol:t.symbol?.replace(/USDT$/,''),price:+t.lastPrice,change:+t.priceChangePercent,high:+t.highPrice,low:+t.lowPrice,volume:+t.quoteVolume,ts:+t.closeTime}));
 }else{
  const raw=await upstream('https://www.okx.com/api/v5/market/tickers?instType=SPOT');
  if(!Array.isArray(raw.data))throw Error('行情格式错误');
  rows=raw.data.filter(t=>coinSymbols.some(s=>t.instId===s+'-USDT')).map(t=>({symbol:t.instId.split('-')[0],price:+t.last,change:(+t.last/(+t.open24h)-1)*100,high:+t.high24h,low:+t.low24h,volume:+t.volCcy24h,ts:+t.ts}));
 }
 const quotes={};for(const q of rows){if(coinSymbols.includes(q.symbol)&&quoteValid(q,now))quotes[q.symbol]={...q,market:'crypto',provider,source:provider==='binance'?'币安现货':'OKX 现货（备用）'};}
 if(Object.keys(quotes).length<coinSymbols.length)throw Error('行情不完整或报价已过期');
 return {provider,source:provider==='binance'?'币安现货':'OKX 现货（备用）',basis:'spot',serverTime:Date.now(),quotes};
}
async function getQuotes(){
 if(quoteCache && Date.now()-quoteCache.serverTime<QUOTE_TTL)return quoteCache;
 if(quotePromise)return quotePromise;
 quotePromise=(async()=>{
  const first=preferred==='okx'&&Date.now()<binanceRetry?'okx':'binance';
  try{const r=await fetchQuotes(first);preferred=first;quoteCache=r;return r;}
  catch{
   const second=first==='binance'?'okx':'binance';
   const r=await fetchQuotes(second);preferred=second;if(second==='okx')binanceRetry=Date.now()+60000;quoteCache=r;return r;
  }
 })();
 try{return await quotePromise;}finally{quotePromise=null;}
}
async function getCandles(symbol,interval,provider){
 const key=[symbol,interval,provider].join(':');const old=candleCache.get(key);
 if(old&&Date.now()-old.serverTime<20000)return old;
 const raw=provider==='binance'
  ?await upstream('https://data-api.binance.vision/api/v3/klines?symbol='+symbol+'USDT&interval='+interval+'&limit=90')
  :await upstream('https://www.okx.com/api/v5/market/candles?instId='+symbol+'-USDT&bar='+({ '15m':'15m','1h':'1H','4h':'4H','1d':'1Dutc'}[interval])+'&limit=90');
 const rows=provider==='binance'?raw:raw.data;
 if(!Array.isArray(rows))throw Error('K线格式错误');
 const candles=rows.map(r=>({time:+r[0],open:+r[1],high:+r[2],low:+r[3],close:+r[4],volume:+r[5]})).filter(c=>Number.isFinite(c.time)&&[c.open,c.high,c.low,c.close].every(n=>Number.isFinite(n)&&n>0)&&c.high>=Math.max(c.open,c.close)&&c.low<=Math.min(c.open,c.close)).sort((a,b)=>a.time-b.time);
 if(candles.length<10)throw Error('历史行情不足');
 const out={symbol,interval,provider,candles,serverTime:Date.now()};candleCache.set(key,out);return out;
}
async function upstreamText(url,extraHeaders={}){
 const response=await fetch(url,{headers:{accept:'*/*',...extraHeaders},signal:AbortSignal.timeout(8000),cf:{cacheTtl:0}});
 if(!response.ok)throw Error('参考行情暂不可用');
 const bytes=await response.arrayBuffer(),encoding=/utf-?8/i.test(response.headers.get('content-type')||'')?'utf-8':'gb18030';
 try{return new TextDecoder(encoding).decode(bytes);}catch{
  // Workers without GB18030 support: discard multibyte names, retain ASCII numeric fields.
  const a=new Uint8Array(bytes);let out='';for(let i=0;i<a.length;i++){const b=a[i];if(b<128){out+=String.fromCharCode(b);continue;}if(b>=0x81&&b<=0xfe&&a[i+1]>=0x30&&a[i+1]<=0x39&&a[i+2]>=0x81&&a[i+2]<=0xfe&&a[i+3]>=0x30&&a[i+3]<=0x39)i+=3;else if(b>=0x81&&b<=0xfe&&a[i+1]>=0x40&&a[i+1]<=0xfe)i++;out+='?';}return out;
 }
}
export function parseTencentStocks(text,now=Date.now()){
 const quotes={};
 for(const match of text.matchAll(/v_us([A-Z]+)="([^"\n]*)"/g)){
  const symbol=match[1],f=match[2].split('~');if(!STOCKS.some(s=>s.symbol===symbol)||f.length<38||f[2].split('.')[0]!==symbol||!/^[A-Z]{1,6}\.(OQ|N)$/.test(f[2])||f[35]!=='USD')continue;
  const price=Number(f[3]),previous=Number(f[4]),open=Number(f[5]),high=Number(f[33]),low=Number(f[34]),ts=marketPolicy.easternTime(f[30]);
  if(![price,previous,open,high,low,ts].every(n=>Number.isFinite(n)&&n>0)||high+0.02<Math.max(price,open)||low-0.02>Math.min(price,open)||ts>now+5000)continue;
  quotes[symbol]={symbol,price,previous,open,change:(price/previous-1)*100,high,low,volume:Number(f[37])||0,shares:Number(f[6])||0,ts,market:'stock',currency:'USD',provider:'tencent',source:'腾讯财经',exchangeTicker:f[2],verification:'single'};
 }
 return quotes;
}
export function parseSinaStocks(text,now=Date.now()){
 const quotes={},months=['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'],current=marketPolicy.parts(now);
 for(const match of text.matchAll(/hq_str_gb_([a-z]+)="([^"\n]*)"/g)){
  const symbol=match[1].toUpperCase(),f=match[2].split(',');if(!STOCKS.some(s=>s.symbol===symbol)||f.length<27)continue;
  // Field 3 is the page refresh in Beijing, NOT the underlying regular-session quote time.
  const t=/^([A-Za-z]{3}) (\d{1,2}) (\d{2}):(\d{2})(AM|PM) (EST|EDT)$/.exec(f[25]);if(!t)continue;
  const mon=months.indexOf(t[1]);if(mon<0)continue;let year=+current.year;if(mon+1>+current.month)year--;
  const hour=(+t[3]%12)+(t[5]==='PM'?12:0),ts=Date.UTC(year,mon,+t[2],hour+(t[6]==='EST'?5:4),+t[4]);
  const price=+f[1],previous=+f[26],open=+f[5],high=+f[6],low=+f[7];
  if(![price,previous,open,high,low,ts].every(n=>Number.isFinite(n)&&n>0)||high+0.02<Math.max(price,open)||low-0.02>Math.min(price,open)||ts>now+5000)continue;
  const nyse=['TSM','ORCL','CRM','NOW','SNOW'].includes(symbol);
  quotes[symbol]={symbol,price,previous,open,high,low,change:(price/previous-1)*100,volume:Number(f[30])||0,shares:Number(f[10])||0,ts,market:'stock',currency:'USD',provider:'sina',source:'新浪财经',exchangeTicker:symbol+(nyse?'.N':'.OQ'),verification:'single'};
 }
 return quotes;
}
export function reconcileStockQuote(a,b){
 if(!a&&!b)return null;
 const q={...(a&&b&&b.ts>a.ts+15000?b:a||b)};
 if(a&&b){
  const pa=marketPolicy.parts(a.ts),pb=marketPolicy.parts(b.ts),ma=(+pa.hour)*60+(+pa.minute),mb=(+pb.hour)*60+(+pb.minute);
  const closing=marketPolicy.dayOf(a.ts)===marketPolicy.dayOf(b.ts)&&ma>=marketPolicy.session(a.ts).closeMinute&&mb>=marketPolicy.session(b.ts).closeMinute;
  if(Math.abs(a.ts-b.ts)<=15000||closing){
   const diff=Math.abs(a.price-b.price),tolerance=Math.max(.02,a.price*.0005);
   q.verification=diff<=tolerance?'cross_checked':'conflict';q.verifiedBy=q.provider==='tencent'?'新浪财经':'腾讯财经';q.alternatePrice=q.provider==='tencent'?b.price:a.price;q.alternateTs=q.provider==='tencent'?b.ts:a.ts;
  }
 }
 return q;
}
let stockCache=null,stockPromise=null;
async function getStockQuotes(){
 if(stockCache&&Date.now()-stockCache.serverTime<12000)return stockCache;if(stockPromise)return stockPromise;
 stockPromise=(async()=>{
  const symbols=STOCKS.map(s=>s.symbol),now=Date.now();
  const results=await Promise.allSettled([
   upstreamText('https://qt.gtimg.cn/q='+symbols.map(s=>'us'+s).join(',')),
   upstreamText('https://hq.sinajs.cn/list='+symbols.map(s=>'gb_'+s.toLowerCase()).join(','),{referer:'https://finance.sina.com.cn/'})
  ]);
  const primary=results[0].status==='fulfilled'?parseTencentStocks(results[0].value,Date.now()):{},secondary=results[1].status==='fulfilled'?parseSinaStocks(results[1].value,Date.now()):{},quotes={};
  for(const symbol of symbols){const q=reconcileStockQuote(primary[symbol],secondary[symbol]);if(q)quotes[symbol]=q;}
  if(!Object.keys(quotes).length)throw Error('美股参考行情暂不可用');
  stockCache={market:'stock',provider:'tencent',source:'美股参考行情',basis:'stock',quotes,missing:symbols.filter(s=>!quotes[s]),serverTime:Date.now(),session:marketPolicy.session()};return stockCache;
 })();try{return await stockPromise;}finally{stockPromise=null;}
}
export function aggregateStockCandles(candles,interval){
 if(interval==='1d')return candles.slice(-90);
 const groups=new Map();
 for(const c of candles){const d=new Date(c.time);let key;
  if(interval==='1mo')key=d.toISOString().slice(0,7);
  else{const weekDay=d.getUTCDay()||7;key=new Date(c.time-(weekDay-1)*86400000).toISOString().slice(0,10);}
  const old=groups.get(key);if(!old)groups.set(key,{...c});else{old.high=Math.max(old.high,c.high);old.low=Math.min(old.low,c.low);old.close=c.close;old.volume+=c.volume;}
 }
 return [...groups.values()].slice(-90);
}
async function getStockCandles(symbol,interval){
 const key='stock:'+symbol+':'+interval,old=candleCache.get(key);if(old&&Date.now()-old.serverTime<120000)return old;
 const quotes=await getStockQuotes(),q=quotes.quotes[symbol];if(!q)throw Error('没有可靠的证券代码');
 const code='us'+q.exchangeTicker;
 const raw=await upstream('https://web.ifzq.gtimg.cn/appstock/app/usfqkline/get?param='+encodeURIComponent(code+',day,,,320,qfq'),14000);
 const rows=raw.data?.[code]?.qfqday;if(!Array.isArray(rows))throw Error('历史行情格式错误');
 const daily=rows.map(r=>({time:Date.parse(r[0]+'T12:00:00Z'),open:+r[1],close:+r[2],high:+r[3],low:+r[4],volume:+r[5]})).filter(c=>Number.isFinite(c.time)&&[c.open,c.high,c.low,c.close].every(n=>Number.isFinite(n)&&n>0)&&c.high>=Math.max(c.open,c.close)&&c.low<=Math.min(c.open,c.close)&&Number.isFinite(c.volume)&&c.volume>=0).sort((a,b)=>a.time-b.time);
 if(daily.length<10)throw Error('有效历史行情不足');
 const out={symbol,interval,provider:'tencent',adjustment:'forward',candles:aggregateStockCandles(daily,interval),serverTime:Date.now()};candleCache.set(key,out);return out;
}

const security={'x-content-type-options':'nosniff','referrer-policy':'same-origin','permissions-policy':'camera=(), microphone=(), geolocation=()','content-security-policy':"default-src 'self'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'self'; object-src 'none'; base-uri 'self'; form-action 'self'"};
function json(data,status=200){return new Response(JSON.stringify(data),{status,headers:{...security,'content-type':'application/json; charset=utf-8','cache-control':'no-store'}});}
const html = String.raw`<!doctype html>
<html lang="zh-CN"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover"><meta name="theme-color" content="#0b0e11"><meta name="apple-mobile-web-app-capable" content="yes"><meta name="description" content="美股与加密模拟合约。10万USDT虚拟本金、1至100倍杠杆，参考行情、休市识别、限价与止盈止损。"><title>环球模拟盘 · 美股与加密</title><link rel="icon" href="data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 64 64'%3E%3Crect width='64' height='64' rx='16' fill='%230b0e11'/%3E%3Cpath d='M32 10 54 32 32 54 10 32Z' fill='%23f0b90b'/%3E%3Cpath d='M32 24 40 32 32 40 24 32Z' fill='%230b0e11'/%3E%3C/svg%3E">
<style>
:root{color-scheme:dark;--bg:#0b0e11;--panel:#12161c;--input:#1c222b;--line:#252b35;--text:#eaecef;--muted:#8993a3;--yellow:#f0b90b;--green:#1bc79b;--red:#f16477;--font:-apple-system,BlinkMacSystemFont,"Segoe UI","PingFang SC","Microsoft YaHei",sans-serif;--num:"SFMono-Regular",Consolas,"Liberation Mono",monospace}*{box-sizing:border-box}body{margin:0;background:var(--bg);font-family:var(--font);color:var(--text);font-size:14px;-webkit-font-smoothing:antialiased}button,input,select{font:inherit}button{cursor:pointer;border:0;color:inherit;background:none}button:focus-visible,input:focus-visible,summary:focus-visible{outline:2px solid var(--yellow);outline-offset:3px}button:disabled{cursor:not-allowed;opacity:.45}input{min-width:0;width:100%;background:var(--input);border:1px solid var(--line);border-radius:8px;color:var(--text);padding:12px 13px;font-family:var(--num);font-size:16px;outline:none}input:focus{border-color:var(--yellow)}input::placeholder{color:#596474}input[type=number]{appearance:textfield}input::-webkit-inner-spin-button{appearance:none}a{color:var(--yellow)}.mono{font-family:var(--num);font-variant-numeric:tabular-nums}.muted{color:var(--muted)}.positive{color:var(--green)!important}.negative{color:var(--red)!important}.tiny{font-size:11px;letter-spacing:.03em}.small{font-size:12px}.brand{display:flex;align-items:center;gap:11px;font-weight:700;font-size:18px;white-space:nowrap}.brandmark{width:22px;height:22px;transform:rotate(45deg);border:6px solid var(--yellow);border-radius:2px}.brand small{font-size:10px;color:var(--yellow);border:1px solid #514523;border-radius:4px;padding:3px 5px;font-weight:500;letter-spacing:1px}.topbar{height:74px;border-bottom:1px solid var(--line);display:flex;align-items:center;justify-content:space-between;padding:0 32px;gap:20px;max-width:1760px;margin:auto}.top-actions{display:flex;align-items:center;gap:18px}.status{font-size:12px;color:var(--muted);display:flex;align-items:center;gap:7px}.dot{width:6px;height:6px;border-radius:50%;background:#687282;display:inline-block;flex-shrink:0}.status.live .dot{background:var(--green);box-shadow:0 0 10px #1bc79b66}.status.offline .dot{background:var(--red)}.text-btn{color:var(--muted);font-size:12px;padding:12px 0}.text-btn:hover{color:var(--text)}.shell{max-width:1600px;margin:0 auto;padding:27px 32px 24px}.account{display:flex;align-items:stretch;gap:30px;justify-content:space-between;margin-bottom:26px}.equity{min-width:270px}.eyebrow{font-size:12px;color:var(--muted);margin:0 0 9px;display:flex;align-items:center;gap:8px}.sim-label{background:#f0b90b15;color:#d5ae3c;border-radius:4px;font-size:10px;padding:3px 5px}.equity-number{font-size:36px;letter-spacing:-1.2px;font-weight:600;line-height:1.2}.unit{font-size:13px;color:var(--muted);letter-spacing:0;font-weight:400;margin-left:7px}.equity-caption{margin-top:8px;font-size:11px;color:var(--muted)}.account-stats{display:grid;grid-template-columns:repeat(3,minmax(120px,1fr));gap:35px;align-items:center}.stat-name{color:var(--muted);font-size:12px;margin-bottom:10px}.stat-value{font-size:19px;white-space:nowrap}.stat-sub{font-size:11px;color:var(--muted);margin-top:7px}.workspace{display:grid;grid-template-columns:225px minmax(300px,1fr) 310px;gap:14px;align-items:start}.panel{background:var(--panel);border:1px solid var(--line);border-radius:12px;overflow:hidden}.markets{grid-column:1;grid-row:1/3;min-height:680px}.panel-head{padding:20px 17px 12px;display:flex;align-items:center;justify-content:space-between;font-size:14px;font-weight:600}.panel-head .muted{font-size:10px;font-weight:400}.search-wrap{padding:0 12px 13px}.search-wrap input{font:12px var(--font);padding:10px 11px;background:#191e26}.market-head{display:flex;justify-content:space-between;color:#687384;font-size:10px;padding:0 17px 11px}.market-row{width:100%;display:flex;align-items:center;justify-content:space-between;padding:13px 14px;border-left:2px solid transparent;transition:background .15s;text-align:left;gap:8px}.market-row:hover{background:#1a2029}.market-row.selected{background:#f0b90b0b;border-left-color:var(--yellow)}.coin{width:28px;height:28px;border-radius:50%;display:inline-flex;align-items:center;justify-content:center;font-weight:650;font-size:15px;flex-shrink:0;background:color-mix(in srgb,var(--coin-color) 15%,transparent);color:var(--coin-color);border:1px solid color-mix(in srgb,var(--coin-color) 25%,transparent)}.market-label{display:flex;align-items:center;gap:8px}.market-symbol{font-size:12px;font-weight:600}.market-name{font-size:10px;color:var(--muted);margin-top:5px}.market-numbers{text-align:right;font-family:var(--num);white-space:nowrap}.market-price{font-size:12px}.market-change{font-size:10px;margin-top:5px}.market-foot{padding:20px 16px 15px;border-top:1px solid var(--line);font-size:10px;line-height:1.9;color:#6c7889}.market-empty{padding:30px 10px;text-align:center;color:var(--muted)}.chart-panel{grid-column:2;grid-row:1}.pair-header{display:flex;align-items:center;justify-content:space-between;padding:21px 22px 18px;gap:16px}.pair-identity{display:flex;align-items:center;gap:11px}.pair-identity .coin{width:36px;height:36px;font-size:21px}.pair-name{font-size:18px;font-weight:600;white-space:nowrap}.pair-type{font-size:10px;color:var(--muted);margin-top:6px;white-space:nowrap}.pair-price{text-align:right}.price-large{font-size:25px;letter-spacing:-.5px}.price-change{font-size:11px;margin-top:5px}.market-stats{display:flex;gap:23px;padding:0 22px 18px;border-bottom:1px solid var(--line)}.market-stats>div{min-width:0}.market-stats label{display:block;color:var(--muted);font-size:10px;margin-bottom:5px}.market-stats span{font-size:12px}.chart-toolbar{padding:13px 15px;display:flex;align-items:center;justify-content:space-between}.timeframes{display:flex;gap:3px}.time-btn{font-family:var(--num);font-size:11px;border-radius:5px;padding:7px 10px;color:var(--muted);min-height:32px}.time-btn.active{color:var(--yellow);background:#f0b90b12}.chart-caption{font-size:10px;color:#596474;margin-right:4px}.chart-wrap{height:328px;position:relative;margin:0 6px}.chart-wrap canvas{width:100%;height:100%;display:block;touch-action:pan-y}.chart-message{position:absolute;inset:0;display:flex;align-items:center;justify-content:center;color:var(--muted);font-size:12px;pointer-events:none}.chart-message[hidden]{display:none}.chart-note{border-top:1px solid var(--line);padding:11px 20px;font-size:10px;color:#697486;display:flex;justify-content:space-between;gap:10px}.order-panel{grid-column:3;grid-row:1/3;padding:20px 18px}.order-title{display:flex;justify-content:space-between;align-items:center;margin-bottom:18px;font-weight:600}.mode-pill{font-size:10px;font-weight:400;background:var(--input);border:1px solid var(--line);border-radius:4px;padding:4px 7px;color:var(--muted)}.direction{display:grid;grid-template-columns:1fr 1fr;background:#1b212a;border-radius:8px;padding:4px;gap:3px}.direction button{min-height:39px;border-radius:6px;font-size:13px;color:var(--muted)}.direction .long.active{background:#1bc79b21;color:var(--green);font-weight:650}.direction .short.active{background:#f1647721;color:var(--red);font-weight:650}.order-types{display:flex;gap:22px;border-bottom:1px solid var(--line);margin:18px 0}.order-types button{font-size:12px;color:var(--muted);padding:0 0 12px;border-bottom:2px solid transparent}.order-types button.active{color:var(--yellow);border-bottom-color:var(--yellow)}.field{margin-bottom:17px}.field label{display:flex;align-items:center;justify-content:space-between;font-size:12px;color:var(--muted);margin-bottom:9px;gap:5px}.field label strong{color:var(--yellow);font-family:var(--num);font-size:13px;font-weight:500}.input-wrap{position:relative}.input-wrap input{padding-right:61px}.input-wrap>span{position:absolute;right:12px;top:15px;font-size:11px;color:var(--muted);pointer-events:none}.leverage-presets{display:flex;gap:5px;margin-top:10px}.leverage-presets button,.percent-row button{flex:1;border-radius:4px;background:#1b212a;font-family:var(--num);font-size:10px;padding:7px 0;color:var(--muted);min-height:30px}.leverage-presets button.active{background:#f0b90b15;color:var(--yellow);box-shadow:inset 0 0 0 1px #f0b90b66}.leverage-range{accent-color:var(--yellow);padding:0;border:0;background:none;margin:3px 0 0;height:17px}.percent-row{display:flex;gap:6px;margin-top:8px}.percent-row button:hover{color:var(--yellow)}.balance-note{font-size:10px;display:flex;justify-content:space-between;color:var(--muted);margin-top:8px}.stop-toggle{display:flex;justify-content:space-between;align-items:center;padding:0;margin-bottom:13px;cursor:pointer;font-size:12px;color:var(--muted);width:100%;min-height:30px}.stop-toggle[aria-expanded=true]{color:var(--yellow)}.stop-fields{display:grid;grid-template-columns:1fr 1fr;gap:10px}.stop-fields[hidden]{display:none}.stop-fields input{font-size:13px;padding:11px 9px}.order-summary{padding:14px 0;border-top:1px solid var(--line);display:grid;gap:10px}.summary-row{display:flex;justify-content:space-between;gap:10px;font-size:11px;color:var(--muted)}.summary-row span:last-child{font-family:var(--num);color:#c2c9d3;text-align:right}.submit{width:100%;min-height:46px;border-radius:8px;background:var(--green);color:#06271d;font-size:14px;font-weight:650;transition:filter .15s;margin-top:8px}.submit:hover{filter:brightness(1.1)}.submit.sell{background:var(--red);color:#300c14}.order-foot{font-size:10px;color:#697486;line-height:1.8;text-align:center;margin-top:12px}.high-leverage{font-size:10px;color:#c9a34a;margin:10px 0 0;line-height:1.6}.high-leverage[hidden]{display:none}.error{font-size:11px;line-height:1.6;color:var(--red);margin:8px 0 0;min-height:0}.positions-panel{grid-column:2;grid-row:2;min-height:207px}.positions-header{display:flex;align-items:center;justify-content:space-between;padding:0 17px;border-bottom:1px solid var(--line);gap:10px}.position-tabs{display:flex;gap:20px}.position-tabs button{padding:17px 0 14px;font-size:12px;color:var(--muted);border-bottom:2px solid transparent;white-space:nowrap}.position-tabs button.active{color:var(--text);border-bottom-color:var(--yellow)}.position-tabs small{color:#737f91;font-family:var(--num);font-size:10px;margin-left:4px}.export-btn{font-size:10px;color:var(--muted);padding:12px 0;white-space:nowrap}.empty{min-height:166px;display:flex;align-items:center;justify-content:center;flex-direction:column;gap:10px;padding:25px;text-align:center}.empty-icon{font-size:25px;color:#4b5667;font-family:var(--num);margin-bottom:4px}.empty-title{font-size:12px;color:#c2c9d3}.empty-sub{font-size:11px;line-height:1.7;color:#6e7b8f}.position-card{padding:17px 20px;border-bottom:1px solid var(--line)}.position-card:last-child{border-bottom:0}.position-top{display:flex;align-items:center;justify-content:space-between;margin-bottom:15px;gap:10px}.position-id{display:flex;align-items:center;gap:7px;flex-wrap:wrap}.position-id strong{font-size:13px}.position-id .tag{font-size:9px;background:#222932;border-radius:3px;padding:3px 5px;white-space:nowrap}.position-profit{font:15px var(--num);text-align:right;white-space:nowrap}.position-profit small{display:block;font-size:10px;margin-top:5px}.position-grid{display:grid;grid-template-columns:repeat(4,1fr);gap:12px 15px}.position-grid label{font-size:10px;display:block;color:var(--muted);margin-bottom:6px}.position-grid span{font:11px var(--num)}.position-actions{display:flex;justify-content:space-between;align-items:center;margin-top:17px;gap:8px}.position-actions time{font-size:10px;color:#647183}.outline-btn{border:1px solid #3b444f;border-radius:5px;font-size:11px;padding:8px 12px;min-height:33px;white-space:nowrap}.outline-btn:hover{color:var(--yellow);border-color:#625534}.actions-group{display:flex;gap:7px}.history-reason{font-size:10px;color:var(--muted);margin-left:5px}.footer{display:flex;justify-content:space-between;gap:20px;font-size:10px;color:#606d7e;margin:19px 2px 0;line-height:1.8}.footer button{padding:0;color:#8590a0;font-size:10px;min-height:25px}.footer-left{display:flex;gap:7px;align-items:baseline}.footer-right{display:flex;gap:17px}.quote-warning{padding:11px 15px;border:1px solid #6c4935;border-radius:7px;background:#b86e1912;color:#d7aa78;font-size:12px;line-height:1.6;margin-bottom:16px}.quote-warning[hidden]{display:none}.toast{position:fixed;top:87px;left:50%;transform:translateX(-50%);z-index:30;background:#242c37;color:#eaecef;border:1px solid #455161;box-shadow:0 10px 35px #0008;border-radius:9px;padding:13px 18px;font-size:12px;max-width:min(90vw,470px);line-height:1.65;pointer-events:none;opacity:0;transition:opacity .18s}.toast.show{opacity:1}.toast.bad{border-color:#9c4c5b}dialog{padding:25px;border:1px solid #3b4553;border-radius:14px;background:#161c24;color:var(--text);max-width:min(94vw,520px);width:520px;box-shadow:0 20px 90px #000b;max-height:86dvh}dialog::backdrop{background:#0009;backdrop-filter:blur(3px)}.dialog-head{display:flex;align-items:center;justify-content:space-between;margin-bottom:18px}dialog h2{font-size:18px;margin:0}dialog p,dialog li{font-size:12px;color:#a5afbd;line-height:1.9}dialog ul{padding-left:18px}dialog .close-dialog{min-width:35px;min-height:35px;font-size:20px;color:var(--muted)}.dialog-buttons{display:flex;gap:10px;margin-top:19px}.dialog-buttons button{flex:1;border:1px solid #3b4553;border-radius:7px;padding:12px;font-size:12px}.dialog-buttons .primary{background:var(--yellow);color:#211c0d;border-color:var(--yellow);font-weight:600}.dialog-buttons .danger{background:#f164771a;color:var(--red);border-color:#854854}.rule-link{display:inline-block;margin-right:14px;font-size:11px}.backup-row{display:flex;gap:8px;margin-top:13px}.backup-row button{font-size:11px;border:1px solid var(--line);border-radius:6px;padding:11px;flex:1}.recovery{color:var(--red);font-size:12px;line-height:1.8}.loading .market-price{color:#657184}
@media(min-width:1500px){.workspace{grid-template-columns:240px minmax(300px,1fr) 330px}.chart-wrap{height:350px}.shell{padding-top:32px}}
@media(max-width:1170px){.workspace{grid-template-columns:185px minmax(250px,1fr) 290px;gap:10px}.shell{padding:22px 18px}.topbar{padding:0 20px}.market-row{padding:13px 9px}.market-label{gap:6px}.market-name{font-size:9px}.market-row .coin{width:22px;height:22px;font-size:13px}.market-price{font-size:10px}.market-symbol{font-size:11px}.account-stats{gap:20px}.market-stats{gap:16px}.pair-header{padding:19px 17px}.price-large{font-size:21px}.pair-name{font-size:16px}.order-panel{padding:20px 16px}.position-grid{grid-template-columns:repeat(3,1fr)}}
@media(max-width:980px){.workspace{grid-template-columns:minmax(300px,1fr) 310px}.markets{grid-column:1/-1;grid-row:1;min-height:0}.markets .panel-head,.search-wrap,.market-head,.market-foot{display:none}.market-list{display:flex;overflow-x:auto;scrollbar-width:none}.market-list::-webkit-scrollbar{display:none}.market-row{min-width:145px;width:145px;padding:13px 14px;display:block;border-left:0;border-bottom:2px solid transparent}.market-row.selected{border-left:0;border-bottom-color:var(--yellow)}.market-name{display:none}.market-row .coin{width:21px;height:21px}.market-symbol{font-size:11px}.market-label{gap:6px}.market-numbers{display:flex;justify-content:space-between;margin-top:10px;align-items:center}.market-price{font-size:11px}.market-change{margin:0;font-size:10px}.chart-panel{grid-column:1;grid-row:2}.order-panel{grid-column:2;grid-row:2/4}.positions-panel{grid-column:1;grid-row:3}.account-stats{gap:20px;grid-template-columns:repeat(3,1fr)}.equity-number{font-size:31px}.equity{min-width:245px}.account{gap:25px}.stat-value{font-size:16px}.chart-caption{display:none}.chart-wrap{height:290px}.market-stats{gap:20px}.stat-sub{font-size:10px}}
@media(max-width:720px){.topbar{height:66px;padding:0 17px;gap:10px}.brand{font-size:16px;gap:9px}.brandmark{width:18px;height:18px;border-width:5px}.brand small{font-size:8px;padding:3px 4px}.top-actions{gap:10px}.top-actions>.text-btn{display:none}.status{font-size:10px}.status-source{display:none}.shell{padding:21px 12px calc(22px + env(safe-area-inset-bottom))}.account{display:block;margin-bottom:20px}.equity{padding:0 5px;margin-bottom:20px}.equity-number{font-size:34px}.eyebrow{font-size:11px}.equity-caption{font-size:10px}.account-stats{gap:10px;grid-template-columns:1.15fr 1fr 1fr;padding:16px 5px 0;border-top:1px solid var(--line)}.stat-name{font-size:10px;margin-bottom:8px}.stat-value{font-size:15px}.stat-sub{font-size:9px;margin-top:6px}.workspace{grid-template-columns:1fr;gap:12px}.markets{grid-column:1;grid-row:1;border-radius:9px}.market-row{min-width:137px;width:137px;padding:12px 14px}.chart-panel{grid-column:1;grid-row:2}.order-panel{grid-column:1;grid-row:3;padding:20px 18px}.positions-panel{grid-column:1;grid-row:4}.pair-header{padding:17px 16px 15px}.pair-identity .coin{width:33px;height:33px;font-size:19px}.pair-name{font-size:17px}.pair-type{font-size:9px}.price-large{font-size:24px}.market-stats{padding:0 17px 15px;gap:24px}.market-stats label{font-size:9px}.market-stats span{font-size:11px}.chart-wrap{height:263px}.chart-toolbar{padding:9px 12px}.chart-note{padding:11px 15px;font-size:9px}.chart-caption{display:block;font-size:9px}.time-btn{padding:8px 11px}.order-title{font-size:14px;margin-bottom:16px}.direction button{min-height:42px;font-size:14px}.field{margin-bottom:18px}.field label{font-size:12px}.order-types button{font-size:13px;min-height:35px}.leverage-presets button,.percent-row button{min-height:34px;font-size:11px}.leverage-range{height:24px}.order-summary{gap:12px}.summary-row{font-size:12px}.submit{min-height:49px;font-size:15px}.order-foot{font-size:10px}.balance-note{font-size:11px}.stop-toggle{font-size:12px;min-height:33px}.stop-fields input{font-size:16px}.order-panel .field input{padding-top:14px;padding-bottom:14px}.order-panel .input-wrap>span{top:17px}.position-tabs{gap:23px}.position-tabs button{font-size:12px;padding:18px 0 15px}.positions-header{padding:0 15px}.position-card{padding:18px 16px}.position-grid{grid-template-columns:repeat(3,1fr);gap:15px 10px}.position-grid label{font-size:10px}.position-grid span{font-size:11px}.position-profit{font-size:15px}.position-id strong{font-size:13px}.position-actions time{font-size:9px}.outline-btn{min-height:36px;font-size:11px;padding:8px 11px}.footer{flex-direction:column;gap:10px;margin:18px 5px 0;font-size:10px}.footer-right{gap:20px}.footer button{font-size:11px;min-height:32px}.toast{top:75px;font-size:12px}.quote-warning{font-size:11px}.stop-fields .field{margin-bottom:15px}dialog{padding:21px}.empty{min-height:180px}}
@media(prefers-reduced-motion:reduce){*{transition:none!important;scroll-behavior:auto!important}}

.market-switch{display:flex;align-items:center;gap:20px;margin:0 0 16px;flex-wrap:wrap}.asset-market{display:flex;gap:5px;padding:4px;background:#151b22;border:1px solid var(--line);border-radius:9px}.asset-market button{font-size:12px;min-height:35px;padding:8px 17px;color:var(--muted);border-radius:6px;white-space:nowrap}.asset-market button.active{background:#f0b90b19;color:var(--yellow)}.category-filters{display:flex;gap:4px;flex-wrap:wrap}.category-filters[hidden]{display:none}.category-filters button{color:var(--muted);min-height:33px;padding:7px 11px;font-size:11px;border-radius:5px}.category-filters button.active{background:#29323e;color:var(--text)}.data-quality{padding:10px 21px 0;color:#8996a8;font-size:10px;line-height:1.7}.stock-icon{font-size:10px!important;font-family:var(--num)}.status.closed .dot{background:var(--yellow)}.market-list{max-height:704px;overflow-y:auto;scrollbar-width:thin;scrollbar-color:#394554 transparent}.pair-type{white-space:normal;line-height:1.7}.time-btn[hidden]{display:none}.pair-header>div{min-width:0}.chart-note{min-height:36px;align-items:center}.chart-note>span{min-width:0}.chart-note #updateTime{white-space:nowrap}.position-id{min-width:0}.history-reason{overflow-wrap:anywhere}
@media(max-width:980px){.market-list{max-height:none;overflow-y:hidden;overflow-x:auto}}
@media(max-width:720px){.market-switch{gap:10px;margin-bottom:12px}.asset-market{width:100%}.asset-market button{flex:1;font-size:13px;min-height:38px}.category-filters{width:100%;gap:2px;flex-wrap:nowrap;overflow-x:auto;scrollbar-width:none}.category-filters button{font-size:11px;padding:8px 10px;white-space:nowrap;flex-shrink:0}.markets .search-wrap{display:block;padding:10px 12px 0}.markets .search-wrap input{font-size:16px;padding:10px}.data-quality{padding:10px 17px 0;font-size:10px}.pair-type{max-width:185px;font-size:9px}.pair-identity{gap:8px}.pair-name{font-size:16px}.price-large{font-size:22px}.chart-note{font-size:9px;gap:5px}.chart-note #chartInfo{max-width:65%;overflow-wrap:anywhere}.chart-wrap{height:270px}}
</style></head><body>
<header class="topbar"><div class="brand"><span class="brandmark" aria-hidden="true"></span><span>环球模拟盘</span><small>PAPER</small></div><div class="top-actions"><div class="status" id="connection" aria-live="polite"><span class="dot"></span><span id="connectionText">连接行情中</span></div><button class="text-btn" data-action="rules">交易规则 ↗</button></div></header>
<main class="shell"><section class="account" aria-label="模拟账户"><div class="equity"><div class="eyebrow">模拟账户总权益 <span class="sim-label">虚拟资金</span></div><div class="equity-number mono"><span id="equity">100,000.00</span><span class="unit">USDT</span></div><div class="equity-caption" id="accountCaption">初始本金 100,000 USDT · 从这里练习你的下一笔交易</div></div><div class="account-stats"><div><div class="stat-name">可用余额 <span class="tiny">USDT</span></div><div class="stat-value mono" id="freeBalance">100,000.00</div><div class="stat-sub" id="reservedLabel">委托冻结 0.00</div></div><div><div class="stat-name">持仓浮动盈亏</div><div class="stat-value mono" id="unrealized">+0.00</div><div class="stat-sub" id="marginLabel">保证金 0.00</div></div><div><div class="stat-name">已实现盈亏</div><div class="stat-value mono" id="realized">+0.00</div><div class="stat-sub">已平仓净收益 · 含手续费</div></div></div></section>
<div id="quoteWarning" class="quote-warning" role="status" hidden></div>
<div class="market-switch"><div class="asset-market" role="group" aria-label="选择交易市场"><button class="active" data-market="crypto" aria-pressed="true">加密货币</button><button data-market="stock" aria-pressed="false">美股合约 <span class="tiny">28</span></button></div><div id="stockFilters" class="category-filters" role="group" aria-label="美股分类" hidden><button class="active" data-group="all">全部</button><button data-group="chips">半导体 / 芯片</button><button data-group="memory">存储</button><button data-group="software">软件</button><button data-group="mega">大型科技</button></div></div><div class="workspace"><aside class="panel markets" aria-label="币种行情"><div class="panel-head">市场 <span class="muted" id="marketCount">10 个币种</span></div><div class="search-wrap"><input id="marketSearch" type="search" placeholder="搜索代码或名称" aria-label="搜索标的" autocomplete="off"></div><div class="market-head"><span>标的</span><span>参考价 / 涨跌幅</span></div><div id="marketList" class="market-list"></div><div class="market-foot">真实参考行情 · 虚拟资金<br>各自浏览器独立保存模拟账户</div></aside>
<section class="panel chart-panel" aria-label="行情图表"><div class="pair-header"><div class="pair-identity"><span id="pairIcon" class="coin" style="--coin-color:#f7931a">₿</span><div><div class="pair-name"><span id="pairSymbol">BTC</span><span id="pairUnit" class="muted" style="font-weight:400"> / USDT</span></div><div class="pair-type"><span id="instrumentType">模拟永续</span> · <span id="sourceLabel">等待真实行情</span></div></div></div><div class="pair-price"><div class="price-large mono" id="currentPrice">—</div><div class="price-change mono" id="priceChange">24h —</div></div></div><div class="market-stats"><div><label id="highLabel">24h 最高</label><span class="mono" id="highPrice">—</span></div><div><label id="lowLabel">24h 最低</label><span class="mono" id="lowPrice">—</span></div><div><label id="volumeLabel">24h 成交额 / USDT</label><span class="mono" id="quoteVolume">—</span></div></div><div id="quoteQuality" class="data-quality" role="status">等待真实行情</div><div class="chart-toolbar"><div class="timeframes" role="group" aria-label="K线周期"><button class="time-btn active" data-interval="15m" aria-pressed="true">15m</button><button class="time-btn" data-interval="1h" aria-pressed="false">1H</button><button class="time-btn" data-interval="4h" aria-pressed="false">4H</button><button class="time-btn" data-interval="1d" aria-pressed="false">1D</button></div><span class="chart-caption">价格与成交量</span></div><div class="chart-wrap"><canvas id="chart" aria-label="真实历史K线与成交量图"></canvas><div id="chartMessage" class="chart-message">正在获取历史行情…</div></div><div class="chart-note"><span id="chartInfo">拖动图表查看 K 线</span><span id="updateTime">等待报价</span></div></section>
<section class="panel order-panel" aria-label="模拟下单"><div class="order-title"><span>下单</span><span class="mode-pill">逐仓 · USDT 结算</span></div><form id="tradeForm" novalidate><div class="direction" role="group" aria-label="交易方向"><button type="button" class="long active" data-side="long" aria-pressed="true">买入 / 做多</button><button type="button" class="short" data-side="short" aria-pressed="false">卖出 / 做空</button></div><div class="order-types" role="group" aria-label="订单类型"><button type="button" class="active" data-type="market" aria-pressed="true">市价委托</button><button type="button" data-type="limit" aria-pressed="false">限价委托</button></div><div id="limitField" class="field" hidden><label for="limitPrice">委托价格</label><div class="input-wrap"><input id="limitPrice" type="number" inputmode="decimal" min="0" step="any" placeholder="输入价格" autocomplete="off"><span id="limitUnit">USDT</span></div></div><div class="field"><label for="leverage">杠杆倍数 <strong id="leverageValue">10×</strong></label><input id="leverage" class="leverage-range" type="range" min="1" max="100" value="10" aria-label="杠杆倍数"><div class="leverage-presets"><button type="button" data-leverage="1">1×</button><button type="button" class="active" data-leverage="10">10×</button><button type="button" data-leverage="20">20×</button><button type="button" data-leverage="50">50×</button><button type="button" data-leverage="100">100×</button></div></div><div class="field"><label for="margin">投入保证金 <span class="tiny">不含手续费</span></label><div class="input-wrap"><input id="margin" type="number" inputmode="decimal" min="1" step="any" value="1000" placeholder="至少 1 USDT" autocomplete="off"><span>USDT</span></div><div class="percent-row"><button type="button" data-percent="25">25%</button><button type="button" data-percent="50">50%</button><button type="button" data-percent="75">75%</button><button type="button" data-percent="100">100%</button></div><div class="balance-note"><span>可用</span><span class="mono" id="orderAvailable">100,000.00 USDT</span></div></div><button type="button" id="stopToggle" class="stop-toggle" aria-expanded="false" aria-controls="stopFields"><span>止盈 / 止损 <span class="tiny">可选</span></span><span id="stopArrow">＋</span></button><div id="stopFields" class="stop-fields" hidden><div class="field"><label id="takeProfitLabel" for="takeProfit">止盈价 / USDT</label><input id="takeProfit" type="number" inputmode="decimal" step="any" min="0" placeholder="不设置" autocomplete="off"></div><div class="field"><label id="stopLossLabel" for="stopLoss">止损价 / USDT</label><input id="stopLoss" type="number" inputmode="decimal" step="any" min="0" placeholder="不设置" autocomplete="off"></div></div><div class="order-summary"><div class="summary-row"><span>仓位名义价值</span><span id="orderNotional">10,000.00 USDT</span></div><div class="summary-row"><span>预计数量</span><span id="orderQuantity">— BTC</span></div><div class="summary-row"><span id="orderLiqLabel">预估强平参考价</span><span id="orderLiq">—</span></div><div class="summary-row"><span>开仓手续费 <span class="tiny">0.05%</span></span><span id="orderFee">5.00 USDT</span></div></div><div class="high-leverage" id="leverageNotice" hidden>100× 下约 0.45% 的不利波动即可触发模拟强平。</div><p id="orderError" class="error" role="alert"></p><button id="submitOrder" class="submit" type="submit" disabled>等待实时行情</button><div class="order-foot" id="orderBasis">真实币价 · 模拟成交 · 无需连接交易所账户</div></form></section>
<section class="panel positions-panel" aria-label="持仓和交易记录"><div class="positions-header"><div class="position-tabs" role="tablist"><button role="tab" aria-selected="true" class="active" data-tab="positions">持仓<small id="positionCount">0</small></button><button role="tab" aria-selected="false" data-tab="orders">委托<small id="orderCount">0</small></button><button role="tab" aria-selected="false" data-tab="history">历史<small id="historyCount">0</small></button></div><button class="export-btn" id="exportHistory">导出 ↗</button></div><div id="positionContent" role="tabpanel"></div></section></div>
<footer class="footer"><div class="footer-left"><span class="dot" style="background:#6c7889;width:5px;height:5px"></span><span>仅供模拟练习 · 非交易所官方产品 · 无需登录 · 每位访客的数据独立保存在各自浏览器</span></div><div class="footer-right"><button data-action="rules">交易规则</button><button data-action="backup">账户备份</button><button data-action="reset">重置资金</button></div></footer></main>
<div id="toast" class="toast" role="status" aria-live="polite"></div>
<dialog id="rulesDialog"><div class="dialog-head"><h2>开始之前，了解模拟规则</h2><button class="close-dialog" data-close aria-label="关闭">×</button></div><p>每个账户有 <strong style="color:#eaecef">100,000 USDT</strong> 虚拟本金。你可以用 1–100 倍杠杆，在 10 个主流币种与 28 支美股 / ETF 上练习做多与做空。</p><ul><li><strong>价格：</strong>优先取币安公共现货行情，故障时切换 OKX 现货并标注来源。约每 4 秒刷新；使用实际报价时间，超过 30 秒暂停所有成交。这里的价格是模拟参考价，可能与永续合约标记价不同。</li><li><strong>美股合约：</strong>这里是按个股价格计算盈亏的模拟差价合约，不是交易所挂牌期货或期权。美股以 USD 报价，账户按 1 USD = 1 USDT 的虚拟等值结算，不包含真实汇率变动。</li><li><strong>美股行情：</strong>优先腾讯财经，新浪财经作为复核与备用；显示来源与美国东部时间。免费行情可能延迟，延迟 2–20 分钟时明确标注并按该参考价模拟成交；超过 20 分钟、时间错误或双源明显冲突时暂停成交。历史美股 K 线为腾讯前复权数据，与未复权成交参考价区分。</li><li><strong>美股时段：</strong>仅在纽约时间交易日的 09:30–16:00 常规时段撮合，自动处理夏令时、2026–2028 年假日及提前收市。休市可提交限价单，开市并获得有效报价后再撮合。盘前、盘后不模拟成交。</li><li><strong>撮合：</strong>市价按参考价成交；限价做多在价格不高于委托价时成交，做空相反。限价单提前冻结保证金和开仓手续费。</li><li><strong>杠杆与费用：</strong>名义价值 = 保证金 × 杠杆。开、平仓各收名义价值的 0.05% 模拟手续费，暂不计算资金费率和滑点。</li><li><strong>逐仓强平：</strong>当保证金 + 浮动盈亏 ≤ 当前名义价值的 0.5% + 预估平仓费时，按当次报价平仓。不额外收强平费，剩余权益退回；跳空穿仓时损失以该仓保证金为限，不影响其他可用余额。</li><li><strong>后台限制：</strong>止盈、止损、限价与强平由当前页面处理，关闭网页或手机挂起时不会持续运行；重新打开后按最新报价触发，不补算离线期间经过的价格。</li><li><strong>数据：</strong>当前浏览器自动保存，不同设备独立。可导出备份并在其他设备导入；导入会替换本地账户。每个标的可同时开多笔独立仓位。</li></ul><p>这是独立开发的模拟工具，不关联币安账户，所有交易都是虚拟交易。</p><a class="rule-link" href="https://developers.binance.com/docs/binance-spot-api-docs/faqs/market_data_only" target="_blank" rel="noopener noreferrer">币安公共行情说明 ↗</a><a class="rule-link" href="https://www.okx.com/docs-v5/en/" target="_blank" rel="noopener noreferrer">备用行情说明 ↗</a><div class="dialog-buttons"><button class="primary" data-close>知道了，开始练习</button></div></dialog>
<dialog id="backupDialog"><div class="dialog-head"><h2>模拟账户备份</h2><button class="close-dialog" data-close aria-label="关闭">×</button></div><p>备份包含余额、持仓、委托和历史记录。可在另一台设备导入，继续练习。导入会替换本地现有账户。</p><div class="backup-row"><button id="downloadBackup">下载账户备份</button><button id="chooseImport">导入备份</button></div><input id="importFile" type="file" accept="application/json,.json" hidden><p class="small muted">CSV 交易记录可从「历史 → 导出」下载。导入前建议先备份当前账户。</p><div class="dialog-buttons"><button data-close>关闭</button></div></dialog>
<dialog id="confirmDialog"><div class="dialog-head"><h2 id="confirmTitle">确认操作</h2><button class="close-dialog" data-close aria-label="关闭">×</button></div><p id="confirmText"></p><div class="dialog-buttons"><button data-close>取消</button><button id="confirmExecute" class="danger">确认</button></div></dialog>
<dialog id="stopsDialog"><div class="dialog-head"><h2>修改止盈 / 止损</h2><button class="close-dialog" data-close aria-label="关闭">×</button></div><p id="stopsPosition"></p><div class="field"><label id="editTpLabel" for="editTp">止盈价 / USDT</label><input id="editTp" type="number" inputmode="decimal" min="0" step="any" placeholder="留空取消止盈"></div><div class="field"><label id="editSlLabel" for="editSl">止损价 / USDT</label><input id="editSl" type="number" inputmode="decimal" min="0" step="any" placeholder="留空取消止损"></div><p class="small muted">触及设定价后，按当次参考价平仓。强平检查优先。</p><p id="stopsError" class="error" role="alert"></p><div class="dialog-buttons"><button data-close>取消</button><button id="saveStops" class="primary">保存设置</button></div></dialog>
<noscript><p style="padding:30px;text-align:center">请启用 JavaScript 以使用实时行情和模拟交易。</p></noscript>
<!--CLIENT--></body></html>`;
function clientMain(engineFactory, coins, policyFactory) {
 'use strict';
 const E=engineFactory(coins),P=policyFactory(),KEY='crypto-paper-account-v1',LOCK='crypto-paper-account-lock';
 const $=id=>document.getElementById(id),esc=x=>String(x).replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
 const num=(n,d=2)=>Number.isFinite(n)?n.toLocaleString('en-US',{minimumFractionDigits:d,maximumFractionDigits:d}):'—';
 const price=(n,symbol=selected)=>num(n,asset(symbol).market==='stock'?2:n>=100?2:n>=1?3:n>=0.01?5:7),signed=(n,d=2)=>(n>=0?'+':'')+num(n,d);
 const tone=n=>n>=0?'positive':'negative',date=t=>new Date(t).toLocaleString('zh-CN',{month:'2-digit',day:'2-digit',hour:'2-digit',minute:'2-digit',hour12:false});
 const compact=n=>n>=1e9?num(n/1e9)+'B':n>=1e6?num(n/1e6)+'M':n>=1e3?num(n/1e3)+'K':num(n);
 let state=E.fresh(),blocked=false,quotes={},provider='',source='',received=0,wallReceived=0,serverAtReceive=0,loading=false,orderBusy=false;
 let market='crypto',group='all',selected='BTC',side='long',orderType='market',tab='positions',interval='15m',candles=[],candleProvider='',chartToken=0,chartHover=null,chartLoading=false;
 const quoteClocks={},marketLoading={crypto:false,stock:false},marketErrors={crypto:false,stock:false};let stockPollAt=-Infinity;
 let pendingConfirm=null,editingId=null,toastTimer=0,lastQuoteError=false,canvasBounds=null,renderedTab=null,chartSymbol='',chartInterval='';
 function toast(message,bad=false){$('toast').textContent=message;$('toast').className='toast show'+(bad?' bad':'');clearTimeout(toastTimer);toastTimer=setTimeout(()=>$('toast').classList.remove('show'),4500);}
 function readState(){const raw=localStorage.getItem(KEY);if(!raw)return E.fresh();const s=JSON.parse(raw);if(!E.valid(s))throw Error('账户数据无法读取，请导入有效备份或重置账户');return s;}
 try{localStorage.setItem(KEY+'-check','1');localStorage.removeItem(KEY+'-check');state=readState();}
 catch(error){blocked=true;$('quoteWarning').hidden=false;$('quoteWarning').textContent='本地账户存储不可用或数据损坏。请先尝试账户备份、导入或重置；在修复前暂停交易。';}
 try{const pref=JSON.parse(localStorage.getItem(KEY+'-ui')||'{}');if(coins.some(c=>c.symbol===pref.symbol))selected=pref.symbol;}catch{}
 function asset(symbol=selected){return coins.find(c=>c.symbol===symbol)||coins[0];}
 function unit(symbol=selected){return asset(symbol).market==='stock'?'USD':'USDT';}
 function marketNow(kind=asset().market){const c=quoteClocks[kind];return c?c.server+Math.max(0,performance.now()-c.received,Date.now()-c.wall):Date.now();}
 function quality(symbol=selected){return P.assess(asset(symbol),quotes[symbol],marketNow(asset(symbol).market));}
 function freshQuote(symbol){const q=quotes[symbol];return quality(symbol).canTrade?q:null;}
 function activeQuotes(){const out={};for(const c of coins){const q=freshQuote(c.symbol);if(q)out[c.symbol]={...q,canTrade:true};}return out;}
 function assertQuote(symbol){const q=freshQuote(symbol);if(!q)throw Error(quality(symbol).label+'，暂不能按市价成交');return q;}
 function chartSource(){return asset().market==='stock'?'tencent':quotes[selected]?.provider||provider;}

 async function transaction(fn){
  const perform=()=>{
   if(blocked)throw Error('请先修复本地账户存储');
   let next;try{next=readState();}catch{blocked=true;throw Error('账户数据无法读取，请导入有效备份或重置账户');}const result=fn(next);
   next.updatedAt=Date.now();
   try{localStorage.setItem(KEY,JSON.stringify(next));}catch{blocked=true;throw Error('本地保存失败，已暂停交易。请检查浏览器存储或下载账户备份。');}state=next;return result;
  };
  const result=navigator.locks?await navigator.locks.request(LOCK,perform):perform();
  renderAccount();renderPositions();renderOrder();return result;
 }
 function confirmAction(title,message,action,label='确认'){
  pendingConfirm=action;$('confirmTitle').textContent=title;$('confirmText').textContent=message;$('confirmExecute').textContent=label;$('confirmDialog').showModal();
 }
 function download(name,content,type){const blob=new Blob([content],{type});const url=URL.createObjectURL(blob),a=document.createElement('a');a.href=url;a.download=name;document.body.append(a);a.click();a.remove();setTimeout(()=>URL.revokeObjectURL(url),2000);}
 function buildMarkets(){
  const text=$('marketSearch').value.toLowerCase().trim(),filtered=coins.filter(c=>c.market===market&&(group==='all'||c.group===group)&&(c.symbol+' '+c.name).toLowerCase().includes(text));
  $('marketCount').textContent=filtered.length+(market==='stock'?' 支美股 / ETF':' 个币种');
  $('marketList').innerHTML=filtered.map(c=>'<button type="button" class="market-row'+(selected===c.symbol?' selected':'')+'" data-symbol="'+c.symbol+'" aria-label="选择 '+c.symbol+'" aria-pressed="'+(selected===c.symbol)+'"><div class="market-label"><span class="coin'+(c.market==='stock'?' stock-icon':'')+'" style="--coin-color:'+c.color+'">'+c.icon+'</span><div><div class="market-symbol">'+c.symbol+'<span class="muted tiny"> / '+unit(c.symbol)+'</span></div><div class="market-name">'+c.name+'</div></div></div><div class="market-numbers"><div class="market-price" id="mp-'+c.symbol+'">—</div><div class="market-change" id="mc-'+c.symbol+'">—</div></div></button>').join('')||'<div class="market-empty">没有找到这个标的</div>';
  updateMarketNumbers();
 }
 function updateMarketNumbers(){for(const c of coins){const q=quotes[c.symbol],p=$('mp-'+c.symbol),ch=$('mc-'+c.symbol);if(p&&q){p.textContent=price(q.price,c.symbol);ch.textContent=Number.isFinite(q.change)?signed(q.change)+'%':'—';ch.className='market-change '+tone(q.change);}}}
 function renderPair(){
  const c=asset(),q=quotes[selected],stock=c.market==='stock',qualityInfo=quality();
  $('pairIcon').textContent=c.icon;$('pairIcon').classList.toggle('stock-icon',stock);$('pairIcon').style.setProperty('--coin-color',c.color);$('pairSymbol').textContent=c.symbol;$('pairUnit').textContent=' / '+unit();$('limitUnit').textContent=unit();$('takeProfitLabel').textContent='止盈价 / '+unit();$('stopLossLabel').textContent='止损价 / '+unit();$('orderLiqLabel').textContent='预估强平价 / '+unit();
  $('instrumentType').textContent=stock?'美股模拟差价合约':'模拟永续';
  $('sourceLabel').textContent=q?(q.source+(q.verification==='cross_checked'?' · 双源复核':'')):'等待真实行情';
  $('currentPrice').textContent=q?price(q.price):'—';$('currentPrice').className='price-large mono'+(q?' '+tone(q.change):'');
  $('priceChange').textContent=q?signed(q.change)+'%  /  '+(stock?'较昨收':'24h'):(stock?'较昨收 —':'24h —');$('priceChange').className='price-change mono'+(q?' '+tone(q.change):'');
  $('highLabel').textContent=stock?'当日最高':'24h 最高';$('lowLabel').textContent=stock?'当日最低':'24h 最低';$('volumeLabel').textContent=(stock?'当日成交额 / USD':'24h 成交额 / USDT');
  $('highPrice').textContent=q?price(q.high):'—';$('lowPrice').textContent=q?price(q.low):'—';$('quoteVolume').textContent=q&&q.volume>0?compact(q.volume):'—';
  $('quoteQuality').textContent=qualityInfo.label+(stock?' · 仅常规时段撮合 · 美元报价':' · 约每 4 秒更新');$('quoteQuality').className='data-quality '+(qualityInfo.quality==='conflict'||qualityInfo.quality==='stale'?'negative':'');
  $('orderBasis').textContent=stock?'模拟股数 · USD 报价，按 1 USD = 1 USDT 模拟结算':'真实币价 · 模拟成交 · 无需连接交易所账户';
 }
 function renderAccount(){
  const a=E.summary(state,quotes);$('equity').textContent=num(a.equity);$('freeBalance').textContent=num(a.free);$('reservedLabel').textContent='委托冻结 '+num(a.reserved);$('marginLabel').textContent='保证金 '+num(a.margin);
  $('unrealized').textContent=a.unpriced?'待行情恢复':signed(a.unrealized);$('unrealized').className='stat-value mono '+(a.unpriced?'muted':tone(a.unrealized));$('realized').textContent=signed(a.realized);$('realized').className='stat-value mono '+tone(a.realized);
  const anyStale=state.positions.some(p=>['stale','missing','conflict'].includes(quality(p.symbol).quality));
  $('accountCaption').textContent=a.unpriced?'部分持仓尚无报价，总权益暂按该仓保证金估算':anyStale?'行情已过期，总权益与浮动盈亏仅供参考':state.positions.length||state.history.length?'累计净收益 '+signed(a.equity-E.CAPITAL)+' USDT · '+signed((a.equity/E.CAPITAL-1)*100)+'%':'初始本金 100,000 USDT · 从这里练习你的下一笔交易';
 }
 function options(){return {symbol:selected,side,type:orderType,margin:Number($('margin').value),leverage:Number($('leverage').value),limit:Number($('limitPrice').value),tp:$('stopFields').hidden||!$('takeProfit').value?null:Number($('takeProfit').value),sl:$('stopFields').hidden||!$('stopLoss').value?null:Number($('stopLoss').value)};}
 function renderOrder(){
  const o=options(),notional=Number.isFinite(o.margin)&&o.margin>=1?o.margin*o.leverage:NaN,entry=orderType==='limit'?o.limit:quotes[selected]?.price;
  $('leverageValue').textContent=o.leverage+'×';$('leverage').setAttribute('aria-valuetext',o.leverage+' 倍杠杆');
  document.querySelectorAll('[data-leverage]').forEach(b=>{b.classList.toggle('active',+b.dataset.leverage===o.leverage);b.setAttribute('aria-pressed',String(+b.dataset.leverage===o.leverage));});
  $('orderAvailable').textContent=num(state.cash)+' USDT';$('orderNotional').textContent=num(notional)+' USDT';$('orderQuantity').textContent=entry>0&&notional>0?num(notional/entry,6)+' '+(asset().market==='stock'?'股（模拟）':selected):'—';
  $('orderFee').textContent=num(notional*E.FEE)+' USDT';$('orderLiq').textContent=entry>0&&notional>0?price(E.liquidation({entry,qty:notional/entry,margin:o.margin,side})): '—';
  $('leverageNotice').hidden=o.leverage<50;$('leverageNotice').textContent=o.leverage===100?'100× 下约 0.45% 的不利波动即可触发模拟强平。':o.leverage+'× 高杠杆：请留意强平参考价与保证金风险。';
  const info=quality(),queueAllowed=asset().market==='stock'&&orderType==='limit',ready=(!!freshQuote(selected)||queueAllowed)&&!blocked;
  $('submitOrder').disabled=!ready||orderBusy;$('submitOrder').classList.toggle('sell',side==='short');
  $('submitOrder').textContent=orderBusy?'处理中…':!ready?(blocked?'账户存储需修复':asset().market==='stock'?(info.quality==='closed'?'休市 · 可切换限价挂单':'等待有效美股报价'):'等待实时行情'):orderType==='limit'?(side==='long'?'提交模拟做多委托':'提交模拟做空委托'):(side==='long'?(info.quality==='delayed'?'按延迟参考价做多':'模拟买入 / 做多'):(info.quality==='delayed'?'按延迟参考价做空':'模拟卖出 / 做空'));
 }
 function cell(label,value){return '<div><label>'+label+'</label><span>'+value+'</span></div>';}
 function renderPositions(){
  $('positionCount').textContent=state.positions.length;$('orderCount').textContent=state.orders.length;$('historyCount').textContent=state.history.length;
  let result='';
  if(tab==='positions'){
   result=state.positions.slice().reverse().map(p=>{
    const q=quotes[p.symbol],floating=q?E.pnl(p,q.price):null;
    return '<article class="position-card" data-record="'+esc(p.id)+'"><div class="position-top"><div class="position-id"><strong>'+p.symbol+' / '+unit(p.symbol)+'</strong><span class="tag '+(p.side==='long'?'positive':'negative')+'">'+(p.side==='long'?'做多':'做空')+'</span><span class="tag">逐仓 '+p.leverage+'×</span></div><div class="position-profit '+(floating!=null?tone(floating):'')+'">'+(floating!=null?signed(floating):'待报价')+'<small>'+(floating!=null?signed(floating/p.margin*100)+'%':'—')+'</small></div></div><div class="position-grid">'+cell('开仓均价',price(p.entry,p.symbol))+cell('当前参考价',q?price(q.price,p.symbol):'—')+cell('强平参考价',price(E.liquidation(p),p.symbol))+cell('保证金 / USDT',num(p.margin))+cell(asset(p.symbol).market==='stock'?'股数（模拟）':'数量 / '+p.symbol,num(p.qty,6))+cell('止盈 / 止损',(p.tp?price(p.tp,p.symbol):'—')+' / '+(p.sl?price(p.sl,p.symbol):'—'))+'</div><div class="position-actions"><time>'+date(p.time)+(freshQuote(p.symbol)?'':' · '+quality(p.symbol).label)+'</time><div class="actions-group"><button class="outline-btn" data-edit="'+esc(p.id)+'">止盈止损</button><button class="outline-btn" data-close-position="'+esc(p.id)+'"'+(!freshQuote(p.symbol)?' disabled':'')+'>市价平仓</button></div></div></article>';
   }).join('');
  }else if(tab==='orders'){
   result=state.orders.slice().reverse().map(o=>'<article class="position-card" data-record="'+esc(o.id)+'"><div class="position-top"><div class="position-id"><strong>'+o.symbol+' / '+unit(o.symbol)+'</strong><span class="tag '+(o.side==='long'?'positive':'negative')+'">'+(o.side==='long'?'限价做多':'限价做空')+'</span><span class="tag">'+o.leverage+'×</span></div><span class="muted small">等待成交</span></div><div class="position-grid">'+cell('委托价格',price(o.limit,o.symbol))+cell('保证金 / USDT',num(o.margin))+cell('冻结资金 / USDT',num(o.margin+o.fee))+cell('止盈价',o.tp?price(o.tp,o.symbol):'—')+cell('止损价',o.sl?price(o.sl,o.symbol):'—')+'</div><div class="position-actions"><time>'+date(o.time)+'</time><button class="outline-btn" data-cancel="'+esc(o.id)+'">撤销委托</button></div></article>').join('');
  }else{
   result=state.history.slice(0,50).map(h=>'<article class="position-card" data-record="'+esc(h.id)+'"><div class="position-top"><div class="position-id"><strong>'+h.symbol+' / '+unit(h.symbol)+'</strong><span class="tag '+(h.side==='long'?'positive':'negative')+'">'+(h.side==='long'?'做多':'做空')+' '+h.leverage+'×</span><span class="history-reason">'+esc(h.reason||'平仓')+'</span></div><div class="position-profit '+tone(h.net)+'">'+signed(h.net)+'<small>USDT · 已扣手续费</small></div></div><div class="position-grid">'+cell('开仓价',price(h.entry,h.symbol))+cell('平仓价',price(h.exit,h.symbol))+cell('手续费 / USDT',num(h.fees))+'</div><div class="position-actions"><time>'+date(h.time)+' → '+date(h.closedAt)+(h.lossCapped?' · 逐仓损失封顶':'')+'</time></div></article>').join('');
   if(state.history.length>50)result+='<div class="empty-sub" style="padding:15px;text-align:center">显示最近 50 笔，导出可查看全部记录</div>';
  }
  if(!result){const labels={positions:['暂无持仓','选一个标的，开始你的第一笔模拟交易'],orders:['暂无委托','限价委托会在价格满足条件时自动成交'],history:['暂无交易记录','平仓后，这里会记录你的每一笔交易']};result='<div class="empty"><div class="empty-icon" aria-hidden="true">'+(tab==='positions'?'⌁':tab==='orders'?'≡':'↗')+'</div><div class="empty-title">'+labels[tab][0]+'</div><div class="empty-sub">'+labels[tab][1]+'</div></div>';}
  const panel=$('positionContent');
  if(panel.innerHTML===result)return;
  if(renderedTab!==tab||!panel.querySelector('[data-record]')||!result.includes('data-record=')){panel.innerHTML=result;renderedTab=tab;return;}
  const template=document.createElement('template');template.innerHTML=result;
  const oldCards=new Map(Array.from(panel.querySelectorAll('[data-record]')).map(el=>[el.dataset.record,el]));
  const keep=new Set();
  for(const next of Array.from(template.content.children)){
   const key=next.dataset.record,current=key?oldCards.get(key):null;
   if(!current){panel.append(next);if(key)keep.add(key);continue;}
   keep.add(key);
   for(const selector of ['.position-top','.position-grid']){const a=current.querySelector(selector),b=next.querySelector(selector);if(a&&b&&a.innerHTML!==b.innerHTML)a.innerHTML=b.innerHTML;}
   const oldTime=current.querySelector('time'),newTime=next.querySelector('time');if(oldTime&&newTime)oldTime.textContent=newTime.textContent;
   const oldClose=current.querySelector('[data-close-position]'),newClose=next.querySelector('[data-close-position]');if(oldClose&&newClose)oldClose.disabled=newClose.disabled;
  }
  for(const [key,el] of oldCards)if(!keep.has(key))el.remove();
  renderedTab=tab;
 }
 function renderStatus(){
  const q=quotes[selected],info=quality(),stock=asset().market==='stock';
  $('connection').className='status '+(info.canTrade?'live':info.quality==='closed'?'closed':'offline');
  $('connectionText').textContent=stock?(info.quality==='closed'?'美股休市 · 可挂单':info.canTrade?'美股参考行情':'美股报价待恢复'):(info.canTrade?(q?.provider==='binance'?'币安行情 · 已连接':'OKX 备用 · 已连接'):'行情待恢复');
  if(q&&stock){const p=P.parts(q.ts);$('updateTime').textContent=p.month+'/'+p.day+' '+p.hour+':'+p.minute+' ET';}
  else $('updateTime').textContent=q?'报价 '+new Date(q.ts).toLocaleTimeString('zh-CN',{hour12:false}):'等待报价';
  let message='';
  if(blocked)message='本地账户存储不可用或数据损坏，已暂停交易。请检查浏览器存储、导入有效备份或重置账户。';
  else if(stock&&info.quality==='closed')message=info.label+'。当前展示最近常规时段报价；可先挂限价单，待开市且有有效报价时撮合。';
  else if(stock&&info.quality==='delayed')message=info.label+'。模拟订单按画面中的延迟价格成交，不代表此刻真实市场的可成交价格。';
  else if(info.quality==='conflict')message='不同来源的同一时段价格存在显著差异，该标的已暂停成交，等待数据恢复一致。';
  else if(!info.canTrade&&(q||marketErrors[asset().market]))message='有效行情暂不可用，市价与自动成交已暂停。保留的历史报价仅供参考。';
  $('quoteWarning').hidden=!message;$('quoteWarning').textContent=message;
  renderPair();renderOrder();
 }
 async function updateQuotes(kind){
  if(marketLoading[kind]||document.hidden)return;marketLoading[kind]=true;if(kind==='stock')stockPollAt=performance.now();
  try{
   const response=await fetch('/api/quotes?market='+kind,{cache:'no-store',signal:AbortSignal.timeout(22000)});if(!response.ok)throw Error('行情暂不可用');const data=await response.json();
   if(!data.quotes||!data.servedAt)throw Error('行情格式错误');
   const previousChartSource=chartSource();
   for(const item of coins.filter(c=>c.market===kind)){if(data.quotes[item.symbol])quotes[item.symbol]=data.quotes[item.symbol];}
   quoteClocks[kind]={server:data.servedAt,received:performance.now(),wall:Date.now()};marketErrors[kind]=false;
   if(kind==='crypto')provider=data.provider;
   if(!blocked){try{const events=await transaction(s=>E.process(s,activeQuotes()));if(events.length)toast(events.map(e=>e.kind==='filled'?e.symbol+' 委托已成交':e.symbol+' '+e.reason+' '+signed(e.net)+' USDT').slice(0,3).join('；'));}catch(error){toast(error.message,true);}}
   updateMarketNumbers();renderAccount();renderPositions();renderStatus();
   if(asset().market===kind){if(previousChartSource!==chartSource()||!candles.length&&!chartLoading)loadCandles();else drawChart();}
  }catch(error){marketErrors[kind]=true;renderStatus();renderAccount();}
  finally{marketLoading[kind]=false;}
 }
 async function refreshQuotes(){
  if(document.hidden)return;
  const jobs=[updateQuotes('crypto')];if(performance.now()-stockPollAt>=15000)jobs.push(updateQuotes('stock'));await Promise.allSettled(jobs);
 }
 async function loadCandles(){
  if(!chartSource())return;
  const token=++chartToken,requestedSymbol=selected,requestedInterval=interval,requestedProvider=chartSource();
  const retain=candles.length&&chartSymbol===selected&&chartInterval===interval&&candleProvider===chartSource();
  chartLoading=true;chartHover=null;
  if(!retain){candles=[];drawChart();$('chartMessage').hidden=false;$('chartMessage').textContent='正在获取历史行情…';}
  try{
   const response=await fetch('/api/candles?symbol='+requestedSymbol+'&interval='+requestedInterval+'&provider='+requestedProvider,{signal:AbortSignal.timeout(26000)});if(!response.ok)throw Error('K线加载失败');const data=await response.json();if(token!==chartToken)return;
   candles=data.candles;candleProvider=data.provider;chartSymbol=requestedSymbol;chartInterval=requestedInterval;$('chartMessage').hidden=true;
  }catch{if(token!==chartToken)return;if(!retain){$('chartMessage').hidden=false;$('chartMessage').textContent='历史行情暂不可用，稍后自动重试';}}
  finally{if(token===chartToken){chartLoading=false;drawChart();}}
 }
 function drawChart(){
  const canvas=$('chart'),ctx=canvas.getContext('2d'),r=canvas.getBoundingClientRect(),w=r.width,h=r.height,dpr=window.devicePixelRatio||1;
  if(w<1||h<1)return;canvas.width=Math.round(w*dpr);canvas.height=Math.round(h*dpr);ctx.scale(dpr,dpr);ctx.clearRect(0,0,w,h);
  if(!candles.length)return;
  const data=candles.map(c=>({...c})),q=quotes[selected],ms={'15m':900000,'1h':3600000,'4h':14400000,'1d':86400000}[interval],last=data[data.length-1];
  if(asset().market!=='stock'&&candleProvider===provider&&q&&q.ts>=last.time&&q.ts<last.time+ms){last.close=q.price;last.high=Math.max(last.high,q.price);last.low=Math.min(last.low,q.price);}
  const left=10,right=76,top=15,bottom=29,plotW=w-left-right,plotH=(h-top-bottom)*.77,volY=top+plotH+11,volH=Math.max(10,h-bottom-volY),step=plotW/data.length;
  let max=Math.max(...data.map(c=>c.high)),min=Math.min(...data.map(c=>c.low));const pad=(max-min)*.14||max*.002;max+=pad;min-=pad;const y=p=>top+(max-p)/(max-min)*plotH,x=i=>left+(i+.5)*step;
  ctx.font='10px -apple-system, sans-serif';ctx.textAlign='left';
  for(let i=0;i<=4;i++){const value=min+(max-min)*i/4,yy=y(value);ctx.strokeStyle='#242b344d';ctx.beginPath();ctx.moveTo(left,yy);ctx.lineTo(w-right+5,yy);ctx.stroke();ctx.fillStyle='#6a7789';ctx.fillText(price(value),w-right+10,yy+3);}
  const maxVol=Math.max(1,...data.map(c=>c.volume));
  for(let i=0;i<data.length;i++){const c=data[i],up=c.close>=c.open;ctx.strokeStyle=up?'#1bc79b':'#f16477';ctx.fillStyle=ctx.strokeStyle;const xx=x(i),cw=Math.max(1,step*.61);ctx.beginPath();ctx.moveTo(xx,y(c.high));ctx.lineTo(xx,y(c.low));ctx.stroke();ctx.fillRect(xx-cw/2,Math.min(y(c.open),y(c.close)),cw,Math.max(1,Math.abs(y(c.open)-y(c.close))));ctx.globalAlpha=.28;const vh=c.volume/maxVol*volH;ctx.fillRect(xx-cw/2,h-bottom-vh,cw,vh);ctx.globalAlpha=1;}
  for(let i=0;i<4;i++){const idx=Math.round((data.length-1)*i/3),d=new Date(data[idx].time);ctx.fillStyle='#657183';ctx.textAlign=i===3?'right':i===0?'left':'center';ctx.fillText(['1d','1wk','1mo'].includes(interval)?d.toLocaleDateString('zh-CN',{month:'2-digit',day:'2-digit'}):d.toLocaleTimeString('zh-CN',{hour:'2-digit',minute:'2-digit',hour12:false}),x(idx),h-8);}
  if(q&&q.price>=min&&q.price<=max){const yy=y(q.price);ctx.strokeStyle=q.price>=last.open?'#1bc79b88':'#f1647788';ctx.setLineDash([3,4]);ctx.beginPath();ctx.moveTo(left,yy);ctx.lineTo(w-right+3,yy);ctx.stroke();ctx.setLineDash([]);ctx.fillStyle=q.price>=last.open?'#163c34':'#44252e';ctx.fillRect(w-right+6,yy-10,right-8,20);ctx.fillStyle=q.price>=last.open?'#1bc79b':'#f16477';ctx.textAlign='left';ctx.fillText(price(q.price),w-right+10,yy+3);}
  if(chartHover!=null){const i=Math.max(0,Math.min(data.length-1,chartHover)),c=data[i];ctx.strokeStyle='#687487';ctx.setLineDash([3,4]);ctx.beginPath();ctx.moveTo(x(i),top);ctx.lineTo(x(i),h-bottom);ctx.stroke();ctx.setLineDash([]);$('chartInfo').textContent=date(c.time)+' 开 '+price(c.open)+' 收 '+price(c.close);}
  else $('chartInfo').textContent=(asset().market==='stock'?'腾讯 · 前复权':candleProvider==='binance'?'币安现货':'OKX现货')+' K线 · '+interval+' · 可触摸查看';
  canvasBounds={left,step,count:data.length};
 }
 function selectSymbol(symbol){
  if(selected===symbol)return;selected=symbol;try{localStorage.setItem(KEY+'-ui',JSON.stringify({symbol}));}catch{}
  $('marketList').querySelectorAll('[data-symbol]').forEach(b=>{b.classList.toggle('selected',b.dataset.symbol===selected);b.setAttribute('aria-pressed',String(b.dataset.symbol===selected));});
  $('limitPrice').value='';$('takeProfit').value='';$('stopLoss').value='';$('orderError').textContent='';renderPair();renderOrder();renderStatus();loadCandles();
 }
 function syncMarketControls(){
  market=asset().market;
  document.querySelectorAll('[data-market]').forEach(b=>{const active=b.dataset.market===market;b.classList.toggle('active',active);b.setAttribute('aria-pressed',String(active));});
  $('stockFilters').hidden=market!=='stock';
  const periods=market==='stock'?[['1d','日K'],['1wk','周K'],['1mo','月K']]:[['15m','15m'],['1h','1H'],['4h','4H'],['1d','1D']];
  document.querySelectorAll('[data-interval]').forEach((b,i)=>{b.hidden=!periods[i];if(periods[i]){b.dataset.interval=periods[i][0];b.textContent=periods[i][1];b.classList.toggle('active',interval===periods[i][0]);b.setAttribute('aria-pressed',String(interval===periods[i][0]));}});
 }
 function selectMarket(kind){
  if(kind===market)return;market=kind;group='all';$('marketSearch').value='';selected=kind==='stock'?'NVDA':'BTC';interval=kind==='stock'?'1d':'15m';
  document.querySelectorAll('[data-group]').forEach(b=>b.classList.toggle('active',b.dataset.group==='all'));
  try{localStorage.setItem(KEY+'-ui',JSON.stringify({symbol:selected}));}catch{}
  $('limitPrice').value='';$('takeProfit').value='';$('stopLoss').value='';$('orderError').textContent='';
  syncMarketControls();buildMarkets();renderStatus();loadCandles();if(kind==='stock'&&!quotes[selected])updateQuotes('stock');
 }
 document.querySelectorAll('[data-market]').forEach(b=>b.addEventListener('click',()=>selectMarket(b.dataset.market)));
 document.querySelectorAll('[data-group]').forEach(b=>b.addEventListener('click',()=>{group=b.dataset.group;document.querySelectorAll('[data-group]').forEach(x=>x.classList.toggle('active',x===b));buildMarkets();if(group!=='all'&&asset().group!==group){const first=coins.find(c=>c.market===market&&c.group===group);if(first)selectSymbol(first.symbol);}}));
 $('marketSearch').addEventListener('input',buildMarkets);
 $('marketList').addEventListener('click',e=>{const b=e.target.closest('[data-symbol]');if(b)selectSymbol(b.dataset.symbol);});
 document.querySelectorAll('[data-side]').forEach(b=>b.addEventListener('click',()=>{side=b.dataset.side;document.querySelectorAll('[data-side]').forEach(x=>{x.classList.toggle('active',x===b);x.setAttribute('aria-pressed',String(x===b));});$('takeProfit').value='';$('stopLoss').value='';$('orderError').textContent='';renderOrder();}));
 document.querySelectorAll('[data-type]').forEach(b=>b.addEventListener('click',()=>{orderType=b.dataset.type;document.querySelectorAll('[data-type]').forEach(x=>{x.classList.toggle('active',x===b);x.setAttribute('aria-pressed',String(x===b));});$('limitField').hidden=orderType!=='limit';if(orderType==='limit'&&!$('limitPrice').value&&quotes[selected])$('limitPrice').value=String(quotes[selected].price);$('orderError').textContent='';renderOrder();}));
 document.querySelectorAll('[data-leverage]').forEach(b=>b.addEventListener('click',()=>{$('leverage').value=b.dataset.leverage;renderOrder();}));
 for(const id of ['leverage','margin','limitPrice','takeProfit','stopLoss'])$(id).addEventListener('input',()=>{$('orderError').textContent='';renderOrder();});
 document.querySelectorAll('[data-percent]').forEach(b=>b.addEventListener('click',()=>{const leverage=+$('leverage').value;$('margin').value=(Math.floor(state.cash*(+b.dataset.percent/100)/(1+leverage*E.FEE)*100)/100).toFixed(2);$('orderError').textContent='';renderOrder();}));
 $('stopToggle').addEventListener('click',()=>{const expanded=$('stopFields').hidden;$('stopFields').hidden=!expanded;$('stopToggle').setAttribute('aria-expanded',String(expanded));$('stopArrow').textContent=expanded?'−':'＋';renderOrder();});
 $('tradeForm').addEventListener('submit',async e=>{
  e.preventDefault();if(orderBusy)return;orderBusy=true;renderOrder();$('orderError').textContent='';
  try{const o=options();const r=await transaction(s=>{E.process(s,activeQuotes());const q=freshQuote(o.symbol);if(asset(o.symbol).market==='stock'&&o.type==='limit'&&!q)return E.open(s,{...o,queueOnly:true},o.limit);return E.open(s,o,assertQuote(o.symbol).price);});toast(r.kind==='pending'?'模拟限价委托已提交，保证金与手续费已冻结':selected+' 模拟'+(side==='long'?'做多':'做空')+'已开仓');if(r.kind==='pending')setTab('orders');else setTab('positions');}
  catch(error){$('orderError').textContent=error.message;}
  finally{orderBusy=false;renderOrder();}
 });
 function setTab(value){tab=value;document.querySelectorAll('[data-tab]').forEach(b=>{b.classList.toggle('active',b.dataset.tab===tab);b.setAttribute('aria-selected',String(b.dataset.tab===tab));});renderPositions();}
 document.querySelectorAll('[data-tab]').forEach(b=>b.addEventListener('click',()=>setTab(b.dataset.tab)));
 $('positionContent').addEventListener('click',async e=>{
  const close=e.target.closest('[data-close-position]'),cancel=e.target.closest('[data-cancel]'),edit=e.target.closest('[data-edit]');
  try{
   if(close){close.disabled=true;const h=await transaction(s=>{const p=s.positions.find(x=>x.id===close.dataset.closePosition);if(!p)throw Error('该持仓已平仓');const q=assertQuote(p.symbol);return E.close(s,p.id,q.price);});toast('模拟平仓完成，净收益 '+signed(h.net)+' USDT');}
   if(cancel){cancel.disabled=true;await transaction(s=>E.cancel(s,cancel.dataset.cancel));toast('委托已撤销，冻结资金已返还');}
   if(edit){const p=state.positions.find(x=>x.id===edit.dataset.edit);if(!p)return;editingId=p.id;$('editTpLabel').textContent='止盈价 / '+unit(p.symbol);$('editSlLabel').textContent='止损价 / '+unit(p.symbol);$('stopsPosition').textContent=p.symbol+' / USDT · '+(p.side==='long'?'做多':'做空')+' '+p.leverage+'× · 当前参考价 '+(quotes[p.symbol]?price(quotes[p.symbol].price):'—');$('editTp').value=p.tp||'';$('editSl').value=p.sl||'';$('stopsError').textContent='';$('stopsDialog').showModal();}
  }catch(error){toast(error.message,true);if(close)close.disabled=false;if(cancel)cancel.disabled=false;}
 });
 $('saveStops').addEventListener('click',async()=>{
  const button=$('saveStops');button.disabled=true;
  try{
   const tp=$('editTp').value?Number($('editTp').value):null,sl=$('editSl').value?Number($('editSl').value):null;
   await transaction(s=>{const p=s.positions.find(x=>x.id===editingId);if(!p)throw Error('该持仓已经平仓');const q=freshQuote(p.symbol)||(asset(p.symbol).market==='stock'&&quality(p.symbol).quality==='closed'?quotes[p.symbol]:null);if(!q)throw Error('暂无有效参考价，暂不能调整触发价格');if(tp!=null&&(!Number.isFinite(tp)||tp<=0||(p.side==='long'?tp<=q.price:tp>=q.price)))throw Error(p.side==='long'?'止盈价须高于当前参考价':'止盈价须低于当前参考价');if(sl!=null&&(!Number.isFinite(sl)||sl<=0||(p.side==='long'?sl>=q.price:sl<=q.price)))throw Error(p.side==='long'?'止损价须低于当前参考价':'止损价须高于当前参考价');E.updateStops(s,p.id,tp,sl);});$('stopsDialog').close();toast('止盈止损已更新');
  }catch(error){$('stopsError').textContent=error.message;}finally{button.disabled=false;}
 });
 document.querySelectorAll('[data-interval]').forEach(b=>b.addEventListener('click',()=>{if(interval===b.dataset.interval)return;interval=b.dataset.interval;document.querySelectorAll('[data-interval]').forEach(x=>{x.classList.toggle('active',x===b);x.setAttribute('aria-pressed',String(x===b));});loadCandles();}));
 const chart=$('chart');function onPointer(e){if(!canvasBounds)return;chartHover=Math.floor((e.clientX-chart.getBoundingClientRect().left-canvasBounds.left)/canvasBounds.step);drawChart();}
 chart.addEventListener('pointermove',onPointer);chart.addEventListener('pointerdown',onPointer);chart.addEventListener('pointerleave',()=>{chartHover=null;drawChart();});
 new ResizeObserver(drawChart).observe(chart.parentElement);
 document.querySelectorAll('[data-action]').forEach(b=>b.addEventListener('click',()=>{
  if(b.dataset.action==='rules')$('rulesDialog').showModal();
  if(b.dataset.action==='backup')$('backupDialog').showModal();
  if(b.dataset.action==='reset')confirmAction('重置模拟账户？','余额将恢复为 100,000 USDT，当前持仓、委托与历史记录都会清空。建议先下载账户备份。',async()=>{
   const perform=()=>{const next=E.fresh();localStorage.setItem(KEY,JSON.stringify(next));state=next;blocked=false;};
   if(navigator.locks)await navigator.locks.request(LOCK,perform);else perform();renderAccount();renderPositions();renderStatus();toast('账户已重置，开始新一轮练习');
  },'重置为 100,000 USDT');
 }));
 document.querySelectorAll('[data-close]').forEach(b=>b.addEventListener('click',()=>b.closest('dialog').close()));
 document.querySelectorAll('dialog').forEach(d=>d.addEventListener('click',e=>{if(e.target===d){const r=d.getBoundingClientRect();if(e.clientX<r.left||e.clientX>r.right||e.clientY<r.top||e.clientY>r.bottom)d.close();}}));
 $('confirmExecute').addEventListener('click',async()=>{const fn=pendingConfirm;if(!fn)return;pendingConfirm=null;$('confirmExecute').disabled=true;try{await fn();$('confirmDialog').close();}catch(error){toast(error.message||'操作失败',true);}finally{$('confirmExecute').disabled=false;}});
 $('downloadBackup').addEventListener('click',()=>{try{const raw=localStorage.getItem(KEY)||JSON.stringify(state);download('paper-account-'+new Date().toISOString().slice(0,10)+'.json',raw,'application/json');toast('账户备份已生成');}catch(error){toast('备份失败：'+error.message,true);}});
 $('chooseImport').addEventListener('click',()=>$('importFile').click());
 $('importFile').addEventListener('change',async()=>{
  const file=$('importFile').files[0];$('importFile').value='';if(!file)return;
  try{if(file.size>8000000)throw Error('备份文件过大，最多 8 MB');const next=JSON.parse(await file.text());if(!E.valid(next))throw Error('备份格式无效，请选择本站导出的账户 JSON 文件');$('backupDialog').close();confirmAction('导入并替换当前账户？','将载入可用余额 '+num(next.cash)+' USDT、'+next.positions.length+' 笔持仓与 '+next.orders.length+' 笔委托。当前本地账户将被替换。',async()=>{
   const perform=()=>{localStorage.setItem(KEY,JSON.stringify(next));state=next;blocked=false;};if(navigator.locks)await navigator.locks.request(LOCK,perform);else perform();renderAccount();renderPositions();renderStatus();refreshQuotes();toast('备份已导入，正在按最新行情检查持仓');
  },'确认替换');}catch(error){toast(error.message||'导入失败',true);}
 });
 $('exportHistory').addEventListener('click',()=>{
  if(!state.history.length){toast('暂无已平仓记录可导出');return;}
  const header=['币种','方向','杠杆','保证金USDT','数量','开仓价','平仓价','手续费USDT','净收益USDT','平仓原因','开仓时间','平仓时间'];
  const rows=state.history.map(h=>[h.symbol,h.side==='long'?'做多':'做空',h.leverage,h.margin,h.qty,h.entry,h.exit,h.fees,h.net,h.reason,new Date(h.time).toISOString(),new Date(h.closedAt).toISOString()]);
  const csv=[header,...rows].map(row=>row.map(v=>'"'+(typeof v==='number'?String(v):String(v??'').replace(/^[=+@\-]/,c=>"'"+c)).replace(/"/g,'""')+'"').join(',')).join('\r\n');
  download('paper-trades-'+new Date().toISOString().slice(0,10)+'.csv','\ufeff'+csv,'text/csv;charset=utf-8');
 });
 window.addEventListener('storage',e=>{if(e.key!==KEY)return;try{state=readState();blocked=false;renderAccount();renderPositions();renderStatus();}catch{blocked=true;renderStatus();toast('另一页面的账户数据无法读取，已暂停交易',true);}});
 document.addEventListener('visibilitychange',()=>{if(!document.hidden){refreshQuotes();loadCandles();}});
 window.addEventListener('online',refreshQuotes);
 market=asset().market;interval=market==='stock'?'1d':'15m';syncMarketControls();buildMarkets();renderPair();renderAccount();renderPositions();renderOrder();refreshQuotes();
 setInterval(refreshQuotes,4000);setInterval(()=>{if(!document.hidden){renderStatus();renderAccount();renderPositions();}},1000);
 setInterval(()=>{if(!document.hidden&&!chartLoading)loadCandles();},30000);
}
const page=html.replace('<!--CLIENT-->','<script>('+clientMain.toString()+')('+createEngine.toString()+','+JSON.stringify(ASSETS)+','+createMarketPolicy.toString()+');</script>');
export default {
 async fetch(request){
  const url=new URL(request.url);
  if(request.method!=='GET'&&request.method!=='HEAD')return json({error:'仅支持读取行情'},405);
  if(url.pathname==='/api/quotes'){
   const market=url.searchParams.get('market')||'crypto';if(!['crypto','stock'].includes(market))return json({error:'不支持的市场'},400);
   try{return json({...await (market==='stock'?getStockQuotes():getQuotes()),servedAt:Date.now()});}
   catch{return json({error:'真实行情暂不可用，请稍后重试。未提供模拟报价。'},503);}
  }
  if(url.pathname==='/api/candles'){
   const symbol=url.searchParams.get('symbol'),interval=url.searchParams.get('interval')||'15m',provider=url.searchParams.get('provider')||'binance';
   const stock=STOCKS.some(s=>s.symbol===symbol);
   if(stock){if(!['1d','1wk','1mo'].includes(interval))return json({error:'美股支持日、周、月K线'},400);try{return json(await getStockCandles(symbol,interval));}catch{return json({error:'美股历史行情暂不可用'},503);}}
   if(!coinSymbols.includes(symbol)||!['15m','1h','4h','1d'].includes(interval)||!['binance','okx'].includes(provider))return json({error:'不支持的标的或周期'},400);
   try{return json(await getCandles(symbol,interval,provider));}catch{return json({error:'历史行情暂不可用'},503);}
  }
  if(url.pathname==='/api/health')return json({ok:true,mode:'paper',supported:ASSETS.map(s=>s.symbol),crypto:COINS.length,stocks:STOCKS.length,quoteBasis:'spot_and_equity_reference',maxLeverage:100,public:true});
  if(url.pathname!=='/')return new Response('Not found',{status:404,headers:security});
  return new Response(request.method==='HEAD'?null:page,{headers:{...security,'content-type':'text/html; charset=utf-8','cache-control':'no-cache'}});
 }
};
