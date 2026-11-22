const assert = require('node:assert/strict');

module.exports = async function checkAgenda({scenario,baseURL,expect,fresh,mock}) {
  await scenario('mobile risk agenda merges the employment release, gives Beijing time and advances while open', async page=>{
    const now=new Date('2026-12-04T13:29:35.000Z');
    await page.clock.install({time:now}); await page.clock.pauseAt(now);
    const data=fresh(); data.generatedAt=now.toISOString();
    const url='https://www.bls.gov/schedule/news_release/bls.ics', job='2026-12-04T13:30:00.000Z';
    const row=(indicatorId,label,date,event,eventAt=null)=>({indicatorId,label,date,event,eventAt,source:indicatorId==='fed'?'https://www.federalreserve.gov/monetarypolicy/fomccalendars.htm':url,linkLabel:'核对日期',scheduleStatus:'confirmed'});
    data.reminders=[row('inflation','CPI 公布','2026-12-10','美国 11 月 CPI','2026-12-10T13:30:00.000Z'),row('fed','FOMC 利率决议','2026-12-09','决定利率'),row('payrolls','非农就业','2026-12-04','11 月就业报告',job),row('unemployment','失业率','2026-12-04','11 月就业报告',job)];
    data.calendarSync.sources.bls={...data.calendarSync.sources.bls,mode:'bls-live',lastSuccessAt:now.toISOString(),error:null};
    await mock(page,()=>({body:data})); await page.goto(baseURL+'/#calendar');
    const grid=page.locator('#reminderGrid'), jobs=grid.locator('[data-calendar-id="employment"]'), fed=grid.locator('[data-calendar-id="fed"]'), link=jobs.getByRole('link');
    await expect(grid.locator('.reminder-card')).toHaveCount(3);
    await expect(grid.locator('.next-agenda')).toHaveAttribute('data-calendar-id','employment');
    await expect(jobs).toContainText('纽约 2026-12-04 08:30'); await expect(jobs).toContainText('北京时间 2026-12-04 21:30');
    await expect(link).toHaveAttribute('href',/empsit.htm$/);
    await expect(fed).toContainText('具体时刻待核对'); await expect(fed).not.toContainText('北京时间');
    await link.focus(); await page.clock.runFor(61000);
    await expect(grid.locator('.next-agenda')).toHaveAttribute('data-calendar-id','fed');
    await expect(jobs).toContainText('已到计划时刻，实际发布仍需核对'); await expect(link).toBeFocused();
    assert.ok(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth+1));
  },320,740);
};
