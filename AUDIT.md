# Independent Product Audit

## Scope And Status

- Started: 2026-10-03. Baseline: product 4.7.1, scoring 4.7.0, commit 686d5f9.
- Workspace: managed `codex/radar-product-audit` worktree. Original checkout and its existing changes are preserved.
- Local application: `http://127.0.0.1:4187`. Production is read-only during this audit; publishing requires renewed approval.
- Status: local acceptance complete, product 4.7.2 prepared for release. User authorized GitHub/Render publishing in the follow-up on 2026-10-03. Earlier release test counts are historical evidence, not results of this audit.
- Evidence: `/private/tmp/radar-audit-20261003/` for machine output and screenshots; lasting conclusions and reproduction instructions remain here.

## Product And Assumptions

The product is a personal US-equity research dashboard: twelve macro, credit, employment, earnings and market signals feed a transparent risk score; users inspect drivers, source dates, AI-company snapshots and upcoming events. The primary daily task is to understand the present risk picture and its limitations, then investigate source evidence. It is not a trading system or a calibrated return/crash-probability forecast.

Personas are inferred from the product, not established by user research: a new visitor needs a comprehensible summary; a returning researcher needs trustworthy freshness and efficient source inspection; an experienced user may maintain two browser-local manual judgments. There are no accounts, roles, payments or server-side user writes, so login/permission/payment scenarios do not apply. Manual data belongs to the browser, not a shared account.

## Acceptance Priorities

1. Never present missing, stale or malformed data as a reassuring valid result. Verify dates, source provenance, coverage, model calculations and degraded-source behavior.
2. Complete first visit, inspect drivers and sources, navigate the calendar, refresh, enter/review/clear manual data and reopen. Preserve user values across retries and unrelated changes.
3. Exercise cancellation, repeated actions, input boundaries, malformed payloads, offline/timeouts, cross-tab changes and date rollover. Distinguish simulated failure evidence from live upstream evidence.
4. Verify narrow and short viewports, enlarged text, keyboard/focus and actionable feedback. Browser viewport emulation does not establish real-device or full WCAG conformance.
5. Review request validation, private-file containment, cache lifecycle, concurrent refresh and failure recovery. No destructive or production-load tests.
6. Use existing regression tests plus focused tests for newly reproduced failures. Review final changes and rerun affected and broad regression suites.

## Work Log

| Step | Evidence / Outcome | Status |
| --- | --- | --- |
| Repository and scope | Clean managed worktree at 686d5f9; README and architecture inspected; separate local port avoids user-owned 4173 server. | Complete |
| Independent review | Three real subagents audited and implemented disjoint backend/reliability, calendar and product/accessibility changes. Parent reproduced data/scoring faults, checked live sources and reviewed integration. Duplicate observations are not counted as independent evidence. | Complete |
| Fresh baseline tests and actual use | 76 automated tests and 33 browser scenarios passed in this audit. In-app browser: visited calendar, opened manual dialog, entered a draft and cancelled with Escape; normal score retained and focus returned. | Complete |
| Fixes and regression evidence | A01-A14 have focused regression evidence. Final logic/interface suite: 113 passed, zero failed/skipped; 36 browser smoke cases and 30 product cases passed. | Complete |
| Final product review | Eight unmocked real-interface user tasks passed. Final narrow-screen/calendar/driver/error-list screenshots inspected; known data and device limits retained below. | Complete |

## Issue Register

Important findings will include severity, reproduction, expected/actual behavior, user impact, root cause, fix and retest evidence. Unverified hypotheses will not be recorded as confirmed defects.

### A01: Nested Malformed Payload Replaces Good State (P1, Fixed)

