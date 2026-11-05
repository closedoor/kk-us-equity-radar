const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const path = require("node:path");
const { chromium, webkit, expect } = require("playwright/test");

const baseURL = process.env.RADAR_URL || "http://127.0.0.1:4173";
const outputDir = process.env.RADAR_SCREENSHOTS || "qa-artifacts";
const engineName = process.env.RADAR_ENGINE || "chromium";
const sizes = [
  { name: "small-mobile-320", width: 320, height: 740, mobile: true },
  { name: "mobile-390", width: 390, height: 844, mobile: true },
  { name: "iphone-pro-max-like-440", width: 440, height: 956, mobile: true },
  { name: "desktop-1440", width: 1440, height: 960, mobile: false },
];

async function main() {
  if (!["chromium", "webkit"].includes(engineName)) throw new Error(`Unsupported QA engine: ${engineName}`);
  await fs.mkdir(outputDir, { recursive: true });
  const result = {
    executedAt: new Date().toISOString(), baseURL, browserEngine: engineName,
    scope: `Recorded fixture data in ${engineName === "webkit" ? "Linux Playwright WebKit" : "desktop Chromium"}; touch and viewport emulation only. The 440x956 viewport approximates an iPhone Pro Max screen. Linux WebKit is not physical iOS Safari; neither engine verifies a physical iPhone, native keyboard or safe areas.`,
    scenarios: [],
  };
  const browser = engineName === "webkit" ? await webkit.launch() : await chromium.launch({ executablePath: process.env.CHROME_PATH || undefined });
  result.browserVersion = browser.version();
  try {
    for (const size of sizes) {
      const context = await browser.newContext({
        viewport: { width: size.width, height: size.height },
        isMobile: size.mobile, hasTouch: size.mobile,
        deviceScaleFactor: size.mobile ? 3 : 1, reducedMotion: "reduce",
      });
      const page = await context.newPage();
      const entry = { ...size, deviceScaleFactor: size.mobile ? 3 : 1, screenshotScale: "css", pageErrors: [], failedRequests: [] };
      const activate = locator => size.mobile ? locator.tap() : locator.click();
      page.on("pageerror", error => entry.pageErrors.push(error.message));
      page.on("requestfailed", request => entry.failedRequests.push({ url: request.url(), error: request.failure()?.errorText }));
      const shot = (suffix, options = {}) => page.screenshot({ path: path.join(outputDir, `${size.name}-${suffix}.png`), animations: "disabled", scale: "css", ...options });
      try {
        await page.goto(baseURL);
        await expect(page.locator("#indicatorGrid .indicator-card")).toHaveCount(12);
        await expect(page.locator("#aiCompanyGrid .ai-company-card")).toHaveCount(8);
        await expect(page.locator("#reminderGrid .reminder-card")).toHaveCount(5);
        await expect(page.locator("#refreshButton")).toBeEnabled();
        await page.evaluate(() => document.fonts.ready);
        entry.layout = await page.evaluate(() => ({ viewport: innerWidth, scrollWidth: document.documentElement.scrollWidth, score: document.querySelector("#scoreValue").textContent, header: document.querySelector(".topbar").getBoundingClientRect().toJSON() }));
        assert.ok(entry.layout.scrollWidth <= size.width + 1, "Initial layout must not overflow horizontally");
        assert.ok(Number.isFinite(Number(entry.layout.score)) && entry.layout.score !== "--", "Healthy fixture must render a real score");
        await shot("overview");
        await shot("full-page", { fullPage: true });
        if (await page.locator("#modelValidation").count()) {
          await expect(page.locator("#modelHistory")).toHaveAttribute("data-state", "available");
          await expect(page.locator("#forwardValidation")).toHaveAttribute("data-state", "available");
          await activate(page.locator("#modelValidation > summary"));
          await page.locator("#modelValidation").screenshot({ path: path.join(outputDir, `${size.name}-model-validation.png`), animations: "disabled", scale: "css" });
          await activate(page.locator("#modelValidation > summary"));
        }

        await activate(page.locator("#manualButton"));
        const risk = page.locator('[data-id="aiEarnings"] .manual-risk');
        await risk.fill("101");
        await activate(page.locator('#manualForm button[value="default"]'));
        await expect(page.locator("#manualDialog")).toBeVisible();
        assert.equal(await risk.evaluate(input => input.checkValidity()), false);
        await risk.fill("42");
        await page.locator('[data-id="aiEarnings"] .manual-note').fill("CI touch/keyboard journey");
        await page.locator('[data-id="earningsBreadth"] .manual-risk').fill("0");
        await page.locator("#manualDialog").screenshot({ path: path.join(outputDir, `${size.name}-manual-dialog.png`), animations: "disabled", scale: "css" });
        await activate(page.locator('#manualForm button[value="default"]'));
        await expect(page.locator("#manualDialog")).toBeHidden();
        await expect(page.locator("#indicator-aiEarnings .metric-value")).toHaveText("42/100");
        await expect(page.locator("#indicator-earningsBreadth .metric-value")).toHaveText("0/100");
        await expect(page.locator("#indicator-aiEarnings .source-link")).toContainText("非人工判断来源");
        await activate(page.locator("#refreshButton"));
        await expect(page.locator("#refreshButton")).toBeEnabled();
        await page.reload();
        await expect(page.locator("#indicator-aiEarnings .metric-value")).toHaveText("42/100");
        await expect(page.locator("#indicator-earningsBreadth .metric-value")).toHaveText("0/100");
        await activate(page.locator("#manualButton"));
        await risk.fill("75");
        await risk.press("Escape");
        await expect(page.locator("#manualDialog")).toBeHidden();
        await expect(page.locator("#indicator-aiEarnings .metric-value")).toHaveText("42/100");
        entry.manual = { persistedRisk: 42, zeroPreserved: true, invalidRejected: true, escapeDiscarded: true };

        await activate(page.locator('#filters button[data-filter="信用"]'));
        await expect(page.locator("#indicatorGrid .indicator-card")).toHaveCount(1);
        await activate(page.locator('#filters button[data-filter="全部"]'));
        await expect(page.locator("#indicatorGrid .indicator-card")).toHaveCount(12);
        const driver = page.locator(".driver-item").first();
        const driverId = await driver.getAttribute("data-driver-id");
        await driver.focus();
        await page.keyboard.press("Enter");
        await expect(page.locator(`#indicator-${driverId}`)).toBeFocused();
        entry.keyboardDriver = driverId;

        await activate(page.locator('.section-nav a[href="#calendar"]'));
        await expect.poll(() => page.locator("#calendarTitle").evaluate(title => title.getBoundingClientRect().top >= document.querySelector(".topbar").getBoundingClientRect().bottom)).toBe(true);
        await shot("calendar");
        await activate(page.locator('.section-nav a[href="#ai"]'));
        await expect.poll(() => page.locator("#aiTitle").evaluate(title => title.getBoundingClientRect().top >= document.querySelector(".topbar").getBoundingClientRect().bottom)).toBe(true);
        await shot("ai");
        if (await page.locator("#earningsStatus summary").count()) {
          await activate(page.locator("#earningsStatus summary"));
          await page.locator("#earningsStatus").screenshot({ path: path.join(outputDir, `${size.name}-earnings-checks.png`), animations: "disabled", scale: "css" });
          await activate(page.locator("#earningsStatus summary"));
        }
        for (const [label, card] of [["first", page.locator(".ai-company-card").first()], ["last", page.locator(".ai-company-card").last()]]) {
          await card.screenshot({ path: path.join(outputDir, `${size.name}-financial-card-${label}.png`), animations: "disabled", scale: "css" });
        }
        assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1), "Journey must retain a fitting layout");
        assert.deepEqual(entry.pageErrors, []);
        assert.deepEqual(entry.failedRequests, []);
        entry.passed = true;
        console.log(`PASS actual ${engineName === "webkit" ? "Linux WebKit" : "Chromium"} viewport journey ${size.name} (${size.width}x${size.height})`);
      } catch (error) {
        entry.passed = false;
        entry.error = error.stack || error.message;
        await shot("failure").catch(() => {});
        console.error(`FAIL ${size.name}: ${error.message}`);
      } finally {
        result.scenarios.push(entry);
        await context.close();
      }
    }
  } finally {
    await browser.close();
    result.passed = result.scenarios.filter(row => row.passed).length;
    result.failed = result.scenarios.filter(row => row.passed === false).length;
    await fs.writeFile(path.join(outputDir, "viewport-journeys.json"), JSON.stringify(result, null, 2));
    if (result.failed) process.exitCode = 1;
  }
}
main().catch(error => { console.error(error.stack || error); process.exitCode = 1; });
