const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const { chromium, expect } = require("playwright/test");

const baseURL = process.env.RADAR_URL || "http://127.0.0.1:4173";
const outputDir = process.env.RADAR_SCREENSHOTS;
const launchOptions = { executablePath: process.env.CHROME_PATH || undefined };

async function main() {
  const fixture = JSON.parse(await fs.readFile(path.join(__dirname, "../dashboard-cache.json"), "utf8"));
  const fresh = () => {
    const data = { ...structuredClone(fixture), generatedAt: new Date().toISOString(), refreshing: false, errors: [] };
    for (const source of Object.values(data.calendarSync?.sources || {})) {
      if (source && typeof source === "object") source.error = null;
    }
    return data;
  };
  const result = { executedAt: new Date().toISOString(), baseURL, scenarios: [] };
  if (outputDir) await fs.mkdir(outputDir, { recursive: true });
  const browser = await chromium.launch(launchOptions);
  let persistent;
  let profile;

  async function scenario(name, width, check, options = {}) {
    if (process.env.RADAR_TEST && !name.includes(process.env.RADAR_TEST)) return;
    const context = options.context || await browser.newContext({ viewport: { width, height: options.height || 740 }, reducedMotion: options.motion || "reduce", hasTouch: options.touch || false, deviceScaleFactor: options.dpr || 1 });
    const page = await context.newPage();
    if (options.context) await page.setViewportSize({ width, height: options.height || 740 });
    const entry = { name, width, measurements: {} };
    const pageErrors = [];
    page.on("pageerror", error => pageErrors.push(error.message));
    try {
      await check(page, entry.measurements);
      assert.deepEqual(pageErrors, []);
      entry.passed = true;
      console.log(`PASS ${name}`);
    } catch (error) {
      entry.passed = false;
      entry.error = error.message;
      entry.pageErrors = pageErrors;
      console.error(`FAIL ${name}: ${error.message}`);
      if (outputDir) await page.screenshot({ path: path.join(outputDir, `failure-${name}.png`) }).catch(() => {});
    } finally {
      result.scenarios.push(entry);
      await page.close();
      if (!options.context) await context.close();
    }
  }

  async function load(page, read = () => fresh()) {
    let calls = 0;
    await page.route("**/api/dashboard*", async route => {
      const data = read(++calls);
      await route.fulfill({ status: data.httpStatus || 200, contentType: "application/json", body: JSON.stringify(data.body || data) });
    });
    await page.goto(baseURL);
    if (!read.httpError) await expect(page.locator("#indicatorGrid .indicator-card")).toHaveCount(12);
    await page.evaluate(() => document.fonts.ready);
    return () => calls;
  }

  async function shot(page, name) {
    if (outputDir) await page.screenshot({ path: path.join(outputDir, `${name}.png`) });
  }

  async function navigation(page, measurements, largeText) {
    await load(page);
    measurements.layout = await page.evaluate(() => ({ width: innerWidth, scrollWidth: document.documentElement.scrollWidth, font: getComputedStyle(document.querySelector(".section-nav a")).fontSize, headerHeight: document.querySelector(".topbar").getBoundingClientRect().height, links: Array.from(document.querySelectorAll(".section-nav a")).map(e => ({ text: e.textContent, ...e.getBoundingClientRect().toJSON() })) }));
    measurements.firstViewport = await page.evaluate(() => Object.fromEntries(["scoreValue", "verdictLabel"].map(id => [id, document.getElementById(id).getBoundingClientRect().toJSON()])));
    await expect(page.locator(".score-clarification")).toHaveText("规则评分 · 非下跌概率");
    measurements.clarification = await page.locator(".score-clarification").evaluate(e => ({ ...e.getBoundingClientRect().toJSON(), font: getComputedStyle(e).fontSize }));
    await shot(page, `${largeText ? "minfont20" : "normal"}-${measurements.layout.width}`);
    assert.ok(measurements.layout.scrollWidth <= measurements.layout.width + 1, JSON.stringify(measurements.layout));
    assert.ok(measurements.layout.links.every(r => r.left >= 0 && r.right <= measurements.layout.width + 1));
    if (largeText) assert.ok(parseFloat(measurements.layout.font) >= 20, "Chrome must actually apply its minimum font preference");
    else if ([320, 390].includes(measurements.layout.width)) {
      assert.ok(await page.evaluate(() => ["#scoreValue", "#verdictLabel"].every(selector => { const r = document.querySelector(selector).getBoundingClientRect(); return r.top >= document.querySelector(".topbar").getBoundingClientRect().bottom && r.bottom <= innerHeight; })), "Existing mobile first-viewport verdict must remain visible");
      assert.ok(measurements.clarification.top >= measurements.layout.headerHeight && measurements.clarification.bottom <= measurements.firstViewport.scoreValue.top);
    }
    const shortcut = page.getByRole("link", { name: "风险主因", exact: true });
    measurements.shortcut = await shortcut.evaluate(e => ({ ...e.getBoundingClientRect().toJSON(), label: document.querySelector("#verdictLabel").getBoundingClientRect().toJSON() }));
    assert.ok(measurements.shortcut.top < measurements.shortcut.label.bottom && measurements.shortcut.bottom > measurements.shortcut.label.top, "The shortcut must remain on the verdict row");
    assert.ok(measurements.shortcut.left >= 0 && measurements.shortcut.right <= measurements.layout.width);
    const label = await page.locator("#verdictLabel").textContent();
    await page.locator("#verdictLabel").evaluate(e => { e.textContent = "健康、风险较低"; });
    assert.ok(await shortcut.evaluate(e => { const r = e.getBoundingClientRect(), label = document.querySelector("#verdictLabel").getBoundingClientRect(); return r.top < label.bottom && r.bottom > label.top && r.right <= innerWidth; }), "The longest existing verdict must not push the shortcut off its row");
    await page.locator("#verdictLabel").evaluate((e, text) => { e.textContent = text; }, label);
    await shortcut.focus();
    await page.keyboard.press("Enter");
    measurements.driverAnchor = await page.locator("#driversTitle").evaluate(e => ({ top: e.getBoundingClientRect().top, bottom: e.getBoundingClientRect().bottom, header: document.querySelector(".topbar").getBoundingClientRect().bottom, height: innerHeight }));
    assert.ok(measurements.driverAnchor.top >= measurements.driverAnchor.header && measurements.driverAnchor.bottom <= measurements.driverAnchor.height, JSON.stringify(measurements.driverAnchor));
    await page.keyboard.press("Tab");
    await expect(page.locator(".driver-item").first()).toBeFocused();
    measurements.destinations = [];
    for (const hash of ["#calendar", "#ai", "#signals", "#overview"]) {
      const link = page.locator(`.section-nav a[href="${hash}"]`);
      await link.focus();
      await page.keyboard.press("Enter");
      const position = await page.evaluate(hash => { const heading = document.querySelector(hash).querySelector("h1, h2").getBoundingClientRect(); return { hash, top: heading.top, bottom: heading.bottom, header: document.querySelector(".topbar").getBoundingClientRect().bottom, height: innerHeight }; }, hash);
      measurements.destinations.push(position);
      assert.ok(position.top >= position.header && position.top < position.height, JSON.stringify(position));
    }
  }

  try {
    for (const width of [320, 390, 720, 1024, 1440]) await scenario(`normal-navigation-${width}`, width, (p, m) => navigation(p, m, false));
    await scenario("zoom200-equivalent-navigation", 720, (p, m) => navigation(p, m, false), { height: 480, dpr: 2 });

    profile = await fs.mkdtemp(path.join(outputDir || os.tmpdir(), "product-font-profile-"));
    await fs.mkdir(path.join(profile, "Default"));
    await fs.writeFile(path.join(profile, "Default", "Preferences"), JSON.stringify({ webkit: { webprefs: { minimum_font_size: 20, minimum_logical_font_size: 20 } } }));
    persistent = await chromium.launchPersistentContext(profile, { ...launchOptions, viewport: { width: 390, height: 740 }, reducedMotion: "reduce" });
    for (const width of [320, 390, 720, 1024, 1440]) await scenario(`minfont20-navigation-${width}`, width, (p, m) => navigation(p, m, true), { context: persistent });
    for (const width of [320, 390]) await scenario(`minfont20-driver-heading-${width}`, width, async (page, measurements) => {
      await load(page);
      measurements.drivers = [];
      for (const id of await page.locator(".driver-item").evaluateAll(elements => elements.map(e => e.dataset.driverId))) {
        await page.locator(`[data-driver-id="${id}"]`).focus();
        await page.keyboard.press("Enter");
        const target = page.locator(`#indicator-${id}`);
        await expect(target).toBeFocused();
        const position = await target.locator(".card-title").evaluate(e => ({ title: e.textContent, top: e.getBoundingClientRect().top, bottom: e.getBoundingClientRect().bottom, header: document.querySelector(".topbar").getBoundingClientRect().bottom, height: innerHeight }));
        measurements.drivers.push(position);
        assert.ok(position.top >= position.header && position.bottom <= position.height, JSON.stringify(position));
      }
      await shot(page, `minfont20-driver-${width}`);
    }, { context: persistent });
    await persistent.close();
    persistent = null;

    for (const width of [390, 1440]) await scenario(`source-contrast-${width}`, width, async (page, measurements) => {
      await load(page);
      async function contrast() {
        return page.evaluate(() => {
          const rgba = str => (str.match(/[\d.]+/g) || []).map(Number);
          const blend = (f, b) => f.slice(0, 3).map((v, i) => v * (f[3] ?? 1) + b[i] * (1 - (f[3] ?? 1)));
          const luminance = rgb => rgb.map(v => { const c = v / 255; return c <= .04045 ? c / 12.92 : ((c + .055) / 1.055) ** 2.4; }).reduce((s, v, i) => s + v * [.2126, .7152, .0722][i], 0);
          return Array.from(document.querySelectorAll(".source-link, .ai-card-foot > a, .date-source, .company-reminder-item a, .reminder-source, .band-labels span")).map(e => {
            const stack = []; for (let a = e; a; a = a.parentElement) stack.push(rgba(getComputedStyle(a).backgroundColor));
            const bg = stack.reverse().reduce((b, f) => blend(f, b), [255, 255, 255]);
            const style = getComputedStyle(e), f = luminance(blend(rgba(style.color), bg)), b = luminance(bg);
            return { text: e.textContent, class: e.className, ratio: (Math.max(f, b) + .05) / (Math.min(f, b) + .05) };
          });
        });
      }
      measurements.normal = await contrast();
      await page.locator(".source-link").first().hover();
      measurements.hover = await contrast();
      await page.mouse.move(0, 0);
      await page.locator(".source-link").first().focus();
      measurements.focus = await contrast();
      assert.ok(measurements.normal.length >= 25);
      for (const state of ["normal", "hover", "focus"]) assert.ok(measurements[state].every(row => row.ratio >= 4.5), JSON.stringify(measurements[state].filter(row => row.ratio < 4.5)));
      await page.locator('.section-nav a[href="#ai"]').click();
      await shot(page, `source-links-${width}`);
    });

    for (const width of [320, 390, 720, 1440]) for (const motion of ["reduce", "no-preference"]) await scenario(`driver-heading-${width}-${motion}`, width, async (page, measurements) => {
      await load(page);
      measurements.drivers = [];
      const ids = await page.locator(".driver-item").evaluateAll(elements => elements.map(e => e.dataset.driverId));
      for (const id of ids) {
        await page.locator(`[data-driver-id="${id}"]`).focus();
        await page.keyboard.press("Enter");
        const target = page.locator(`#indicator-${id}`);
        await expect(target).toBeFocused();
        await expect.poll(() => target.locator(".card-title").evaluate(e => e.getBoundingClientRect().top >= document.querySelector(".topbar").getBoundingClientRect().bottom), { timeout: 3000 }).toBe(true);
        if (motion !== "reduce") await page.waitForTimeout(1500);
        const position = await target.locator(".card-title").evaluate(e => ({ title: e.textContent, top: e.getBoundingClientRect().top, header: document.querySelector(".topbar").getBoundingClientRect().bottom }));
        measurements.drivers.push(position);
        assert.ok(position.top >= position.header, JSON.stringify(position));
      }
      await shot(page, `driver-${width}-${motion}`);
      await page.locator('#filters button[data-filter="全部"]').click();
      await page.locator(".driver-item").first().click();
      await expect.poll(() => page.locator(`#indicator-${ids[0]} .card-title`).evaluate(e => e.getBoundingClientRect().top >= document.querySelector(".topbar").getBoundingClientRect().bottom)).toBe(true);
    }, { height: width === 720 ? 480 : 740, motion });

    for (const count of [1, 3, 5, 15]) await scenario(`error-details-${count}`, 390, async (page, measurements) => {
      const errors = Array.from({ length: count }, (_, i) => `Source ${i + 1}: temporarily unavailable`);
      await load(page, () => ({ ...fresh(), errors }));
      const banner = page.locator("#errorBanner");
      await expect(banner).toContainText("部分数据源暂时不可用");
      for (const error of errors.slice(0, 3)) await expect(banner).toContainText(error);
      measurements.initialText = await banner.textContent();
      const details = banner.locator("details");
      if (count <= 3) await expect(details).toHaveCount(0);
      else {
        const summary = details.locator("summary");
        await expect(summary).toBeVisible({ timeout: 1500 });
        await summary.focus();
        await page.keyboard.press("Enter");
        await expect(details).toHaveAttribute("open", "");
        for (const error of errors) await expect(details.locator("li", { hasText: error })).toBeVisible();
        await page.keyboard.press("Space");
        await expect(details).not.toHaveAttribute("open", "");
        await summary.tap();
        await expect(details).toHaveAttribute("open", "");
        measurements.expanded = { rows: await details.locator("li").count(), summaryHeight: (await summary.boundingBox()).height };
        assert.ok(measurements.expanded.summaryHeight >= 24);
        await shot(page, `error-details-${count}-expanded`);
      }
      assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1));
    }, { touch: true });

    await scenario("error-details-refresh-focus-and-recovery", 390, async (page, measurements) => {
      await page.clock.install({ time: new Date() });
      await page.clock.pauseAt(new Date());
      let mode = "polling";
      const errors = ["Source A", "Source B", "Source C", "Source D", "Source E <img src=x onerror=window.injected=true>"];
      const calls = await load(page, count => mode === "recover" ? fresh() : mode === "http-error" ? { httpStatus: 503, body: {} } : { ...fresh(), errors: mode === "three-errors" ? errors.slice(0, 3) : count === 1 ? errors : [...errors, "Source F"], refreshing: count === 1 });
      const summary = page.locator("#errorBanner summary"), details = page.locator("#errorBanner details");
      await expect(summary).toBeVisible({ timeout: 1500 });
      await summary.focus();
      await page.keyboard.press("Enter");
      await page.clock.runFor(2500);
      await expect.poll(calls).toBeGreaterThanOrEqual(2);
      await expect(summary).toBeFocused();
      await expect(details).toHaveAttribute("open", "");
      await expect(details.locator("li")).toHaveCount(6);
      await expect(details.locator("img")).toHaveCount(0);
      assert.equal(await page.evaluate(() => window.injected), undefined);
      await page.locator('#filters button[data-filter="信用"]').click();
      await expect(details).toHaveAttribute("open", "");
      await summary.focus();
      await page.keyboard.press("Space");
      await page.clock.runFor(15 * 60 * 1000);
      await expect(summary).toBeFocused();
      await expect(details).not.toHaveAttribute("open", "");
      await page.keyboard.press("Enter");
      measurements.preserved = { focused: await summary.evaluate(e => e === document.activeElement), expanded: await details.evaluate(e => e.open), rows: await details.locator("li").count() };
      await shot(page, "error-details-preserved");
      mode = "three-errors";
      await page.clock.runFor(15 * 60 * 1000);
      await expect(summary).toBeHidden();
      await expect(page.locator("#refreshButton")).toBeFocused();
      mode = "polling";
      await page.clock.runFor(15 * 60 * 1000);
      await expect(summary).toBeVisible();
      await expect(details).toHaveAttribute("open", "");
      await expect(page.locator("#refreshButton")).toBeFocused();
      await summary.focus();
      mode = "http-error";
      await page.clock.runFor(15 * 60 * 1000);
      await expect(page.locator("#errorBanner")).toContainText("503");
      await expect(page.locator("#refreshButton")).toBeFocused();
      mode = "recover";
      await page.clock.runFor(15000);
      await expect(page.locator("#errorBanner")).toBeHidden();
      await expect(page.locator('#filters button[data-filter="信用"]')).toHaveAttribute("aria-pressed", "true");
    });

    await scenario("company-specific-links-survive-refresh", 1440, async (page, measurements) => {
      await page.clock.install({ time: new Date() });
      await page.clock.pauseAt(new Date());
      const calls = await load(page, count => ({ ...fresh(), refreshing: count === 1 }));
      const companies = await page.locator(".ai-company-card").evaluateAll(cards => cards.map(card => ({ ticker: card.querySelector('[data-focus-key^="financial-"]').dataset.focusKey.slice(10), financial: card.querySelector('[data-focus-key^="financial-"]').getAttribute("aria-label"), date: card.querySelector(".date-source")?.getAttribute("aria-label") })));
      measurements.companies = companies;
      assert.equal(companies.length, 8);
      for (const row of companies) { assert.ok(row.financial?.includes(row.ticker)); if (row.date !== undefined) assert.ok(row.date?.includes(row.ticker)); }
      assert.equal(new Set(companies.map(row => row.financial)).size, 8);
      for (const row of companies) await expect(page.getByRole("link", { name: row.financial, exact: true })).toHaveCount(1);
      for (const link of await page.locator('.company-reminder-item a').all()) {
        const ticker = await link.locator('..').locator('b').textContent();
        assert.ok((await link.getAttribute('aria-label'))?.includes(ticker));
      }
      const source = page.locator('[data-focus-key^="financial-"]').first();
      await source.focus();
      await page.clock.runFor(2500);
      await expect.poll(calls).toBeGreaterThanOrEqual(2);
      await expect(source).toBeFocused();
      await expect(source).toHaveAttribute("aria-label", companies[0].financial);
    });

    await scenario("unavailable-confidence-is-chinese-and-excludes-credit", 390, async (page, measurements) => {
      let unavailable = false;
      await load(page, () => {
        const data = fresh(), credit = data.indicators.find(row => row.id === "credit");
        Object.assign(credit, unavailable ? { available: false, risk: null, points: null, confidence: "unavailable", status: "unavailable", unavailableReason: "子数据不足" } : { available: true, risk: 10, points: 1.5, confidence: "high", status: "low", unavailableReason: null });
        return data;
      });
      const before = parseFloat(await page.locator("#coverageValue").textContent());
      unavailable = true;
      await page.locator("#refreshButton").click();
      await expect(page.locator("#indicator-credit .risk-chip")).toHaveText("子数据不足");
      await expect(page.locator("#indicator-credit .confidence")).toHaveText("数据不足");
      await expect(page.locator("#indicator-credit .score-points")).toContainText("--");
      const after = parseFloat(await page.locator("#coverageValue").textContent());
      const weight = fixture.indicators.find(row => row.id === "credit").weight;
      assert.equal(before - after, weight);
      measurements.coverage = { before, after, excludedWeight: weight };
      await page.locator('#filters button[data-filter="信用"]').click();
      await page.locator("#indicator-credit").scrollIntoViewIfNeeded();
      await shot(page, "unavailable-credit");
    });
  } finally {
    if (persistent) await persistent.close();
    await browser.close();
    if (profile) await fs.rm(profile, { recursive: true, force: true });
    result.passed = result.scenarios.filter(s => s.passed).length;
    result.failed = result.scenarios.filter(s => !s.passed).length;
    if (outputDir) await fs.writeFile(path.join(outputDir, "product-results.json"), JSON.stringify(result, null, 2));
    console.log(`${result.passed} passed, ${result.failed} failed`);
    if (result.failed) process.exitCode = 1;
  }
}

main().catch(error => { console.error(error.stack || error); process.exitCode = 1; });