- Reproduction: after a valid response, return the same JSON with `aiEarnings[0].guidanceTone = {toString: null}`; initiate a refresh. The validator accepted it; projection threw `Cannot convert object to primitive value`. The browser reported an uncaught page error, and no useful format-error banner appeared. A malformed display value/source could trigger the same class of failure.
- Expected: reject the response before assigning it to current state; retain all prior content and show a retriable data-format error.
- Impact: abnormal nested data or corrupted disk cache can break ongoing refresh and leave partially rendered UI. This is simulated corruption, not evidence of current live-feed corruption.
- Cause: top-level structural validation did not validate nested scalar fields used in formatting, lookups and links.
- Fix: validate optional display strings, financial tones/sources/stale flag, indicator source/judgment/breakdown, layer text, reminder text and calendar source status. Validate saved calendar event dates, date ranges, period labels, earnings timing and source metadata before disk hydration. Existing valid sparse fields and old stored points remain compatible.
- Red evidence: `nested display and financial fields cannot bypass snapshot validation` failed; browser `nested malformed payload cannot replace the last complete display` failed with the page error above. Screenshot in `before/` evidence directory.
- Final-review extension: `calendarSchedule.earnings.NVDA.timing = {toString: null}` was accepted and calendar resolution threw the same conversion error. A new failing validation case reproduced it before the calendar schema fix. Additional mutations cover saved source metadata, impossible FOMC dates, period labels and remembered dates. All 17 nested corruption variants are rejected.
- Retest: all 15 state/client tests passed; both malformed-response browser cases retain the original score and board, show the format-error banner and recover after the next valid response without page errors. A new actual isolated-server test rejects malformed saved calendars before hydration and returns warming rather than a broken service. Included in the 113-test final suite.

### A02: Incomplete Composite Signals Keep Full Weight (P1, Fixed)

- Reproduction: a cold start with valid spread, SLOOS and NFCI fixtures scored credit risk 35; fail only NFCI. The previous code scored 0 with the same 15% weight and high confidence. Independent agent observed total 33.9 to 29.8 and coverage unchanged at 90%. Parent reproduced the defect through an actual isolated HTTP service and a failing regression.
- Cause: complete composite formulas fell back to one surviving branch without changing availability. Policy, rates, unemployment and payroll pressure had equivalent fallback paths.
- Fix: require the declared scoring components; incomplete composites return null risk/points and lose their scoring weight, with a Chinese data-insufficiency state. Remaining observations stay visible. Existing complete-input coefficients and weights are unchanged. Credit components now have separate observation dates.
- Retest: eight dependency-outage cases (NFCI, SLOOS, curve, Sahm, claims, 2Y, policy lower bound, core PCE) verify affected indicators unavailable, weights excluded, null points and visible errors. Passed against isolated services. Last-good-cache preservation is separately covered by existing tests.

### A03: Staggered CPI Feeds Mislabel Monthly Change (P2, Fixed)

- Reproduction: latest seasonally adjusted CPI has a constructed 10% September increase, while unadjusted series end in August. Previously displayed August monthly +10%, although August change was +0.3%. Parent reproduced via HTTP; three new regression cases first failed as expected.
- Fix: headline/core and seasonally adjusted/unadjusted CPI use one common economic month before all comparisons and trend judgments. Partial month synchronization is disclosed; a missing target month pauses scoring instead of borrowing an older period. PCE retains its own explicitly labeled publication period.
- Retest: staggered-source case shows +0.3% for the correct month and agrees with an independent formula oracle; missing common month excludes inflation. Both passed. Current live cache periods were already aligned, so no observed current-production CPI value is claimed incorrect.

### A04-A06: Backend Reliability (P2, Fixed)

