const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const path = require("node:path");
const { chromium, expect } = require("playwright/test");

const baseURL = process.env.RADAR_URL || "http://127.0.0.1:4173";
const outputDir = process.env.RADAR_SCREENSHOTS;
const pulseDay = "2026-11-05";
const pulseNow = `${pulseDay}T20:20:00.000Z`;

function marketPulseFixture(mode = "feed") {
  const reference = mode === "reference";
  const at = `${pulseDay}T${reference ? "21:00" : "20:15"}:00.000Z`;
  return { mode, checkedAt: reference ? `${pulseDay}T21:20:00.000Z` : pulseNow, errors: [],
    quotes: [["VIX", 19.3, 17.25], ["VXSMH", 42.1, 9.12], ["SPX", 6635, -3.4], ["RSP", 183, -2.8], ["QQQ", 593, -4.2], ["SMH", 298, -5.6]].map(([symbol, value, changePercent]) => ({
      symbol, value, changePercent, at, date: pulseDay, session: reference ? "close" : "regular",
      source: ["VIX", "VXSMH", "SPX"].includes(symbol)
        ? `https://www.cboe.com/us/indices/dashboard/${symbol.toLowerCase()}/`
        : `https://www.nasdaq.com/market-activity/etf/${symbol.toLowerCase()}`,
    })) };
}

