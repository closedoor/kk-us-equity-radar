const { chromium } = require('playwright');
const assert = require('node:assert/strict');
const { existsSync } = require('node:fs');
(async () => {
 const chrome=['/usr/bin/google-chrome','/usr/bin/google-chrome-stable'].find(existsSync);
 assert(chrome,'runner needs installed Chrome');
 const browser=await chromium.launch({executablePath:chrome});
 try{
  const page=await browser.newPage({viewport:{width:390,height:844}});
  const url='https://kk-us-equity-radar.onrender.com/';
  await page.goto(url,{waitUntil:'domcontentloaded',timeout:65000});
  const dash=await (await page.request.get(url+'api/dashboard')).json();
  assert.equal(dash.buildCommit,'10178bd97551fd5c24dc87bc21d5c6f3118f7a4d');
  await page.getByRole('link',{name:'查看近期评分记录与变化'}).click();
  const pick=page.getByRole('combobox',{name:'查看观察日'});await pick.selectOption('2026-11-10');
  const box=page.locator('#scoreHistoryContent');const message=await box.innerText();
  assert.match(message,/从 44\.4 分转为暂停评分/);assert.match(message,/不再计分：通胀、美联储政策、失业率、非农就业/);
  const source=box.getByRole('link',{name:/查看 2026-11-10 原始记录/});
  const original=await source.getAttribute('href'); assert.equal(original,'https://github.com/closedoor/kk-us-equity-radar/blob/main/evidence/forward/2026-11-10_model-4.7.0.json');
  const popupPromise=page.waitForEvent('popup');await source.click();const popup=await popupPromise;
  await popup.waitForURL(original,{waitUntil:'commit'});await popup.close();
  const raw=await page.request.get('https://raw.githubusercontent.com/closedoor/kk-us-equity-radar/main/evidence/forward/2026-11-10_model-4.7.0.json');assert(raw.ok());const verified=await raw.json();assert.equal(verified.score,null);assert.equal(verified.coverage,57);
  assert(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth+1));
  await page.locator('#scoreHistory').screenshot({path:'live-score-history.png'});
  console.log('PASS actual production 390px: home -> historical date -> actual source; verified v'+dash.productVersion+', 57% and null, no horizontal overflow.');
 }finally{await browser.close();}
})().catch(e=>{console.error(e);process.exitCode=1});