- A04: injected partial disk write truncated the only valid 52,887-byte cache to 127 bytes; offline restart warmed instead of using it. Delayed writes could persist old state after new state. Fix requires serialized atomic replacement and failed-write/restart/order regressions.
- A05: a real local streaming 429 peer retained 86 connections after logical refresh completion and beyond 25 seconds. No production exhaustion or crash was observed. Fix requires cancelling/aborting failed response bodies and a real-socket regression.
- A06: stalled calendar pipeline prevented any market requests until 75.064 seconds. Measured with production timers and controlled sources, not production latency. Fix requires market publication independently of unfinished calendar work, then merged calendar completion and preserved market timestamp.
- Independent backend evidence: `backend-findings.json`, `backend-audit.mjs`, `backend-results-all.json` in the evidence root. Backend-agent implementation reviewed by the parent.
- A04 fix/retest: same-directory unique temporary files, atomic rename, serialized writes and failure cleanup. Tests verify interrupted writes leave the old file valid, offline restart uses it, delayed older writes cannot overtake new ones, and a failed write does not poison later jobs.
- A05 fix/retest: abort the request in `finally`, including unread error bodies. Real local streaming-response tests verify body resources close; a separate successful-200 held-body test retains the full-body timeout.
- A06 fix/retest: start market and calendar work independently. A held calendar gate no longer delays market publication; polling sees market data before gate release and coherent dates afterward. Calendar completion updates the FOMC card without changing the market timestamp. Cache replacement compares coverage after calendar-dependent AI expiry.
- Parent reviewed the changes. All 15 backend reliability tests and the complete integrated suite pass. No claim of measured production speedup or throughput improvement.

### A07-A08: Calendar Integrity (P2, Fixed)

- A07: without remembered dates, June 24 Micron Q3 snapshot remained scoreable on October 3 and inferred December 24, despite its September 30 Q4 release. Current hydrated cache correctly excluded it. Fix must preserve the first expected quarter boundary, including a provider date already rolled to a later quarter; company-confirmed dates take precedence.
- A08: one usable company date plus seven HTTP-200 API error bodies was reported successful with no failure retry after 31 minutes. Fix must distinguish explicit provider failure from legitimate unannounced dates, retain good dates and retry actual failed companies.
- Independent evidence: `data-trust-findings.md`, `data-trust-audit.mjs`, `data-trust-results.json`. Calendar-agent implementation and boundary regressions reviewed by the parent.
- A07 fix/retest: preserve the first quarter boundary even when an automatic date has rolled farther forward. Only company confirmation may extend that quarter boundary, still subject to the 120-day ceiling. Cold-start, month-end, New York rollover, provider roll-forward and restart cases pass. Old Micron commentary stays visible as historical material and does not score.
- A08 fix/retest: reject API-reported errors, malformed types and invalid/conflicting dates; preserve saved dates and retry actual failures after 30 minutes. Genuine unannounced results are successful pending states, not failures. All-pending and all-failed behavior are tested separately.
- Live compatibility caught during integration: AVGO/MU/SKHY return a nonempty announcement label with an empty date and a vendor pending notice. Initial stricter validation rejected those bodies. Five new cases first failed, then all 39 calendar tests passed after support for these placeholders, numeric announcement dates and ancillary text. Parent independently fetched all eight actual analyst endpoints successfully. Estimates remain estimates, not company confirmations.

### A09-A12: Product Accessibility (P2, Fixed)

- A09: Chrome minimum font 20px caused 320/390px views to expand to 418px and hide calendar navigation offscreen. This is minimum-font testing, not a claimed physical phone result.
- A10: inspectable source links measured 2.78-3.01:1, below the normal-text 4.5:1 target. Fix must preserve clear link styling while improving contrast.
- A11: keyboard activation focused a risk signal but centered scrolling hid its title behind the sticky header at 320px.
- A12: five source errors exposed only three visually; the rest were available only in a mouse-hover title, with no ordinary keyboard/touch expansion. Accessibility-tree contents were not missing, so this is not falsely described as a screen-reader failure.
- Product agent owns bounded fixes and focused browser regressions. Original evidence: 39 screenshots plus measurements under `third-party-product/`.
- A09 fix/retest: navigation wraps and anchor offsets account for enlarged text. Real Chrome minimum-font-20 runs now have scrollWidth 320/390 at viewport 320/390, rather than 418. All four destinations remain accessible without shrinking the requested text size.
- A10 fix/retest: darker source/date-link color and lighter score-band labels. Targeted computed contrast now has minimum 5.08:1 in the tested sets; band labels are 9.82:1. Normal/hover/focus states checked at 390 and 1440px. This is not a complete WCAG contrast audit. Standard: https://www.w3.org/WAI/WCAG22/Understanding/contrast-minimum.html
- A11 fix/retest: scroll using the actual sticky-header height; retain keyboard focus and reduced-motion behavior. Signal headings remain visible at 320/390, short 720px view and desktop, with and without reduced motion.
- A12 fix/retest: native disclosure reveals all errors by keyboard/touch, preserves open state and focus across rendering, and moves focus to refresh if the disclosure disappears. Cases with 1/3/5/15 errors, HTTP failure/recovery and injected markup pass.
- Low-risk product improvements: company-specific accessible link names, a nearby risk-driver shortcut and a near-score rule/not-probability clarification. No claim of measured task-time or conversion improvement.

