const assert = require('node:assert/strict');
module.exports=async function({scenario,baseURL,expect,fresh,mock,marketPulseFixture}){
  for(const delayed of ['dashboard','reference']) {
    await scenario('the '+delayed+' may arrive last without conflating model, official close and the archived quote',async page=>{
      const now=new Date('2026-11-22T04:00:00Z');await page.clock.install({time:now});await page.clock.pauseAt(now);
      const data={...fresh(),generatedAt:now.toISOString()},vix=data.indicators.find(r=>r.id==='vix');
      Object.assign(vix,{value:'28.44',date:'2026-11-19',sparkline:[{date:'2026-11-18',value:24.56},{date:'2026-11-19',value:28.44}]});
      let release;const gate=new Promise(r=>release=r);
      await page.route('**/api/dashboard*',async r=>{if(delayed==='dashboard') await gate;await r.fulfill({json:data});});
      await page.route('**/api/market-pulse',async r=>{if(delayed==='reference') await gate;await r.fulfill({json:marketPulseFixture('reference')});});
      try { await page.goto(baseURL);if(delayed==='dashboard')await expect(page.locator('#overview')).toHaveAttribute('data-state','stale');else await expect(page.locator('#indicator-vix')).toContainText('28.44'); }
      finally {release();}
      const v=page.locator('[data-close-symbol="VIX"]'),semi=page.locator('[data-close-symbol="VXSMH"]');
      await expect(page.locator('#pulsePeekVix')).toHaveText('VIX 35.89 · 11/20收盘');
      await expect(page.locator('#pulsePeekVxsmh')).toHaveText('VXSMH 78.16 · 11/20收盘');
      await expect(v).toContainText('结构模型输入：2026-11-19，28.44');await expect(v).toContainText('+26.20%');
      await expect(semi).toContainText('+31.03%');await expect(semi.locator('.close-source')).toHaveAttribute('href',/VXSMH_History\.csv$/);
      await expect(page.locator('.pulse-quote[data-symbol="VIX"] .pulse-quote-reading strong')).toHaveText('19.30');
      await expect(page.locator('[data-kind="volatility"]')).toHaveAttribute('data-level','unconfirmed');
      await page.locator('[data-filter="信用"]').click();await expect(page.locator('#indicator-vix')).toHaveCount(0);
      await v.getByRole('link',{name:'查看 VIX 指标依据'}).focus();await page.keyboard.press('Enter');await expect(page.locator('#indicator-vix')).toBeFocused();
      if(delayed==='reference'){
        vix.date='2026-11-23';vix.sparkline.at(-1).date=vix.date; await page.locator('#refreshButton').click();
        await expect(v.locator('.close-model')).toHaveCount(0);await expect(v).toContainText('35.89');
      }
      assert.ok(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth+1));
    },320,740);
  }
  await scenario('an older manual review retires from the first screen after another completed session',async page=>{
    const now=new Date('2026-11-24T02:00:00Z');await page.clock.install({time:now});await page.clock.pauseAt(now);
    await mock(page,()=>({body:{...fresh(),generatedAt:now.toISOString()}}));await page.route('**/api/market-pulse',r=>r.fulfill({json:marketPulseFixture('reference')}));
    await page.goto(baseURL);await expect(page.locator('#pulsePeekVxsmh')).toHaveText('VXSMH 官网 ↗');
    await expect(page.locator('[data-close-symbol="VXSMH"]')).toContainText('较早收盘 · 尚缺 2026-11-23');
    await expect(page.locator('#pulsePeekStatus')).toContainText('当日压力待判断');
  },390,844);
};
