// Run from CI, or set RADAR_URL / RADAR_EXPECTED_SHA to check a PR preview of the same revision.
const assert = require('node:assert/strict');
const { setTimeout: delay } = require('node:timers/promises');
const { version } = require('../package.json');

const nyDay = (instant) => new Intl.DateTimeFormat('sv-SE', { timeZone: 'America/New_York',
  year: 'numeric', month: '2-digit', day: '2-digit' }).format(instant);
const dashboardPath = '/api/dashboard';
const isoDay = value => typeof value === 'string' && /^\d{4}-\d\d-\d\d$/.test(value)
  && Number.isFinite(Date.parse(value)) && new Date(value).toISOString().startsWith(value + 'T');

async function waitForRelease(api, sha) {
  const deadline = Date.now() + 15 * 60_000;
  let last;
  while (Date.now() < deadline) {
    let data;
    try {
      const response = await fetch(api, { signal: AbortSignal.timeout(20_000), redirect: 'error' });
      if (response.status === 200) data = await response.json();
      last = data ? 'v' + data.productVersion + ' @ ' + data.buildCommit : 'HTTP ' + response.status;
    } catch (error) { last = error.message; }
    if (data?.buildCommit === sha) {
      assert.equal(data.productVersion, version, 'deployed API version must match the checked-out package');
      return;
    }
    console.log('Waiting for deployment; observed:', last);
    await delay(15_000);
  }
  throw Error('Timed out waiting for ' + sha + ' (last observation: ' + last + ')');
}

function assertAgenda(dash, cards, now) {
  const rows = new Map(dash.reminders.map(row => [row.indicatorId, row]));
  const ids = cards.flatMap(c => c.id === 'employment' ? ['unemployment', 'payrolls'] : [c.id]);
  assert.deepEqual(ids.sort(), ['fed','inflation','payrolls','unemployment'], 'missing or duplicate macro events');
  const today = nyDay(now);
  let previous = '', nearest;
  for (const card of cards) {
    const row = rows.get(card.id === 'employment' ? 'unemployment' : card.id);
    assert.ok(row, 'calendar API is missing ' + card.id);
    if (card.id === 'employment') {
      for (const key of ['date','eventAt','source']) assert.equal(row[key], rows.get('payrolls')[key], 'different employment events merged');
    }
    if (row.date != null) assert.ok(isoDay(row.date), 'invalid API date for ' + card.id);
    const date = row.date && row.date >= today ? row.date : null;
    assert.equal(card.date, date, 'calendar date for ' + card.id);
    const source = new URL(card.source);
    assert.equal(source.protocol, 'https:');
    if (card.id === 'fed') {
      assert.equal(source.href, 'https://www.federalreserve.gov/monetarypolicy/fomccalendars.htm');
    } else if (source.origin === 'https://fred.stlouisfed.org') {
      assert.equal(source.pathname, '/releases/calendar');
      assert.equal(source.searchParams.get('rid'), card.id === 'inflation' ? '10' : '50');
    } else {
      assert.equal(source.href, 'https://www.bls.gov/schedule/news_release/' + (card.id === 'inflation' ? 'cpi.htm' : 'empsit.htm'));
    }
    // The browser can convert the BLS .ics link to its corresponding human-readable source page.
    const blsPage = 'https://www.bls.gov/schedule/news_release/' + (card.id === 'inflation' ? 'cpi.htm' : 'empsit.htm');
    assert.equal(source.href, row.source === 'https://www.bls.gov/schedule/news_release/bls.ics' ? blsPage : row.source);
    const stamp = date && row.eventAt ? Date.parse(row.eventAt) : NaN;
    if (date && row.eventAt != null) {
      assert.ok(/(?:Z|[+-]\d\d:\d\d)$/.test(row.eventAt) && Number.isFinite(stamp) && nyDay(stamp) === date, 'invalid or ambiguous eventAt: ' + card.id);
    }
    const beijing = Number.isFinite(stamp) ? new Intl.DateTimeFormat('sv-SE', {timeZone:'Asia/Shanghai', year:'numeric',
      month:'2-digit', day:'2-digit', hour:'2-digit', minute:'2-digit', hourCycle:'h23'}).format(stamp) : null;
    assert.equal(card.beijing, beijing ? '北京时间 ' + beijing : null, 'Beijing date/time for ' + card.id);
    const elapsed = Number.isFinite(stamp) && stamp <= now;
    const order = [!date ? 2 : elapsed ? 1 : 0, date || '', Number.isFinite(stamp) ? new Date(stamp).toISOString() : '~'].join('|');
    assert.ok(order >= previous, 'calendar out of order at ' + card.id); previous = order;
    if (!nearest && date && !elapsed) nearest = {date, stamp};
    assert.equal(card.next, Boolean(nearest && date === nearest.date && !elapsed &&
      (!Number.isFinite(stamp) || !Number.isFinite(nearest.stamp) || stamp === nearest.stamp)), 'incorrect next highlight for ' + card.id);
  }
  assert.ok(nearest, 'no upcoming macro event in the published calendar');
}