### A13: Market Refresh Has No Overall Deadline (P2, Fixed)

- Code-derived risk: 22 FRED requests with concurrency two, two attempts and 25-second body timeouts can exceed nine minutes when all stall. This is an upper-path calculation, not an observed production wait.
- Fix: one 90-second market-fetch budget covers queueing, requests, response bodies and retry delays. No queued request or retry starts after budget expiry. Calendar work retains its independent request limits. A usable cache is preserved; a cold incomplete result still obeys coverage guards.
- Retest: real local held-200 sockets plus 100x scaled clock/timers exercise a configured 90,000ms cap in about one second wall time, verify response cleanup, no late network starts, last-good preservation and a subsequent successful refresh. An expired-deadline case verifies no network call. Not a real 90-second soak test. System-clock jumps remain a low-probability limitation because the budget uses `Date.now()`.

### Upgrade Guard And Test Isolation

- Legacy disk caches with source errors predate composite-integrity checks. They cannot bootstrap unverified full composite weights. Healthy legacy caches remain compatible; versioned partial caches retain excluded weights. Three migration tests pass. New snapshots carry `dataQualityVersion: 1`; score coefficients/weights remain model 4.7.0.
- Final browser run initially had 26/30 product cases pass: four healthy/fault-isolated assertions inherited an actual transient AVGO calendar failure from the mutable fixture. This was a harness isolation defect, not a reason to suppress product alerts. Healthy fixture clones now explicitly clear calendar-source errors; dedicated injected failures and unmocked live checks remain intact. The isolated product rerun passed 30/30. Both browser harnesses use this isolation.

### A14: Refresh Button Loses Focus During Background Updates (P2, Fixed)

- Reproduction: focus the refresh button, start an update with a controlled pending response, then complete it. Native disabling removed focus and it stayed on the body. A product-details retest independently exposed the same problem after returning focus to refresh and then receiving another automatic update (29/30 passed).
- Cause: source-link focus preservation did not cover the control disabled by `loadData` itself. The first new test also exposed a harness timing mistake: it advanced the fake clock before the prior response finished. Controlled request gates and enabled-state assertions corrected that test, not the production acceptance criterion.
- Fix: remember whether refresh had focus before disabling; after re-enabling restore it only if focus is still on the body. Never override another control the user selected while the request was pending.
- Red/green evidence: replay with just the two-line focus fix removed fails the final focused-button assertion with no page errors or request failures; the controlled regression passes with the fix. It covers manual refresh, automatic refresh and choosing another control while a request is pending. The original error-details/recovery case also passes. Receipts/screenshots: `refresh-focus-red/`, `refresh-focus-green/`, `error-focus-red.json`, `error-focus-green/`.

## Live Source And User-Task Evidence

