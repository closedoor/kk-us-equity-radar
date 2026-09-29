const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const path = require("node:path");
const { chromium, expect } = require("playwright/test");

const baseURL = process.env.RADAR_URL || "http://127.0.0.1:4173";
const outputDir = process.env.RADAR_SCREENSHOTS;

async function main() {
  const fixture = JSON.parse(await fs.readFile(path.join(__dirname, "../dashboard-cache.json"), "utf8"));
  const fresh = () => ({ ...structuredClone(fixture), generatedAt: new Date().toISOString(), errors: [], refreshing: false });
  const browser = await chromium.launch({ executablePath: process.env.CHROME_PATH || undefined });
  let passed = 0;
  async function scenario(name, check, width = 1440) {
    const context = await browser.newContext({ viewport: { width, height: 960 } });
    const page = await context.newPage();
    const errors = [];
    page.on("pageerror", (error) => errors.push(error.message));
    try {
      await check(page, context);
      assert.deepEqual(errors, [], name);
      console.log(`PASS ${name}`);
      passed += 1;
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
    console.log(`${passed} browser scenarios passed`);
  } finally {
    await browser.close();
  }
}

main().catch((error) => { console.error(error); process.exitCode = 1; });