function assertEarnings(dash, reviewed, reminders, cards, now) {
  const today = nyDay(now);
  const api = new Map(dash.aiEarnings.map(row => [row.ticker, row]));
  const schedule = dash.reminders.find(row => row.indicatorId === 'aiEarnings').companies;
  const tickers = reviewed.map(row => row.ticker).sort();
  for (const list of [dash.aiEarnings, schedule, reminders, cards]) {
    assert.deepEqual(list.map(r => r.ticker).sort(), tickers, 'company missing or duplicated');
  }
  const future = reviewed.filter(row => row.nextReportStatus === 'confirmed' && row.nextReportDate >= today);
  for (const record of reviewed) {
    const row = api.get(record.ticker);
    const upcoming = future.includes(record);
    assert.equal(row.nextReportStatus === 'confirmed', upcoming, 'unjustified or lost confirmation for ' + record.ticker);
    const label = row.nextReportLabel || row.nextReportDate;
    const statusText = row.nextReportStatus === 'confirmed' ? '公司确认' : row.nextReportStatus === 'pending' ? '待核对'
      : row.nextReportBasis === 'quarterly-fallback' ? '季度推算' : row.nextReportBasis === 'nasdaq' ? 'Nasdaq 预估' : '日期预估';
    if (upcoming) {
      assert.ok(isoDay(row.nextReportDate) && label.includes(row.nextReportDate), record.ticker + ' missing confirmed date');
      for (const key of ['nextReportDate','nextReportLabel','nextReportSource']) assert.equal(row[key], record[key], record.ticker + ' ' + key);
      assert.equal(row.nextReportBasis, 'company');
      assert.equal(new URL(row.nextReportSource).protocol, 'https:');
    }
    const reminder = schedule.find(r => r.ticker === record.ticker);
    assert.deepEqual([reminder.status,reminder.basis,reminder.source,reminder.next],
      [row.nextReportStatus,row.nextReportBasis,row.nextReportSource,label], record.ticker + ' reminder API disagrees');
    for (const ui of [reminders,cards]) {
      const rendered = ui.find(r => r.ticker === record.ticker);
      assert.equal(rendered.status, statusText, record.ticker + ' status');
      assert.equal(rendered.source, row.nextReportSource || null, record.ticker + ' source');
      assert.equal(rendered.label, label, record.ticker + ' schedule label');
    }
  }
  return future.length;
}

