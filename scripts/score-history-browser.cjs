const assert = require('node:assert/strict');
const version = '4.7.0';
const source = date => `https://github.com/closedoor/kk-us-equity-radar/blob/main/evidence/forward/${date}_model-${version}.json`;
const row = (date, score, coverage, baseScore, change) => ({ date, score, coverage, baseScore, change, sourceUrl: source(date) });
const change = (previousDate, totalDelta, baseDelta, adjustmentDelta, gained = [], lost = [], drivers = []) => ({ previousDate, totalDelta, baseDelta, adjustmentDelta, gained, lost, drivers });
// Controlled examples exercise scoring, partial coverage and recovery without asserting market levels.
const records = { version: 1, scoringVersion: version, observations: [
  row('2026-11-11', null, 57, 41.1, change('2026-11-10', null, +0.1, null)),
  row('2026-11-10', null, 57, 41.0, change('2026-11-09', null, -2.0, null, [], ['inflation','fed','unemployment','payrolls'], [{id:'inflation',deltaPoints:-2.5}])),
  row('2026-11-09', 44.4, 90, 43, change('2026-11-06', +0.1, +0.2, -0.1, [], [], [{id:'vix',deltaPoints:0.2}])),
  row('2026-11-06', 44.3, 90, 42.8, null),
] };
module.exports = async function checkHistory({scenario, baseURL, expect}) {
  await scenario('score history loads on demand and separates suspended observations from actual score movements', async page => {
    let calls = 0;
    await page.route('**/api/score-history', route => { calls++; return route.fulfill({json:records}); });
    await page.goto(baseURL);
    const panel = page.locator('#scoreHistory'), content = page.locator('#scoreHistoryContent');
    await expect(panel).not.toHaveAttribute('open', '');
    assert.equal(calls,0);
    await page.locator('a[href="#scoreHistory"]').click();
    await expect(page).toHaveURL(/#scoreHistory$/);
    await expect(panel).toHaveAttribute('open','');
    await expect(content).toContainText('上一次有综合分是 2026-11-09（44.4 分）');
    await expect(content).toContainText('2026-11-11 · 暂停评分');
    const picker = page.getByLabel('查看观察日');
    await picker.selectOption('2026-11-10');
    await expect(content).toContainText('从 44.4 分转为暂停评分');
    await expect(content).toContainText('不再计分：通胀、美联储政策、失业率、非农就业');
    await expect(content).toContainText('覆盖变化也会调整各项贡献');
    await expect(content.getByRole('link')).toHaveAttribute('href',source('2026-11-10'));
    const jump = content.getByRole('button',{name:'查看上一次有分的记录'});
    await jump.focus(); await page.keyboard.press('Enter');
    await expect(picker).toBeFocused(); await expect(picker).toHaveValue('2026-11-09');
    await expect(content).toContainText('综合分变化 +0.1 分');
    await expect(content).toContainText('基础分 +0.2 分；其余修正合计 -0.1 分');
    await expect(content).toContainText('VIX：+0.20 分');
    await panel.locator('summary').click(); await panel.locator('summary').click();
    await expect(picker).toHaveValue('2026-11-09'); assert.equal(calls,1);
    assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth+1));
  },320,740);
  await scenario('score history deep link stays independent on body timeout and retries invalid data without inventing a score', async page => {
    let validResponse = false;
    const at = new Date('2026-11-22T12:00:00Z');
    await page.clock.install({time:at}); await page.clock.pauseAt(at);
    await page.addInitScript(() => {
      const original = window.fetch; let first = true;
      window.fetch = (...args) => {
        if (args[0] === '/api/score-history' && first) { first = false; return Promise.resolve({ok:true, json: () => new Promise((_,reject) => args[1].signal.addEventListener('abort', () => reject(new Error('timeout')), {once:true}))}); }
        return original(...args);
      };
    });
    const bad = structuredClone(records); bad.observations[0].sourceUrl = source('2026-11-09');
    const good = {version:1,scoringVersion:version,observations:[row('2026-11-09',0,100,0,null)]};
    await page.route('**/api/score-history', route => route.fulfill({json: validResponse ? good : bad}));
    await page.goto(`${baseURL}/#scoreHistory`);
    const panel = page.locator('#scoreHistory'), retry=page.locator('#retryScoreHistory');
    await expect(panel).toContainText('正在读取观察记录'); await page.clock.runFor(10_100);
    await expect(retry).toBeVisible(); await expect(panel).toContainText('暂时无法读取历史记录');
    await expect(page.locator('#scoreHistoryContent a')).toHaveCount(0);
    await retry.click(); await expect(retry).toHaveAttribute('aria-disabled','false');
    await expect(panel).toContainText('暂时无法读取历史记录');
    validResponse = true; await retry.focus(); await page.keyboard.press('Enter');
    await expect(panel).toContainText('综合分 0.0，');
    await expect(retry).toBeHidden(); await expect(page.getByLabel('查看观察日')).toBeFocused();
    await expect(page.locator('#indicatorGrid .indicator-card')).toHaveCount(12);
  },390,844);
};