async function main() {
  const fixture = JSON.parse(await fs.readFile(path.join(__dirname, "../dashboard-cache.json"), "utf8"));
  const fresh = () => {
    const data = { ...structuredClone(fixture), generatedAt: new Date().toISOString(), errors: [], refreshing: false };
    for (const source of Object.values(data.calendarSync?.sources || {})) source.error = null;
    return data;
  };
  const browser = await chromium.launch({ executablePath: process.env.CHROME_PATH || undefined });
  let passed = 0;
  async function scenario(name, check, width = 1440, height = 960, options = {}) {
    if (process.env.RADAR_TEST && !name.includes(process.env.RADAR_TEST)) return;
    const context = await browser.newContext({ viewport: { width, height }, ...options });
    const page = await context.newPage();
    const errors = [];
    const failedRequests = [];
    page.on("pageerror", (error) => errors.push(error.message));
    page.on("requestfailed", (request) => failedRequests.push({ url: request.url(), error: request.failure()?.errorText }));
    try {
      await check(page, context);
      assert.deepEqual(errors, [], name);
      console.log(`PASS ${name}`);
      passed += 1;
    } catch (error) {
      console.error(JSON.stringify({ scenario: name, url: page.url(), pageErrors: errors, failedRequests: failedRequests.slice(-10) }));
      if (outputDir) {
        await fs.mkdir(outputDir, { recursive: true });
        await page.screenshot({ path: path.join(outputDir, `failure-${name.replace(/[^a-z0-9]+/gi, "-")}.png`) }).catch(() => {});
      }
      throw error;
    } finally {
      await context.close();
    }
  }
  async function freeze(page) {
    const time = new Date();
    await page.clock.install({ time });
    await page.clock.pauseAt(time);
  }
  async function mock(page, read) {
    const calls = [];
    await page.route("**/api/dashboard*", async (route) => {
      calls.push(route.request().url());
      const { status = 200, body } = read(calls.length);
      await route.fulfill({ status, contentType: "application/json", body: JSON.stringify(body) });
    });
    return calls;
  }
  try {
    for (const width of [320, 390]) {
      await scenario(`product audit: core verdict fits the first mobile viewport at ${width}px`, async (page) => {
        await mock(page, () => ({ body: fresh() }));
        await page.goto(baseURL);
        await expect(page.locator("#indicatorGrid .indicator-card")).toHaveCount(12);
        await page.evaluate(() => document.fonts.ready);
        assert.ok(await page.evaluate(() => ["#pulseTitle", "#pulsePeekStatus", "#pulsePeekVix", "#pulsePeekVxsmh", "#scoreValue", "#verdictLabel"].every((selector) => {
          const box = document.querySelector(selector).getBoundingClientRect();
          return box.top >= document.querySelector(".topbar").getBoundingClientRect().bottom && box.bottom <= innerHeight;
        })), "The pressure summary, structural score and verdict must be readable without scrolling");
        assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1));
        if (outputDir) {
          await fs.mkdir(outputDir, { recursive: true });
          await page.screenshot({ path: path.join(outputDir, `first-viewport-${width}.png`) });
        }
      }, width, 740);
    }
    await scenario("market pulse distinguishes a broad selloff from sector pressure without changing the structure score", async (page) => {
      await page.clock.install({ time: new Date(pulseNow) });
      await page.clock.pauseAt(new Date(pulseNow));
      const data = { ...fresh(), generatedAt: pulseNow };
      for (const row of data.indicators) if (["vix", "breadth", "sp500"].includes(row.id)) row.date = "2026-11-04";
      const dashboardCalls = await mock(page, () => ({ body: data }));
      const pulse = marketPulseFixture();
      await page.route("**/api/market-pulse", (route) => route.fulfill({ json: pulse }));
      await page.goto(baseURL);
      await expect(page.locator("#overview")).toHaveAttribute("data-level", "severe");
      await expect(page.locator("#pulsePeekStatus")).toContainText("大盘急跌");
      await expect(page.locator("#pulsePeekVix")).toContainText("19.30 +17.3%");
      await expect(page.locator("#pulsePeekVxsmh")).toContainText("42.10 +9.1%");
      await expect(page.locator("#structureTiming")).toContainText("2026-11-04");
      await expect(page.locator("#structureTiming")).toContainText("部分日度输入早于纽约今日");
      await expect(page.locator("#indicator-vix")).toContainText("日度模型输入");
      await expect(page.locator("#scoreValue")).toHaveText(/^\d+(?:\.\d+)?$/);
      const score = await page.locator("#scoreValue").textContent();
      const coverage = await page.locator("#coverageValue").textContent();
      await page.locator('#overview a[href="#marketPulse"]').click();
      await expect(page).toHaveURL(/#marketPulse$/);
      await expect(page.locator("#pulseQuotes .pulse-quote")).toHaveCount(6);
      await expect(page.locator('[data-kind="broad"]')).toHaveAttribute("data-level", "severe");
      await expect(page.locator('[data-kind="sector"]')).toHaveAttribute("data-level", "severe");
      const smh = page.locator('.pulse-quote[data-symbol="SMH"]');
      await expect(smh).toContainText("-5.60%");
      await expect(smh.locator("time")).toHaveText("2026-11-05 15:15");
      await expect(smh.locator("a")).toHaveAttribute("href", "https://www.nasdaq.com/market-activity/etf/smh");
      assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1));
      if (outputDir) {
        await fs.mkdir(outputDir, { recursive: true });
        await page.locator("#marketPulse").screenshot({ path: path.join(outputDir, "market-pulse-selloff-320.png"), animations: "disabled" });
      }
      pulse.quotes.find(({ symbol }) => symbol === "RSP").changePercent = -0.4;
      await page.locator("#pulseRefresh").click();
      await expect(page.locator('[data-kind="broad"]')).toHaveAttribute("data-level", "none");
      await expect(page.locator('[data-kind="broad"]')).toContainText("未确认广泛扩散");
      await expect(page.locator('[data-kind="sector"]')).toHaveAttribute("data-level", "severe");
      await expect(page.locator("#scoreValue")).toHaveText(score);
      await expect(page.locator("#coverageValue")).toHaveText(coverage);
      assert.equal(dashboardCalls.length, 1, "Quote refresh must not fetch or replace the dashboard");
    }, 320, 740);
    await scenario("market pulse remains explicitly unconfirmed during a response body timeout and recovers independently", async (page) => {
      await page.clock.install({ time: new Date(pulseNow) });
      await page.clock.pauseAt(new Date(pulseNow));
      await mock(page, () => ({ body: { ...fresh(), generatedAt: pulseNow } }));
      await page.route("**/api/market-pulse", (route) => route.fulfill({ json: marketPulseFixture() }));
      await page.addInitScript(() => {
        const original = window.fetch;
        let stalled = false;
        window.fetch = async (...args) => {
          if (args[0] === "/api/market-pulse" && !stalled) {
            stalled = true;
            return { ok: true, json: () => new Promise((_resolve, reject) => {
              args[1].signal.addEventListener("abort", () => reject(new Error("aborted")), { once: true });
            }) };
          }
          return original(...args);
        };
      });
      await page.goto(baseURL);
      await expect(page.locator("#scoreValue")).toHaveText(/^\d+(?:\.\d+)?$/);
      const score = await page.locator("#scoreValue").textContent();
      await expect(page.locator("#pulsePeekStatus")).toContainText("压力待判断");
      await expect(page.locator('[data-kind="broad"]')).toHaveAttribute("data-level", "unconfirmed");
      await expect(page.locator("#pulsePeekVix")).toHaveText("VIX —");
      await page.clock.runFor(12_100);
      await expect(page.locator("#pulsePeekStatus")).toContainText("报价连接异常");
      await page.locator("#pulseErrors summary").click();
      await expect(page.locator("#pulseErrors li")).toHaveText("报价请求超时。");
      await page.locator("#pulseRefresh").click();
      await expect(page.locator("#overview")).toHaveAttribute("data-state", "current");
      await expect(page.locator("#pulseErrors")).toBeHidden();
      await expect(page.locator("#pulsePeekVix")).toContainText("19.30");
      await expect(page.locator("#scoreValue")).toHaveText(score);
    });
    await scenario("market pulse reference quotes age into dated historical records and are not automatically refreshed", async (page) => {
      const reference = marketPulseFixture("reference");
      const time = new Date(reference.checkedAt);
      await page.clock.install({ time });
      await page.clock.pauseAt(time);
      await mock(page, () => ({ body: { ...fresh(), generatedAt: reference.checkedAt } }));
      let calls = 0;
      await page.route("**/api/market-pulse", (route) => { calls += 1; return route.fulfill({ json: reference }); });
      await page.goto(baseURL);
      await expect(page.locator("#pulsePeekStatus")).toContainText("11/5 收盘参考");
      await expect(page.locator("#pulseStatus")).toContainText("这些数值不会自动更新");
      await expect(page.locator("#pulseRefresh")).toBeHidden();
      await page.clock.fastForward(new Date("2026-11-06T14:31:00Z").getTime() - time.getTime());
      await expect(page.locator("#overview")).toHaveAttribute("data-state", "stale");
      await expect(page.locator("#pulsePeekStatus")).toContainText("历史报价 · 当日压力待判断");
      await expect(page.locator("#pulsePeekVxsmh")).toHaveText("VXSMH —");
      await expect(page.locator("#pulsePeekVxsmh")).toHaveAttribute("href", "https://www.cboe.com/us/indices/dashboard/vxsmh/");
      const vxsmh = page.locator('.pulse-quote[data-symbol="VXSMH"]');
      await expect(vxsmh).toContainText("42.10");
      await expect(vxsmh).toContainText("历史记录");
      await expect(vxsmh.locator("time")).toHaveText("2026-11-05 16:00");
      assert.equal(calls, 1, "Historical reference snapshots must not advertise feed-like updates");
    });
    await scenario("product audit: stale manual judgments are disclosed and explicitly reconfirmed", async (page) => {
      await freeze(page);
      const updatedAt = new Date(Date.now() - 60 * 86_400_000).toISOString();
      await page.addInitScript((value) => {
        if (!localStorage.getItem("bearRadarOverrides")) localStorage.setItem("bearRadarOverrides", JSON.stringify({ earningsBreadth: { risk: 0, note: "old manual judgment", updatedAt: value } }));
      }, updatedAt);
      await mock(page, () => ({ body: fresh() }));
      await page.goto(baseURL);
      await expect(page.locator("#scoreDelta")).toContainText("1 项人工");
      await expect(page.locator("#manualScoreNote")).toContainText("建议复核");
      const before = await page.locator("#scoreValue").textContent();
      await page.locator("#reviewManualButton").click();
      const field = page.locator('[data-id="earningsBreadth"]');
      await expect(field.locator(".manual-risk")).toHaveValue("0");
      await page.locator("#manualForm .primary-button").click();
      assert.equal(await page.evaluate(() => JSON.parse(localStorage.getItem("bearRadarOverrides")).earningsBreadth.updatedAt), updatedAt);
      await expect(page.locator("#manualScoreNote")).toContainText("建议复核");
      await page.locator("#reviewManualButton").click();
      await field.locator(".manual-reconfirm-input").check();
      await page.locator("#manualForm .primary-button").click();
      await expect(page.locator("#manualScoreNote")).not.toContainText("建议复核");
      await expect(page.locator("#scoreValue")).toHaveText(before);
      const stored = await page.evaluate(() => JSON.parse(localStorage.getItem("bearRadarOverrides")).earningsBreadth);
      assert.equal(stored.risk, 0);
      assert.ok(Date.parse(stored.updatedAt) > Date.parse(updatedAt));
      await page.reload();
      await expect(page.locator("#manualScoreNote")).not.toContainText("建议复核");
    });
    await scenario("product audit: manual values with unknown dates stay visible for review", async (page) => {
      await page.addInitScript(() => localStorage.setItem("bearRadarOverrides", JSON.stringify({ aiEarnings: { risk: 0, note: "legacy value" } })));
      await mock(page, () => ({ body: fresh() }));
      await page.goto(baseURL);
      await expect(page.locator("#manualScoreNote")).toContainText("确认日期未知");
      await expect(page.locator("#indicator-aiEarnings .metric-value")).toHaveText("0/100");
      await page.locator("#reviewManualButton").click();
      await expect(page.locator('[data-id="aiEarnings"] .manual-reviewed-at')).toContainText("日期未知");
      await page.locator("#clearManual").click();
      await page.locator("#closeManual").click();
      await expect(page.locator("#manualScoreNote")).toBeHidden();
      await expect(page.locator("#manualButton")).toBeFocused();
    });
    for (const [width, height] of [[320, 740], [640, 360]]) {
      await scenario(`product audit: manual review remains usable in a ${width}x${height} viewport`, async (page) => {
        const updatedAt = new Date(Date.now() - 60 * 86_400_000).toISOString();
        await page.addInitScript((value) => localStorage.setItem("bearRadarOverrides", JSON.stringify({ earningsBreadth: { risk: 0, note: "review needed", updatedAt: value } })), updatedAt);
        await mock(page, () => ({ body: fresh() }));
        await page.goto(baseURL);
        await expect(page.locator("#manualScoreNote")).toContainText("建议复核");
        await page.locator("#reviewManualButton").click();
        const dialog = page.getByRole("dialog", { name: "补充专业数据" });
        const box = await dialog.boundingBox();
        assert.ok(box && box.x >= 0 && box.y >= 0 && box.x + box.width <= width && box.y + box.height <= height);
        await page.locator('[data-id="earningsBreadth"] .manual-reconfirm-input').check();
        if (outputDir) {
          await fs.mkdir(outputDir, { recursive: true });
          await dialog.screenshot({ path: path.join(outputDir, `manual-review-${width}x${height}.png`) });
        }
        await page.locator("#manualForm .primary-button").click();
        await expect(dialog).toBeHidden();
        await expect(page.locator("#manualScoreNote")).not.toContainText("建议复核");
        await expect(page.locator("#reviewManualButton")).toBeFocused();
      }, width, height);
    }
    for (const width of [1440, 390, 320]) {
      await scenario(`live layout ${width}px`, async (page) => {
        await page.goto(baseURL);
        await expect(page.locator("#indicatorGrid .indicator-card")).toHaveCount(12);
        await expect(page.locator("#aiCompanyGrid .ai-company-card")).toHaveCount(8);
        await expect(page.locator("#reminderGrid .reminder-card")).toHaveCount(5);
        await expect(page.locator("#liveText")).toBeVisible();
        assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1));
        await page.locator('[data-filter="信用"]').click();
        await expect(page.locator("#indicatorGrid .indicator-card")).toHaveCount(fixture.indicators.filter((row) => row.category === "信用").length);
        await page.locator('[data-filter="全部"]').click();
        await expect(page.locator("#indicatorGrid .indicator-card")).toHaveCount(12);
        if (outputDir) {
          await fs.mkdir(outputDir, { recursive: true });
          await page.evaluate(() => window.scrollTo({ top: 0, behavior: "instant" }));
          await page.screenshot({ path: path.join(outputDir, `overview-${width}.png`) });
          await page.locator("#calendar").screenshot({ path: path.join(outputDir, `calendar-${width}.png`) });
          await page.screenshot({ path: path.join(outputDir, `radar-${width}.png`), fullPage: true });
        }
      }, width);
    }
    await scenario("cold start keeps polling beyond twelve attempts", async (page) => {
      await freeze(page);
      let ready = false;
      const calls = await mock(page, () => ready ? { body: fresh() } : { status: 202, body: { warming: true } });
      await page.goto(baseURL);
      await expect(page.locator("#liveText")).toHaveText("正在同步首批数据");
      for (let attempt = 0; attempt < 15; attempt += 1) {
        if (attempt === 14) ready = true;
        await page.clock.runFor([2500, 5000, 10000, 15000][Math.min(attempt, 3)]);
        await expect.poll(() => calls.length).toBe(attempt + 2);
        await expect(page.locator("#refreshButton")).toBeEnabled();
      }
      await expect(page.locator("#indicatorGrid .indicator-card")).toHaveCount(12);
      await expect(page.locator("#liveText")).toHaveText("已连接 · 数据已更新");
    });
    await scenario("manual refresh returns a usable snapshot then follows background completion", async (page) => {
      await freeze(page);
      let updating = false;
      const calls = await mock(page, () => ({ body: { ...fresh(), refreshing: updating } }));
      await page.goto(baseURL);
      await expect(page.locator("#indicatorGrid .indicator-card")).toHaveCount(12);
      updating = true;
      await page.locator("#refreshButton").click();
      await expect(page.locator("#liveText")).toContainText("后台更新中");
      await expect(page.locator("#refreshButton")).toBeEnabled();
      await page.locator("#manualButton").click();
      await page.locator('[data-id="aiEarnings"] .manual-risk').fill("42");
      updating = false;
      await page.clock.runFor(2500);
      await expect(page.locator("#liveText")).toHaveText("已连接 · 数据已更新");
      await expect(page.locator('[data-id="aiEarnings"] .manual-risk')).toHaveValue("42");
      assert.equal(calls.filter((url) => url.includes("refresh=1")).length, 1);
      assert.equal(calls.length, 3);
    });
    await scenario("hidden pages pause polling and resume unfinished work when visible", async (page) => {
      await freeze(page);
      await page.addInitScript(() => {
        Object.defineProperty(document, "visibilityState", { configurable: true, get: () => window.testHidden ? "hidden" : "visible" });
      });
      let updating = true;
      const calls = await mock(page, () => ({ body: { ...fresh(), refreshing: updating } }));
      await page.goto(baseURL);
      await expect(page.locator("#liveText")).toContainText("后台更新中");
      await page.evaluate(() => { window.testHidden = true; document.dispatchEvent(new Event("visibilitychange")); });
      await page.clock.runFor(20000);
      assert.equal(calls.length, 1);
      updating = false;
      await page.evaluate(() => { window.testHidden = false; document.dispatchEvent(new Event("visibilitychange")); });
      await expect(page.locator("#liveText")).toHaveText("已连接 · 数据已更新");
      assert.equal(calls.length, 2);
    });
    await scenario("bad payload preserves the last snapshot and retries without losing the filter", async (page) => {
      await freeze(page);
      let broken = false;
      await mock(page, () => ({ body: broken ? { ...fresh(), scoringContext: null } : fresh() }));
      await page.goto(baseURL);
      await expect(page.locator("#indicatorGrid .indicator-card")).toHaveCount(12);
      const before = await page.locator("#scoreValue").textContent();
      broken = true;
      await page.locator("#refreshButton").click();
      await expect(page.locator("#errorBanner")).toContainText("数据格式异常");
      await expect(page.locator("#scoreValue")).toHaveText(before);
      await page.locator('[data-filter="信用"]').click();
      await expect(page.locator("#errorBanner")).toBeVisible();
      broken = false;
      await page.clock.runFor(15000);
      await expect(page.locator("#errorBanner")).toBeHidden();
      await expect(page.locator('[data-filter="信用"]')).toHaveAttribute("aria-pressed", "true");
    });
    for (const [name, corrupt] of [
      ["nested malformed payload cannot replace the last complete display", (data) => { data.aiEarnings[0].guidanceTone = { toString: null }; }],
      ["malformed saved calendar cannot replace the last complete display", (data) => { data.calendarSchedule.earnings.NVDA = { date: "2026-11-18", timing: { toString: null } }; }],
    ]) await scenario(name, async (page) => {
      await freeze(page);
      const valid = fresh();
      const broken = structuredClone(valid);
      corrupt(broken);
      broken.indicators[0].title = "should not replace the previous board";
      const calls = await mock(page, (count) => ({ body: count === 2 ? broken : valid }));
      await page.goto(baseURL);
      await expect(page.locator("#indicatorGrid .indicator-card")).toHaveCount(12);
      const before = await page.locator("#scoreValue").textContent();
      await page.locator("#refreshButton").click();
      await expect(page.locator("#errorBanner")).toContainText("数据格式异常");
      await expect(page.locator("#scoreValue")).toHaveText(before);
      await expect(page.locator("#indicator-oil .card-title")).toHaveText(valid.indicators[0].title);
      await page.clock.runFor(15_000);
      await expect.poll(() => calls.length).toBe(3);
      await expect(page.locator("#errorBanner")).toBeHidden();
      await expect(page.locator("#indicatorGrid .indicator-card")).toHaveCount(12);
    });
    await scenario("refresh button retains keyboard focus after manual and background updates", async (page) => {
      await freeze(page);
      const calls = [];
      let release;
      await page.route("**/api/dashboard*", async (route) => {
        calls.push(route.request().url());
        if (calls.length >= 2) await new Promise((resolve) => { release = resolve; });
        await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(fresh()) });
      });
      await page.goto(baseURL);
      await expect(page.locator("#indicatorGrid .indicator-card")).toHaveCount(12);
      const refresh = page.locator("#refreshButton");
      await refresh.focus();
      await page.keyboard.press("Enter");
      await expect.poll(() => calls.length).toBe(2);
      await expect(refresh).toBeDisabled();
      release();
      await expect(refresh).toBeEnabled();
      await expect(refresh).toBeFocused();
      await page.clock.runFor(15 * 60 * 1000);
      await expect.poll(() => calls.length).toBe(3);
      await expect(refresh).toBeDisabled();
      release();
      await expect(refresh).toBeEnabled();
      await expect(refresh).toBeFocused();
      await page.keyboard.press("Enter");
      await expect.poll(() => calls.length).toBe(4);
      await expect(refresh).toBeDisabled();
      const other = page.getByRole("link", { name: "重要日期", exact: true });
      await other.focus();
      release();
      await expect(refresh).toBeEnabled();
      await expect(other).toBeFocused();
    });
    await scenario("a stalled response body times out and recovers automatically", async (page) => {
      await freeze(page);
      await mock(page, () => ({ body: fresh() }));
      await page.addInitScript(() => {
        const original = window.fetch;
        window.fetch = async (...args) => {
          if (window.testStall && String(args[0]).startsWith("/api/dashboard")) {
            return { ok: true, status: 200, json: () => new Promise((resolve, reject) => {
              args[1].signal.addEventListener("abort", () => reject(new Error("aborted")), { once: true });
            }) };
          }
          return original(...args);
        };
      });
      await page.goto(baseURL);
      await expect(page.locator("#indicatorGrid .indicator-card")).toHaveCount(12);
      await page.evaluate(() => { window.testStall = true; });
      await page.locator("#refreshButton").click();
      await expect(page.locator("#refreshButton")).toBeDisabled();
      await page.clock.runFor(30000);
      await expect(page.locator("#errorBanner")).toContainText("超时");
      await expect(page.locator("#refreshButton")).toBeEnabled();
      await page.evaluate(() => { window.testStall = false; });
      await page.clock.runFor(15000);
      await expect(page.locator("#errorBanner")).toBeHidden();
      await expect(page.locator("#indicatorGrid .indicator-card")).toHaveCount(12);
    });
    await scenario("first-load outage retries and network reconnection recovers", async (page, context) => {
      await freeze(page);
      let failed = true;
      await mock(page, () => failed ? { status: 503, body: {} } : { body: fresh() });
      await page.goto(baseURL);
      await expect(page.locator("#errorBanner")).toContainText("503");
      await expect(page.locator("#verdictLabel")).toHaveText("连接失败");
      await expect(page.locator("#scoreGauge")).toHaveAttribute("aria-label", "综合结构风险分暂不可用");
      assert.ok(await page.locator("#errorBanner").evaluate((element) => element.getBoundingClientRect().top < innerHeight));
      failed = false;
      await page.clock.runFor(15000);
      await expect(page.locator("#indicatorGrid .indicator-card")).toHaveCount(12);
      await context.setOffline(true);
      await page.unroute("**/api/dashboard*");
      await page.locator("#refreshButton").click();
      await expect(page.locator("#errorBanner")).toBeVisible();
      await mock(page, () => ({ body: fresh() }));
      await context.setOffline(false);
      await expect(page.locator("#errorBanner")).toBeHidden();
    });
    await scenario("manual zero persists and source text cannot inject markup", async (page) => {
      const data = fresh();
      const unavailable = data.indicators.find((row) => !row.available);
      unavailable.unavailableReason = '<img src=x onerror="window.injected=true">';
      await mock(page, () => ({ body: data }));
      await page.goto(baseURL);
      await expect(page.locator("#indicatorGrid .indicator-card")).toHaveCount(12);
      assert.equal(await page.locator("#indicatorGrid img").count(), 0);
      const baselineCoverage = Number((await page.locator("#coverageValue").textContent()).replace("%", ""));
      await page.locator("#manualButton").click();
      await page.locator('[data-id="earningsBreadth"] .manual-risk').fill("0");
      await page.locator('[data-id="earningsBreadth"] .manual-note').fill("browser regression");
      await page.locator('#manualForm button[value="default"]').click();
      await expect(page.locator("#indicator-earningsBreadth .risk-chip")).toHaveText("人工覆盖");
      await expect(page.locator("#coverageValue")).toHaveText(`${baselineCoverage + unavailable.weight}%`);
      await page.reload();
      await expect(page.locator("#indicator-earningsBreadth .metric-value")).toHaveText("0/100");
      await page.locator("#manualButton").click();
      await page.locator("#clearManual").click();
      await page.locator('#manualForm button[value="cancel"]').click();
      await expect(page.locator("#coverageValue")).toHaveText(`${baselineCoverage}%`);
      assert.equal(await page.evaluate(() => Boolean(window.injected)), false);
    });
    await scenario("partial market and calendar failures are visible from the overview", async (page) => {
      await freeze(page);
      let mode = "market";
      await mock(page, () => {
        const data = fresh();
        data.calendarSync.sources = Object.fromEntries(Object.entries(data.calendarSync.sources).map(([key, source]) => [key, { ...source, error: mode === "calendar" && key === "bls" ? "calendar unavailable" : null }]));
        if (mode === "market") data.errors = ["Oil source unavailable"];
        return { body: data };
      });
      await page.goto(baseURL);
      await expect(page.locator("#liveText")).toContainText("部分");
      await expect(page.locator(".live-pill")).toHaveAttribute("data-state", "updating");
      await expect(page.locator("#errorBanner")).toBeVisible();
      assert.ok(await page.locator("#errorBanner").evaluate((element) => element.getBoundingClientRect().top < innerHeight));
      mode = "calendar";
      await page.locator("#refreshButton").click();
      await expect(page.locator("#liveText")).toContainText("日程");
      await expect(page.locator(".live-pill")).toHaveAttribute("data-state", "updating");
      await expect(page.locator("#errorBanner")).toContainText("日程");
      mode = "healthy";
      await page.locator("#refreshButton").click();
      await expect(page.locator("#liveText")).toHaveText("已连接 · 数据已更新");
      await expect(page.locator("#errorBanner")).toBeHidden();
    });
    await scenario("financial cards retain historical dates and distinguish schedule evidence", async (page) => {
      const data = fresh();
      for (let index = 0; index < 3; index += 1) {
        Object.assign(data.aiEarnings[index], { nextReportDate: "2026-12-15", nextReportLabel: "2026-12-15", nextReportStatus: index === 0 ? "confirmed" : "estimated", nextReportBasis: ["company", "nasdaq", "quarterly-fallback"][index] });
      }
      Object.assign(data.aiEarnings[3], { released: "2026-01-01", snapshotStale: true });
      data.reminders[4].companies = data.aiEarnings.map((row) => ({ ticker: row.ticker, released: row.released, next: row.nextReportLabel, status: row.nextReportStatus, basis: row.nextReportBasis }));
      await mock(page, () => ({ body: data }));
      await page.goto(baseURL);
      const cards = page.locator(".ai-company-card");
      for (const [index, label] of ["公司确认", "Nasdaq 预估", "季度推算"].entries()) {
        await expect(cards.nth(index).locator(".schedule-status")).toHaveText(label);
        await expect(page.locator(".company-reminder-item").nth(index).locator("i")).toHaveText(label);
      }
      await expect(cards.nth(3).locator("time")).toContainText("2026-01-01");
      await expect(cards.nth(3).locator(".ai-readout")).toContainText("历史表现");
      await expect(cards.nth(3).locator(".ai-readout")).toContainText("历史指引");
    });
    for (const width of [1440, 320]) {
      await scenario(`scoring method exposes current weights and supported regimes at ${width}px`, async (page) => {
        const data = fresh();
        data.indicators.forEach((row) => { row.points = 999; });
        await mock(page, () => ({ body: data }));
        await page.goto(baseURL);
        await expect(page.locator("#indicatorGrid .indicator-card")).toHaveCount(12);
        await page.locator("#scoreMethodology summary").click();
        await expect(page.locator('[data-weight-id="aiEarnings"] td').first()).toHaveText("5%");
        await expect(page.locator('[data-weight-id="credit"] td').first()).toHaveText("15%");
        await expect(page.locator('[data-weight-id="breadth"] td').first()).toHaveText("10%");
        await expect(page.locator("#methodologyContent")).toContainText("并非下跌概率");
        await expect(page.locator("#methodologyContent")).toContainText("模型 4.7.0");
        await expect(page.locator(".regime-coverage li")).toHaveCount(3);
        assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1));
        await page.locator("#manualButton").click();
        await page.locator('[data-id="aiEarnings"] .manual-risk').fill("100");
        await page.locator('[data-id="aiEarnings"] .manual-risk').press("Enter");
        await expect(page.locator('[data-weight-id="aiEarnings"] td').last()).toHaveText("人工覆盖");
        await expect(page.locator("#indicator-aiEarnings .score-points")).toContainText("5.0 / 5");
        await expect(page.locator("#scoreMethodology")).toHaveAttribute("open", "");
        if (outputDir) {
          await fs.mkdir(outputDir, { recursive: true });
          await page.locator("#scoreMethodology").screenshot({ path: path.join(outputDir, `methodology-${width}.png`) });
        }
      }, width);
    }
    await scenario("an unsupported market regime is disclosed without inflating total risk", async (page) => {
      const data = fresh();
      data.indicators.forEach((row) => {
        row.available = !["breadth", "sp500", "earningsBreadth"].includes(row.id);
        row.risk = row.available ? row.id === "vix" ? 100 : 0 : null;
        row.points = row.available ? row.risk * row.weight / 100 : null;
      });
      data.aiEarnings.forEach((row) => { row.snapshotStale = true; });
      await mock(page, () => ({ body: data }));
      await page.goto(baseURL);
      await expect(page.locator("#regimeUpliftValue")).toHaveText("+0.0");
      assert.equal(await page.locator("#scoreValue").textContent(), await page.locator("#baseScoreValue").textContent());
      await expect(page.locator("#marketBreakValue")).toHaveText("--");
      await page.locator("#scoreMethodology summary").click();
      await expect(page.locator('[data-regime-id="marketBreak"]')).toContainText("1 项有效");
      await expect(page.locator('[data-regime-id="marketBreak"]')).toContainText("不参与主导修正");
    });
    await scenario("keyboard Enter saves manual input and Escape discards a draft", async (page) => {
      await mock(page, () => ({ body: fresh() }));
      await page.goto(baseURL);
      await expect(page.locator("#indicatorGrid .indicator-card")).toHaveCount(12);
      await page.locator("#manualButton").click();
      const input = page.locator('[data-id="earningsBreadth"] .manual-risk');
      await input.fill("101");
      await input.press("Enter");
      await expect(page.locator("#manualDialog")).toBeVisible();
      await input.fill("0");
      await input.press("Enter");
      await expect(page.locator("#manualDialog")).toBeHidden();
      await expect(page.locator("#indicator-earningsBreadth .metric-value")).toHaveText("0/100");
      await page.locator("#manualButton").click();
      await input.fill("75");
      await input.press("Escape");
      await expect(page.locator("#indicator-earningsBreadth .metric-value")).toHaveText("0/100");
      await page.reload();
      await expect(page.locator("#indicator-earningsBreadth .metric-value")).toHaveText("0/100");
    });
    await scenario("manual edits synchronize across tabs without overwriting untouched draft fields", async (page, context) => {
      const other = await context.newPage();
      const otherErrors = [];
      other.on("pageerror", (error) => otherErrors.push(error.message));
      await mock(page, () => ({ body: fresh() }));
      await mock(other, () => ({ body: fresh() }));
      await page.goto(baseURL);
      await other.goto(baseURL);
      await expect(page.locator("#indicatorGrid .indicator-card")).toHaveCount(12);
      await page.locator("#manualButton").click();
      await page.locator('[data-id="aiEarnings"] .manual-risk').fill("42");
      await other.locator("#manualButton").click();
      await other.locator('[data-id="earningsBreadth"] .manual-risk').fill("80");
      await other.locator('#manualForm button[value="default"]').click();
      await expect(page.locator("#indicator-earningsBreadth .metric-value")).toHaveText("80/100");
      await expect(page.locator('[data-id="aiEarnings"] .manual-risk')).toHaveValue("42");
      await page.locator('#manualForm button[value="default"]').click();
      await expect(page.locator("#indicator-earningsBreadth .metric-value")).toHaveText("80/100");
      await expect(other.locator("#indicator-aiEarnings .metric-value")).toHaveText("42/100");
      await page.reload();
      await expect(page.locator("#indicator-aiEarnings .metric-value")).toHaveText("42/100");
      await other.locator("#manualButton").click();
      await other.locator("#clearManual").click();
      await expect(page.locator("#indicator-aiEarnings .risk-chip")).not.toHaveText("人工覆盖");
      await expect(page.locator("#indicator-earningsBreadth .risk-chip")).not.toHaveText("人工覆盖");
      assert.deepEqual(otherErrors, []);
    });
    await scenario("manual saves merge another tab's edit before its storage event arrives", async (page, context) => {
      const updatedAt = new Date().toISOString();
      await page.addInitScript((value) => localStorage.setItem("bearRadarOverrides", JSON.stringify({
        aiEarnings: { risk: 20, note: "AI", updatedAt: value },
        earningsBreadth: { risk: 40, note: "EPS", updatedAt: value },
      })), updatedAt);
      const other = await context.newPage();
      const otherErrors = [];
      other.on("pageerror", (error) => otherErrors.push(error.message));
      await other.addInitScript(() => {
        // Simulate a busy tab whose asynchronous storage notification is delayed.
        window.addEventListener("storage", (event) => {
          if (event.key === "bearRadarOverrides") event.stopImmediatePropagation();
        }, true);
      });
      await mock(page, () => ({ body: fresh() }));
      await mock(other, () => ({ body: fresh() }));
      await page.goto(baseURL);
      await other.goto(baseURL);
      await page.locator("#manualButton").click();
      await other.locator("#manualButton").click();
      await page.locator('[data-id="aiEarnings"] .manual-risk').fill("80");
      await other.locator('[data-id="earningsBreadth"] .manual-risk').fill("90");
      await page.locator('#manualForm button[value="default"]').click();
      await expect(other.locator("#indicator-aiEarnings .metric-value")).toHaveText("20/100");
      await other.locator('#manualForm button[value="default"]').click();
      await expect(other.locator("#indicator-aiEarnings .metric-value")).toHaveText("80/100");
      await expect(other.locator("#indicator-earningsBreadth .metric-value")).toHaveText("90/100");
      assert.deepEqual(await other.evaluate(() => {
        const saved = JSON.parse(localStorage.getItem("bearRadarOverrides"));
        return { ai: saved.aiEarnings.risk, earnings: saved.earningsBreadth.risk };
      }), { ai: 80, earnings: 90 });
      await expect(other.locator("#indicator-aiEarnings .source-link")).toContainText("非人工判断来源");
      assert.deepEqual(otherErrors, []);
    });
    await scenario("a later successful manual save retains earlier changes that storage could not save", async (page) => {
      await page.addInitScript(() => {
        const originalSet = Storage.prototype.setItem;
        const originalGet = Storage.prototype.getItem;
        Storage.prototype.setItem = function (...args) {
          if (window.failManualWrite && args[0] === "bearRadarOverrides") throw new DOMException("Storage unavailable", "QuotaExceededError");
          return originalSet.apply(this, args);
        };
        Storage.prototype.getItem = function (...args) {
          if (window.failManualRead && args[0] === "bearRadarOverrides") throw new DOMException("Storage unavailable", "SecurityError");
          return originalGet.apply(this, args);
        };
      });
      await mock(page, () => ({ body: fresh() }));
      await page.goto(baseURL);
      await page.locator("#manualButton").click();
      await page.locator('[data-id="earningsBreadth"] .manual-risk').fill("0");
      await page.locator('#manualForm button[value="default"]').click();
      await page.evaluate(() => { window.failManualWrite = true; });
      await page.locator("#manualButton").click();
      await page.locator('[data-id="aiEarnings"] .manual-risk').fill("42");
      await page.locator('#manualForm button[value="default"]').click();
      await expect(page.locator("#storageNotice")).toBeVisible();
      await page.evaluate(() => { window.failManualWrite = false; });
      await page.locator("#manualButton").click();
      await page.locator('[data-id="earningsBreadth"] .manual-risk').fill("70");
      await page.locator('#manualForm button[value="default"]').click();
      await expect(page.locator("#indicator-aiEarnings .metric-value")).toHaveText("42/100");
      await expect(page.locator("#storageNotice")).toBeHidden();
      await page.evaluate(() => { window.failManualRead = true; });
      await page.locator("#manualButton").click();
      await page.locator('[data-id="aiEarnings"] .manual-risk').fill("43");
      await page.locator('#manualForm button[value="default"]').click();
      await expect(page.locator("#indicator-earningsBreadth .metric-value")).toHaveText("70/100");
      await page.evaluate(() => { window.failManualRead = false; });
      await page.reload();
      await expect(page.locator("#indicator-aiEarnings .metric-value")).toHaveText("43/100");
      await expect(page.locator("#indicator-earningsBreadth .metric-value")).toHaveText("70/100");
    });
    await scenario("storage failures stay visible after save and clear, then disappear on successful retry", async (page) => {
      await mock(page, () => ({ body: fresh() }));
      await page.addInitScript(() => {
        const original = Storage.prototype.setItem;
        Storage.prototype.setItem = function (...args) {
          if (window.failStorage && args[0] === "bearRadarOverrides") throw new DOMException("Storage unavailable", "QuotaExceededError");
          return original.apply(this, args);
        };
      });
      await page.goto(baseURL);
      await page.locator("#manualButton").click();
      await page.locator('[data-id="earningsBreadth"] .manual-risk').fill("0");
      await page.locator('#manualForm button[value="default"]').click();
      await page.evaluate(() => { window.failStorage = true; });
      await page.locator("#manualButton").click();
      await page.locator('[data-id="aiEarnings"] .manual-risk').fill("42");
      await page.locator('#manualForm button[value="default"]').click();
      await expect(page.locator("#storageNotice")).toContainText("未能保存人工数据");
      await expect(page.locator("#indicator-aiEarnings .metric-value")).toHaveText("42/100");
      await page.locator("#refreshButton").click();
      await expect(page.locator("#storageNotice")).toBeVisible();
      await page.locator("#manualButton").click();
      await page.locator("#clearManual").click();
      await expect(page.locator("#dialogStorageNotice")).toContainText("未能保存清除操作");
      assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1));
      if (outputDir) await page.screenshot({ path: path.join(outputDir, "storage-error-mobile.png") });
      await page.locator("#closeManual").click();
      await expect(page.locator("#storageNotice")).toContainText("未能保存清除操作");
      await page.evaluate(() => { window.failStorage = false; });
      await page.locator("#manualButton").click();
      await page.locator("#clearManual").click();
      await expect(page.locator("#dialogStorageNotice")).toBeHidden();
      await page.locator("#closeManual").click();
      await expect(page.locator("#storageNotice")).toBeHidden();
      await page.reload();
      await expect(page.locator("#indicator-earningsBreadth .risk-chip")).not.toHaveText("人工覆盖");
    }, 390);
    for (const mode of ["visible", "hidden", "offline"]) {
      await scenario(`New York midnight rechecks schedules with page ${mode}`, async (page, context) => {
        const time = new Date("2026-10-01T03:59:30Z");
        await page.clock.install({ time });
        await page.clock.pauseAt(time);
        await page.addInitScript(() => {
          Object.defineProperty(document, "visibilityState", { configurable: true, get: () => window.testHidden ? "hidden" : "visible" });
        });
        const data = fresh();
        data.generatedAt = time.toISOString();
        data.reminders[0] = { ...data.reminders[0], date: "2026-09-30" };
        data.reminders[1] = { ...data.reminders[1], date: null, scheduleStatus: "pending" };
        data.aiEarnings[0] = { ...data.aiEarnings[0], nextReportDate: "2026-09-30", nextReportLabel: "2026-09-30", nextReportStatus: "confirmed", snapshotValidThrough: "2026-09-30" };
        const calls = await mock(page, (count) => ({ body: count === 1 ? data : { ...data, generatedAt: "2026-10-01T04:00:30Z", reminders: [{ ...data.reminders[0], date: "2026-10-14" }, ...data.reminders.slice(1)] } }));
        await page.goto(baseURL);
        await expect(page.locator("#reminderGrid .reminder-card").nth(0).locator("time")).toContainText("今天");
        await expect(page.locator("#reminderGrid .reminder-card").nth(1).locator("time")).toHaveText("待核对");
        if (mode === "hidden") await page.evaluate(() => { window.testHidden = true; document.dispatchEvent(new Event("visibilitychange")); });
        if (mode === "offline") {
          await context.setOffline(true);
          await expect(page.locator("#liveText")).toContainText("离线");
          await expect(page.locator(".live-pill")).toHaveAttribute("data-state", "error");
        }
        await page.clock.runFor(60000);
        if (mode !== "visible") {
          assert.equal(calls.length, 1);
          await expect(page.locator("#reminderGrid .reminder-card").nth(0).locator("time")).toHaveText("待核对");
          await expect(page.locator("#aiCompanyGrid .ai-company-card").first().locator(".ai-next-report strong")).toHaveText("待核对下一期日程");
          await expect(page.locator("#reminderGrid .company-reminder-item").first()).toContainText("待核对下一期日程");
          if (mode === "hidden") await page.evaluate(() => { window.testHidden = false; document.dispatchEvent(new Event("visibilitychange")); });
          else await context.setOffline(false);
        }
        await expect.poll(() => calls.length).toBe(2);
        await expect(page.locator("#reminderGrid .reminder-card").nth(0).locator("time")).toContainText("2026-10-14");
        await expect(page.locator("#liveText")).toHaveText("已连接 · 数据已更新");
      });
    }
    await scenario("keyboard focus survives a background refresh and inline manual save", async (page) => {
      await freeze(page);
      const calls = await mock(page, (count) => ({ body: { ...fresh(), refreshing: count === 1 } }));
      await page.goto(baseURL);
      const source = page.locator("#indicator-credit .source-link");
      await source.focus();
      await page.clock.runFor(2500);
      await expect.poll(() => calls.length).toBe(2);
      await expect(source).toBeFocused();
      await page.locator("#scoreMethodology summary").click();
      const methodologySource = page.locator(".methodology-sources a").first();
      await methodologySource.focus();
      const beforeMethodologyRefresh = calls.length;
      await page.clock.runFor(15 * 60 * 1000);
      await expect.poll(() => calls.length).toBeGreaterThan(beforeMethodologyRefresh);
      await expect(methodologySource).toBeFocused();
      await expect(page.locator("#scoreMethodology")).toHaveAttribute("open", "");
      const edit = page.locator("#indicator-aiEarnings .manual-edit");
      await edit.focus();
      await edit.press("Enter");
      await page.locator('[data-id="aiEarnings"] .manual-risk').fill("42");
      await page.locator('[data-id="aiEarnings"] .manual-risk').press("Enter");
      await expect(edit).toBeFocused();
      for (const key of ["Escape", "Enter"]) {
        await edit.press("Enter");
        const input = page.locator('[data-id="aiEarnings"] .manual-risk');
        await input.fill("43");
        const before = calls.length;
        await page.clock.runFor(15 * 60 * 1000);
        await expect.poll(() => calls.length).toBeGreaterThan(before);
        await expect(input).toHaveValue("43");
        await input.press(key);
        await expect(edit).toBeFocused();
      }
    });
    await scenario("a risk driver leaving the top three retains a predictable keyboard focus", async (page) => {
      await freeze(page);
      const calls = await mock(page, (count) => {
        const data = fresh();
        delete data.publicationSchedule;
        data.refreshing = count === 1;
        for (const item of data.indicators) {
          item.available = true;
          item.risk = item.id === "oil" ? (count === 1 ? 100 : 0) : (count === 1 ? 1 : 100);
          item.points = item.risk * item.weight / 100;
        }
        return { body: data };
      });
      await page.goto(baseURL);
      await page.locator('[data-driver-id="oil"]').focus();
      await page.clock.runFor(2500);
      await expect.poll(() => calls.length).toBe(2);
      await expect(page.locator('[data-driver-id="oil"]')).toHaveCount(0);
      await expect(page.locator(".driver-item").first()).toBeFocused();
      await page.keyboard.press("Enter");
      await page.clock.runFor(20);
      await expect(page.locator("#indicator-credit")).toBeFocused();
    });
    await scenario("a delayed close event cannot steal the return target of a reopened manual dialog", async (page) => {
      await mock(page, () => ({ body: fresh() }));
      await page.goto(baseURL);
      const edit = page.locator("#indicator-aiEarnings .manual-edit");
      await edit.click();
      await page.evaluate(() => {
        window.manualCloseStates = [];
        const dialog = document.querySelector("#manualDialog");
        dialog.addEventListener("close", () => window.manualCloseStates.push(dialog.open));
        document.querySelector('[data-id="aiEarnings"] .manual-risk').value = "42";
        document.querySelector("#manualForm").requestSubmit();
        // Reopen before the previous native close event is dispatched.
        document.querySelector("#indicator-aiEarnings .manual-edit").click();
      });
      await expect.poll(() => page.evaluate(() => window.manualCloseStates.includes(true))).toBe(true);
      const input = page.locator('[data-id="aiEarnings"] .manual-risk');
      await input.fill("43");
      await input.press("Escape");
      await expect(edit).toBeFocused();
      await expect(page.locator("#indicator-aiEarnings .metric-value")).toHaveText("42/100");
    });
    await scenario("keyboard focus follows a risk driver to its matching signal", async (page) => {
      await mock(page, () => ({ body: fresh() }));
      await page.goto(baseURL);
      const driver = page.locator(".driver-item").first();
      await driver.waitFor();
      const id = await driver.getAttribute("data-driver-id");
      await driver.focus();
      await driver.press("Enter");
      await expect(page.locator(`#indicator-${id}`)).toBeFocused();
    });
    for (const width of [320, 390, 768, 1024]) {
      await scenario(`responsive navigation reaches the calendar and overview at ${width}px`, async (page) => {
        await mock(page, () => ({ body: fresh() }));
        await page.goto(baseURL);
        await expect(page.locator('.section-nav a[href="#calendar"]')).toBeVisible();
        assert.ok(await page.evaluate(() => {
          const boxes = [".brand", ".section-nav", ".topbar-actions"].map((selector) => document.querySelector(selector).getBoundingClientRect());
          const bottom = document.querySelector(".topbar").getBoundingClientRect().bottom;
          return boxes.every((box, i) => box.left >= 0 && box.right <= innerWidth && box.bottom <= bottom && boxes.slice(i + 1).every((other) => box.right <= other.left || other.right <= box.left || box.bottom <= other.top || other.bottom <= box.top));
        }), "Header controls must fit without overlapping");
        await page.locator('.section-nav a[href="#calendar"]').click();
        await expect.poll(() => page.evaluate(() => {
          const top = document.querySelector("#calendarTitle").getBoundingClientRect().top;
          return top >= document.querySelector(".topbar").getBoundingClientRect().bottom && top < innerHeight - 30;
        })).toBe(true);
        assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1));
        if (outputDir) await page.screenshot({ path: path.join(outputDir, `calendar-navigation-${width}.png`) });
        await page.locator('.section-nav a[href="#overview"]').click();
        await expect.poll(() => page.evaluate(() => {
          const top = document.querySelector("h1").getBoundingClientRect().top;
          return top >= document.querySelector(".topbar").getBoundingClientRect().bottom && top < innerHeight;
        })).toBe(true);
      }, width);
    }
    await scenario("macro publication checks display the official PCE release link", async (page) => {
      const data = fresh();
      const releaseUrl = "https://www.bea.gov/news/2026/personal-income-and-outlays-september-2026";
      data.publicationSchedule = { version: 1, sources: { cpi: null, employment: null, pce: {
        period: "2026-09", publishedAt: "2026-10-29T12:30:00.000Z", checkedAt: new Date().toISOString(),
        source: "https://www.bea.gov/data/personal-consumption-expenditures-price-index", releaseUrl, error: null,
      } } };
      await mock(page, () => ({ body: data }));
      await page.goto(baseURL);
      await expect(page.locator("#publicationStatus")).toContainText("宏观发布核验");
      await expect(page.locator('[data-focus-key="publication-pce"]')).toHaveAttribute("href", releaseUrl);
      await expect(page.locator("#indicatorGrid .indicator-card")).toHaveCount(12);
      assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1));
      if (outputDir) await page.locator("#publicationStatus").screenshot({ path: path.join(outputDir, "macro-publication-pce-390.png"), animations: "disabled" });
    }, 390);
    await scenario("new official earnings reports disclose historical commentary and all eight source states", async (page) => {
      const data = fresh();
      const row = data.aiEarnings.find((item) => item.ticker === "GOOG");
      const now = new Date().toISOString();
      const report = { period: "2026 Q3", periodEnd: "2026-09-30", publishedAt: "2026-10-29T00:29:06.000Z",
        source: "https://www.sec.gov/Archives/edgar/data/1652044/000165204426000084/goog-20260930.htm",
        form: "10-Q", title: "Alphabet Inc. 10-Q for period ended 2026-09-30" };
      data.earningsSchedule = { version: 1, sources: { GOOG: { checkedAt: now, attemptedAt: now, error: null, reports: [report] } } };
      await mock(page, () => ({ body: data }));
      await page.goto(baseURL);
      const card = page.locator('.ai-company-card[data-earnings-status="review-required"]');
      await expect(card).toHaveCount(1);
      await expect(card.locator(".ai-stale-badge")).toHaveText("待复核");
      await expect(card).toHaveClass(/snapshot-stale/);
      await expect(card.locator(".ai-financials")).toContainText("历史营收");
      await expect(card.locator(".ai-financials")).toContainText(row.revenue);
      await expect(card.locator(".ai-readout")).toContainText("历史指引");
      await expect(card.locator('[data-focus-key="new-report-GOOG"]')).toHaveAttribute("href", report.source);
      await expect(card).toContainText("2026 Q3");
      await expect(page.locator("#earningsStatus")).toContainText("8 家公司 · 1 家新报告解读待复核 · 7 家最新性待核对");
      await page.locator("#earningsStatus summary").click();
      await expect(page.locator(".earnings-check-list li")).toHaveCount(8);
      await expect(page.locator("#errorBanner")).toContainText("原财报解读待复核");
      await expect(page.locator("#liveText")).toContainText("财报待复核");
      if (outputDir) await page.locator("#earningsStatus").screenshot({ path: path.join(outputDir, "earnings-source-review.png"), animations: "disabled" });
    }, 390);
    await scenario("historical diagnostics disclose partial coverage and immature forward samples", async (page) => {
      await mock(page, () => ({ body: fresh() }));
      // Production evidence grows over time; this case specifically checks the
      // initial no-mature-outcomes state. Journeys still read the actual file.
      await page.route("**/forward-validation.json", (route) => route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({
        version: 1, status: "awaiting-outcomes", observedSamples: 0, firstObservationDate: null, lastObservationDate: null, generatedAt: null,
        outcomes: [21, 63].map((tradingDays) => ({ tradingDays, samples: 0, immatureSamples: 0, meanReturnPercent: null, meanDrawdownPercent: null, worstDrawdownPercent: null })),
        limitations: ["No observed sample has a mature outcome yet; immature outcomes are not zero returns."],
      }) }));
      await page.goto(baseURL);
      await expect(page.locator("#modelHistory")).toHaveAttribute("data-state", "available");
      await expect(page.locator("#forwardValidation")).toHaveAttribute("data-state", "available");
      await page.locator("#modelValidation > summary").click();
      await expect(page.locator("#modelHistory")).toContainText("27 / 28 个计划检验样本可评分");
      await expect(page.locator("#modelHistory")).toContainText("37–70%");
      await expect(page.locator("#modelHistory")).toContainText("30% 权重未纳入");
      await expect(page.locator("#modelHistory")).toContainText("不能用于校准完整十二项模型");
      await expect(page.locator("#modelHistory")).toContainText("-33.92%");
      await page.locator(".validation-bands > summary").click();
      await expect(page.locator(".validation-bands")).toContainText("0–20");
      await expect(page.locator("#forwardValidation")).toContainText("等待结果成熟");
      await expect(page.locator("#forwardValidation")).toContainText("0 个已成熟");
      await expect(page.locator("#forwardValidation")).toContainText("不表示收益或回撤为 0");
      assert.ok(!/0\.0+%/.test(await page.locator("#forwardValidation").textContent()), "Immature samples must not be shown as zero-percent returns");
      assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1));
      await expect(page.locator("#actionCallout > span")).toHaveText("当前研究重点");
      await expect(page.locator(".action-note")).toContainText("不能据此校准个人仓位");
      await expect(page.locator(".footer")).toContainText("v4.8.1");
      if (outputDir) await page.locator("#modelValidation").screenshot({ path: path.join(outputDir, "model-history-forward-390.png"), animations: "disabled" });
    }, 390);
    await scenario("auxiliary validation report failures and body timeouts never block the dashboard", async (page) => {
      await freeze(page);
      await mock(page, () => ({ body: fresh() }));
      await page.addInitScript(() => {
        const original = window.fetch;
        window.fetch = async (...args) => {
          if (String(args[0]) === "/model-validation.json") return { ok: true, json: async () => ({ version: 99 }) };
          if (["/model-validation.json", "/forward-validation.json"].includes(String(args[0]))) {
            return { ok: true, json: () => new Promise((_resolve, reject) => {
              args[1].signal.addEventListener("abort", () => reject(new Error("aborted")), { once: true });
            }) };
          }
          return original(...args);
        };
      });
      await page.goto(baseURL);
      await expect(page.locator("#indicatorGrid .indicator-card")).toHaveCount(12);
      const score = await page.locator("#scoreValue").textContent();
      await page.clock.runFor(6000);
      await expect(page.locator("#modelHistory")).toHaveAttribute("data-state", "unavailable");
      await expect(page.locator("#forwardValidation")).toHaveAttribute("data-state", "unavailable");
      await expect(page.locator("#modelHistory")).toContainText("待核验");
      await expect(page.locator("#scoreValue")).toHaveText(score);
      await expect(page.locator("#refreshButton")).toBeEnabled();
      await page.locator('#filters button[data-filter="信用"]').click();
      await expect(page.locator("#indicatorGrid .indicator-card")).toHaveCount(1);
    });
    await scenario("unscorable forward samples and benchmark outages are disclosed without false waiting progress", async (page) => {
      await freeze(page);
      let outage = false;
      let reportCalls = 0;
      const now = new Date().toISOString();
      const data = { version: 1, status: "awaiting-outcomes", observedSamples: 1, firstObservationDate: now.slice(0, 10), lastObservationDate: now.slice(0, 10),
        generatedAt: now, limitations: ["Unscorable observations stay out of return statistics."],
        outcomes: [21, 63].map((tradingDays) => ({ tradingDays, samples: 0, immatureSamples: 0, unavailableScoreSamples: 1,
          meanReturnPercent: null, meanDrawdownPercent: null, worstDrawdownPercent: null })) };
      await mock(page, () => ({ body: fresh() }));
      await page.route("**/forward-validation.json", (route) => {
        reportCalls += 1;
        return route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ ...data, benchmark: { error: outage ? "Fixture benchmark outage" : null } }) });
      });
      await page.goto(baseURL);
      await expect(page.locator("#forwardValidation")).toHaveAttribute("data-state", "available");
      await page.locator("#modelValidation > summary").click();
      await expect(page.locator("#forwardValidation")).toContainText("1 个无有效评分，不纳入");
      await expect(page.locator("#forwardValidation")).toContainText("不会因继续等待而自动纳入");
      outage = true;
      const beforeManualRefresh = reportCalls;
      await page.locator("#refreshButton").click();
      await expect.poll(() => reportCalls).toBeGreaterThan(beforeManualRefresh);
      await expect(page.locator("#forwardValidation")).toContainText("基准价格暂不可用，结果计数待核验");
      await expect(page.locator("#forwardValidation .validation-outcomes li")).toHaveCount(0);
      await expect(page.locator("#indicatorGrid .indicator-card")).toHaveCount(12);
      outage = false;
      const beforeTimedRefresh = reportCalls;
      await page.clock.runFor(15 * 60 * 1000);
      await expect.poll(() => reportCalls).toBeGreaterThan(beforeTimedRefresh);
      await expect(page.locator("#forwardValidation")).toContainText("1 个无有效评分，不纳入");
    });
    await scenario("vendor source revisions stay hidden when empty and disclose raw units by keyboard and touch", async (page) => {
      let revised = false;
      await mock(page, () => ({ body: { ...fresh(), sourceRevisions: revised ? [{
        series: "PAYEMS", label: "非农 <img src=x onerror=evil()>", date: "2026-09-01", before: 154000, after: 153800,
        firstDetectedAt: new Date().toISOString(),
      }] : [] } }));
      await page.goto(baseURL);
      await expect(page.locator("#sourceRevisions")).toBeHidden();
      revised = true;
      await page.locator("#refreshButton").click();
      const summary = page.locator("#sourceRevisions > summary");
      await expect(summary).toHaveText("供应商历史值修订（1条）");
      await summary.focus();
      await summary.press("Enter");
      await expect(page.locator("#sourceRevisions")).toHaveAttribute("open", "");
      await expect(page.locator("#revisionList")).toContainText("154000 → 153800");
      await expect(page.locator("#sourceRevisions")).toContainText("供应商原始序列单位");
      await expect(page.locator("#sourceRevisions")).toContainText("不代表官方全部历史版本对账");
      assert.equal(await page.locator("#revisionList img").count(), 0);
      await summary.press("Space");
      await expect(page.locator("#sourceRevisions")).not.toHaveAttribute("open", "");
      await summary.tap();
      await expect(page.locator("#sourceRevisions")).toHaveAttribute("open", "");
      assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1));
      if (outputDir) await page.locator("#sourceRevisions").screenshot({ path: path.join(outputDir, "source-revisions-390.png"), animations: "disabled" });
    }, 390, 844, { hasTouch: true });
    console.log(`${passed} browser scenarios passed`);
  } finally {
    await browser.close();
  }
}

main().catch((error) => { console.error(error.stack || error); process.exitCode = 1; });