async function main() {
  const { chromium, devices } = require('playwright');
  const { aiEarnings } = await import('../earnings-data.mjs');
  const sha = process.env.RADAR_EXPECTED_SHA || process.env.GITHUB_SHA;
  assert.match(sha || '', /^[a-f0-9]{40}$/, 'RADAR_EXPECTED_SHA must be the full deployed git commit');
  const base = new URL(process.env.RADAR_URL || 'https://kk-us-equity-radar.onrender.com');
  assert.ok(!base.username && !base.password && !base.search && !base.hash && base.pathname === '/' &&
    (base.protocol === 'https:' || (base.protocol === 'http:' && ['127.0.0.1','localhost','[::1]'].includes(base.hostname))), 'Use an HTTPS site origin or localhost');
  const api = new URL(dashboardPath, base).href;
  await waitForRelease(api, sha);
  const browser = await chromium.launch({ executablePath: process.env.CHROME_PATH || undefined });
  try {
    const page = await browser.newPage({ ...devices['Pixel 5'], locale: 'zh-CN', timezoneId: 'Asia/Shanghai', serviceWorkers: 'block' });
    const errors = [];
    page.on('pageerror', e => errors.push(e.message));
    await page.route('**/*', route => {
      const req = route.request(), url = new URL(req.url());
      if (!['GET','HEAD'].includes(req.method()) || url.searchParams.has('refresh') || url.searchParams.has('evidence')) {
        errors.push('Unexpected non-read-only request: ' + req.method() + ' ' + url.pathname);
        return route.abort();
      }
      return route.continue();
    });
    const [response] = await Promise.all([
      page.waitForResponse(r => r.url() === api && r.status() === 200, {timeout: 60_000}),
      page.goto(base.href, {waitUntil:'domcontentloaded',timeout:60_000})
    ]);
    const dash = await response.json();
    assert.equal(dash.buildCommit, sha); assert.equal(dash.productVersion, version);
    const footer = await page.locator('footer').innerText();
    assert.equal(footer.match(/\bv(\d+\.\d+\.\d+(?:[-+][\w.-]+)?)/)?.[1], version, 'visible footer version disagrees with API');
    await page.locator('#calendar [data-calendar-id]').first().waitFor();
    await page.locator('#calendar').scrollIntoViewIfNeeded();
    const visible = await page.evaluate(() => {
      const all = (s, root = document) => [...root.querySelectorAll(s)];
      const text = (el,s) => el.querySelector(s)?.textContent.trim();
      const url = (el,s) => el.querySelector(s)?.getAttribute('href') || null;
      return {
        now: Date.now(), overflow: document.documentElement.scrollWidth > innerWidth + 1,
        macro: all('#calendar [data-calendar-id]:not([data-calendar-id="earnings"])').map(el => ({
          id: el.dataset.calendarId, date: el.querySelector('time')?.getAttribute('datetime'), next: el.classList.contains('next-agenda'),
          source: url(el,'a.reminder-source'), beijing: text(el,'.beijing-time') || null
        })),
        reminders: all('#calendar .company-reminder-item').map(el => ({ticker:text(el,'b'),status:text(el,'i'),
          label:text(el,'em:nth-of-type(2)')?.replace(/^下期 /,''),source:url(el,'a')})),
        companies: all('#aiCompanyGrid .ai-company-card').map(el => ({
          ticker:el.querySelector('[data-focus-key^="financial-"]').dataset.focusKey.slice('financial-'.length),
          status:text(el,'.ai-next-report .schedule-status'), label:text(el,'.ai-next-report strong'), source:url(el,'.ai-next-report a')
        }))
      };
    });
    assertAgenda(dash, visible.macro, visible.now);
    const confirmed = assertEarnings(dash, aiEarnings, visible.reminders, visible.companies, visible.now);
    assert.equal(visible.overflow, false, 'horizontal overflow on mobile');
    assert.deepEqual(errors, [], 'browser errors');
    console.log('PASS live mobile Chromium: v%s @ %s; %d macro events; %d companies, %d currently confirmed.', version, sha, visible.macro.length, aiEarnings.length, confirmed);
  } finally { await browser.close(); }
}

if (require.main === module) main().catch(e => { console.error(e.message); process.exitCode = 1; });
module.exports = { assertAgenda, assertEarnings };