- Unmocked local acceptance: fresh Chrome context, 390x740, real dashboard API, no substituted responses and no user profile. Eight tasks passed: first visit, keyboard driver/source investigation, calendar coherence, draft cancellation, manual zero/special-text save, reload/second-tab persistence, clear synchronization and live refresh. No page errors. Receipt: `live-acceptance.json`; script: `live-acceptance.cjs` in evidence directory.
- The real server reported one transient AVGO transport failure as a partial source problem. Manual refresh subsequently cleared it using a successful live fetch. The healthy-fixture correction above did not hide that actual error.
- Real API snapshot: quality version 1, 12 signals, score 55.3, coverage 90%. Coverage is not 100 because professional EPS revision breadth is unconnected. Score is only an observed application output, not evidence of investment predictive validity.
- Live reminders: CPI October 14, FOMC October 28, employment November 6. The policy card and calendar agree. Primary schedules: https://www.bls.gov/schedule/news_release/cpi.htm ; https://www.bls.gov/schedule/news_release/empsit.htm ; https://www.federalreserve.gov/monetarypolicy/fomccalendars.htm . BLS fetching used the transparent FRED fallback; Fed and Nasdaq used their live feeds.
- Current CPI level/change cross-check used https://www.bls.gov/news.release/cpi.nr0.htm and https://fred.stlouisfed.org/series/CPIAUCNS . Current jobs period checked against https://www.bls.gov/news.release/archives/empsit_10022026.htm . Financial-release chronology checked against the Micron investor-relations September 30 release. Source checks establish the observed periods, not blanket freshness certification.
- Parent live analyst-endpoint reads: NVDA estimated November 18; TSM October 15; MSFT/GOOG November 4; AMZN October 29; AVGO/MU/SKHY unannounced. All eight HTTP/provider codes were 200 and parsed successfully. Raw four-company receipts and compatibility fixtures are in `calendar-live-provider-results.json` and `calendar.test.mjs`. Company-confirmed schedules may override provider estimates by design.
- Current source dates differ legitimately: credit OAS October 1, SLOOS July 1, NFCI September 25 are independently displayed. Monthly observation dates represent the economic period, not the publication date.

## Independent Product Decisions

The highest-value change is trustworthy interpretation, not adding more signals. The current complete-data weights remain unchanged: no new historical evidence justified another tuning round. Removing stale evidence and showing coverage are more defensible than forcing a complete score. Core positioning is a research radar with inspectable inputs; forecast probability and personal asset-allocation claims are not validated.

Future opportunities below are proposals, not completed features or established user demand. Cost labels are relative engineering judgments, not time estimates.

| Priority / Proposal | User Problem And Evidence | Expected Benefit / Cost | Risk And Validation |
| --- | --- | --- | --- |
| 1: Verify latest officially published periods | R01 reproduces valid-but-lagging HTTP-200 data after a newer release. Current live data are correct. | Detect supplier lag sooner; medium-high cost for release metadata and calendar/delay handling. | Avoid false stale alarms during postponements. Run a shadow comparison across actual releases before excluding inputs. |
| 2: Version financial snapshots and assist updates | Micron's curated Q3 commentary is now expired; date fetching cannot produce new Q4 analysis. | Less manual upkeep and less stale commentary; medium-high cost. | Wrong quarter, units or generated interpretation. Preserve official links, extracted facts and human review; compare several real company releases before scoring. |
| 3: Export/import browser-local manual judgments | Storage is correctly local and tested, but changing browser/device can lose access. Demand is a hypothesis. | Portable backup without adding accounts; low-medium cost. | Malformed import and accidental overwrite. Validate schema, preview changes, explicit confirmation and round-trip tests. |
| 4: Historical calibration before further weight changes | Rule consistency is verified; predictive usefulness is not. EPS breadth and historical qualitative vintages are missing. | Evidence-based thresholds; high data/acquisition cost. | Look-ahead and revisions. Store point-in-time inputs; out-of-sample tests, false-alert rates and benchmark comparison. |
| 5: Evaluate a compact returning-user view | Mobile page is long; near-verdict shortcut now reaches contributors. No timed user study. | Potentially faster daily review; small prototype cost. | Hiding evidence or prematurely deleting useful detail. Observe representative tasks and compare completion/errors before rearranging sections. |

