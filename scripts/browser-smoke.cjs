const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const path = require("node:path");
const { chromium, expect } = require("playwright/test");

const baseURL = process.env.RADAR_URL || "http://127.0.0.1:4173";
const outputDir = process.env.RADAR_SCREENSHOTS;

async function main() {
  const fixture = JSON.parse(await fs.readFile(path.join(__dirname, "../dashboard-cache.json"), "utf8"));
  const fresh = () => {
    const data = { ...structuredClone(fixture), generatedAt: new Date().toISOString(), errors: [], refreshing: false };
    for (const source of Object.values(data.calendarSync?.sources || {})) source.error = null;
    return data;
  };
  const browser = await chromium.launch({ executablePath: process.env.CHROME_PATH || undefined });
  let passed = 0;
  async function scenario(name, check, width = 1440, height = 960) {
    if (process.env.RADAR_TEST && !name.includes(process.env.RADAR_TEST)) return;
    const context = await browser.newContext({ viewport: { width, height } });
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
        assert.ok(await page.evaluate(() => ["#scoreValue", "#verdictLabel"].every((selector) => {
          const box = document.querySelector(selector).getBoundingClientRect();
          return box.top >= document.querySelector(".topbar").getBoundingClientRect().bottom && box.bottom <= innerHeight;
        })), "The score and verdict must be readable without scrolling");
        assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1));
        if (outputDir) {
          await fs.mkdir(outputDir, { recursive: true });
          await page.screenshot({ path: path.join(outputDir, `first-viewport-${width}.png`) });
        }
      }, width, 740);
    }
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
      await expect(page.locator("#scoreGauge")).toHaveAttribute("aria-label", "综合市场风险分暂不可用");
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
    console.log(`${passed} browser scenarios passed`);
  } finally {
    await browser.close();
  }
}

main().catch((error) => { console.error(error.stack || error); process.exitCode = 1; });