Do not add login, trading execution or more overlapping risk cards without a demonstrated task. Do not remove source dates, coverage, history labels or model details to make the score look simpler.

### R01: Publication-Aware Freshness (P2, Not Yet Implemented)

- A successfully fetched August jobs series can remain inside the documented 75-day observation-age ceiling after September jobs have actually been released. Synthetic lagging-HTTP-200 fixtures reproduced this; current live/cache data contain September and are not affected.
- Age ceilings, fetched time and the observation date are distinct. A schedule alone does not establish that a release occurred during a postponement/shutdown.
- A robust extension needs verified latest-published period metadata, a provider grace interval and explicit behavior when verification itself is unavailable. Simply lowering all monthly age limits would incorrectly reject normal CPI/PCE publication lags. Remains a data-quality limitation pending that extension, not a claim of complete real-time publication verification.

## Known Limitations To Reassess

- AI financial commentary is curated snapshot content, not automatic report-text ingestion.
- Professional EPS revision breadth is not connected; its weight remains unavailable without manual input.
- Weight selection and action thresholds have no full historical/out-of-sample calibration.
- Free public feeds have differing publication delays and can throttle requests.
- Real iOS/Android devices, all browsers and a complete assistive-technology audit are not available in this environment.
- Public deployment was excluded from the initial audit; release was subsequently authorized by the user. Local acceptance is not a substitute for post-deploy verification.

## Final Acceptance And Handoff

Conclusion: the tested daily research workflow is usable and more resilient. All reproduced P1 problems and the bounded P2 defects A03-A14 are fixed with regression evidence. R01 remains an acknowledged P2 freshness limitation; this is not a claim of complete publication-aware validation, zero defects, predictive usefulness or production acceptance.

| Executed Check | Final Result | Evidence |
| --- | --- | --- |
| Syntax, data, scoring, calendar, client and isolated HTTP/reliability tests | 113 passed; zero failures, skipped or cancelled | `final-check.log`; Node 24.19 |
| Browser smoke/user-state/error scenarios | 36 passed | `final-browser.log`; `scripts/browser-smoke.cjs` |
| Independent product/accessibility scenarios | 30 passed; zero failures | `final-browser/product-results.json`; `scripts/product-audit.cjs` |
| Unmocked live local tasks | 8 passed; zero page errors | `live-acceptance.json`; `final-live-*.png` |
| Real Nasdaq analyst-date compatibility | 8 symbols parsed; actual pending/date distinction verified | Calendar receipts/fixtures and live-source table above |
| Model invariants | All 4096 availability combinations and 0-100 per-input monotonicity covered inside the test suite | `risk-model.test.mjs` |
| Patch formatting/whitespace | Passed | `git diff --check` |

Fault injection is local, not evidence of a current production outage. Browser sizes 320/390/640/720/768/1024/1440 were used across the suites; actual Chrome minimum font 20 and reduced-motion modes were exercised. The 720px zoom-equivalent case is a simulation, not physical zoom/device certification. Native iOS/Android, Safari/Firefox/Edge, Node 18, VoiceOver/full assistive technology, a long production soak/load test and live Render deployment remain unverified. Login, role permissions and payments are not applicable to this account-free read-only product. Client storage tests use isolated contexts, not user profiles.

No new blockers remain in the verified core flows. Further work now needs reliable publication metadata, financial snapshot ingestion, historical data or devices/user research; broad UI rewrites or unsupported weight tuning would not be justified by this audit. Next priorities are listed above with benefits, costs, risks and validation methods.

Changes were prepared in the attached managed worktree on `codex/radar-product-audit`. Original checkout modifications and the user-owned 4173 process were preserved. Test-generated cache churn is excluded from the release patch; its observed final values are retained in evidence. The audit's temporary 4187 test server was stopped after acceptance. The user then authorized publishing. Release preparation verified that remote main still matched the tested base 686d5f9; the audited changes are published by a non-forced fast-forward push, followed by live version/interface/browser checks. Deployment results are reported separately from the local test counts above.
