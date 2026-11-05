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

## Maintenance execution — v4.7.3 / 2026-11-05

Base: main `fc91a13a17f0388ddfcbc7cb70b9402402017869`. This is maintenance of the existing GitHub + Render product, with no new repository, domain, runtime dependency, score weighting or scoring formula.

### Reproduced problems and fixes

- **Withdrawn provider dates:** a successful Nasdaq pending/no-date response used to preserve the provider's earlier future estimate while reporting sync success. Pending tickers now remove that provider event; failed requests retain last-known values, company-confirmed dates remain authoritative, and elapsed events are remembered before removal. Two new calendar regressions failed before the fix and pass afterward.
- **Blocking font request:** with the old Google stylesheet request held indefinitely, the browser still showed zero indicator cards after three seconds. Removing the three external font links and selecting system font stacks eliminates the request. The updated CSP no longer permits those unused font domains. Directed 320/390/1440 checks show no page errors or horizontal overflow, and mobile score/verdict labels remain in the first viewport.
- **Queued dialog close:** an old native close event can arrive after the user reopens the manual dialog, overwrite the new session's focus state and send Escape focus to the header. The handler now ignores stale/duplicate events. A deterministic rapid-reopen regression fails with the old code and passes with the fix; the original background-refresh/manual-save scenario also passed 15 consecutive repeats.
- **Resolved-source focus:** focus restoration when an error disclosure disappears no longer waits for an animation frame; a guarded microtask restores the enabled refresh control without stealing user focus.
- **Live financial content:** six old quarterly snapshots were replaced only after reading current company IR / SEC statements. Financial totals, margin definitions, forward guidance and research assessments are distinguished. NVIDIA's November 17 date is company-confirmed; Broadcom remains estimated where no readable official confirmation was established. Microsoft has an additional official guidance transcript link. The unemployment description now matches its existing month-versus-three-months-prior calculation, while separately explaining Sahm's average-based concept.
- **Test data isolation:** company snapshots and chain metadata now live in `earnings-data.mjs`. `fixtures/earnings-data.json` retains the original public data for historical fixed-clock server tests, so quarterly maintenance does not silently change their scenarios or assertions.
- **Startup test race:** the stalled-fetch regression could record request counts before the startup fetch logs reached the parent process (reproduced as 16 versus 10, or 16 versus 1). A same-stream ready marker after the initial microtask wave establishes the baseline. The strict no-extra-requests assertion is unchanged; the corrected case passed 20 consecutive repeats.

### Source verification

Official statements read on 2026-11-05 (date here is the review date, not the report release date):

| Company | Report / release | Official source |
| --- | --- | --- |
| TSM | 2026 Q3 / 2026-10-15 | https://www.sec.gov/Archives/edgar/data/1046179/000104617926000726/a3q26e_withguidancexfinal.htm |
| MSFT | FY2027 Q1 / 2026-10-28 | https://www.microsoft.com/en-us/Investor/earnings/FY-2027-Q1/press-release-webcast |
| MSFT guidance | FY2027 Q2 outlook | https://www.microsoft.com/en-us/Investor/events/fy-2027/earnings-fy-2027-q1 |
| GOOG | 2026 Q3 / 2026-10-28 | https://www.sec.gov/Archives/edgar/data/1652044/000165204426000080/googexhibit991q32026.htm |
| AMZN | 2026 Q3 / 2026-10-29 | https://ir.aboutamazon.com/news-release/news-release-details/2026/Amazon-com-Announces-Third-Quarter-Results/ |
| MU | FY2026 Q4 / 2026-09-30 | https://investors.micron.com/news/press-release/2026/Micron-Technology-Inc--Reports-Record-Fiscal-Fourth-Quarter-and-Full-Year-2026-Results/default.aspx |
| SK hynix | 2026 Q3 / 2026-10-28 | https://news.skhynix.com/en/q3-2026-business-results/ |
| NVDA next date | Official 2026-11-17 call | https://nvidianews.nvidia.com/news/nvidia-sets-conference-call-for-third-quarter-financial-results-6928873 |

MSFT/GOOG/AMZN gross margins were recomputed from reported revenue and cost/gross-profit lines, rather than inferred from another company's convention. SK hynix's 80% is explicitly operating margin. GOOG's consolidated net income is distinct from income available to common stockholders; actual capital spending and FCF are not described as next-quarter guidance. No market consensus feed was used, so the updated cards do not claim a verified consensus beat.

### Final local evidence

- `npm run check`: **115 passed, zero failures, skips or cancellations**; Node 24.22.1. Includes all 4096 missing-data combinations, model monotonicity and boundaries, data parsing, calendar, client and isolated HTTP/reliability cases.
- Browser smoke: **37 passed**, including the new close-event regression.
- Product audit: **23 passed, zero failures, 7 explicitly skipped**. This environment could run Chromium headless shell, while full Chrome failed its singleton socket initialization. Headless shell does not honor Chrome profile minimum-font preferences, so the seven actual minimum-font cases are unverified and are not counted as successful. They remain mandatory when full Chrome is selected.
- Real-network local production-server run, isolated runtime cache: **12 indicators, 8 current financial snapshots, score 45.4, coverage 90%, no market or calendar source errors**, generated at 2026-11-05T10:37:29.510Z. The score is a time-specific observed output, not an investment forecast.
- Actual-data browser checks at **320/390/1440**: twelve signal cards, eight company cards, Microsoft guidance link and v4.7.3 footer rendered; zero page errors and no horizontal overflow. Screenshots were visually inspected.
- Font-blocking directed checks: five passed. Synthetic model sensitivity scenarios: ten executed; these are not historical backtests. `git diff --check` passed.

Remaining limitations: R01 publication-aware freshness is still based on observation age, not guaranteed official latest-period reconciliation for every source; EPS revision breadth remains unconnected and excluded. Financial commentary remains a reviewed snapshot, not automatic earnings interpretation. Physical iOS/Android, other browser engines, full assistive technology, real Chrome minimum-font preferences in this environment, Node 18 and a long production load/soak test were not verified. Live deployment acceptance is tracked separately from the local evidence above.

## Continued maintenance — v4.7.4 / 2026-11-05

Base: main `ae2f8214fd96505762ec3c2b3c7447a40041ff62`. The prior release and durable QA record were read before this work. The advertised original local directory did not exist, so work used a clean clone under `/tmp/kk-us-equity-radar-next-20261105`, leaving other local projects untouched.

### R01: verified publication lower bounds, scoped to CPI and headline employment

- `publication.mjs` reads the two canonical BLS latest-release pages. It requires a report period and an embargo timestamp from the release header, validates actual calendar dates and weekday/zone consistency, and converts Eastern wall time with `America/New_York`, including DST. A future scheduled date or pre-embargo page cannot establish that data have been released.
- Evidence stores source URL, report month, actual release time, last successful `checkedAt`, and failure `attemptedAt` separately. A failed recheck retains the known lower bound and the earlier successful check time. Older returned pages and restart hydration cannot roll the known period backward; same-period corrections cannot postpone its first proven release.
- `public/publication-state.js` validates cached/API evidence and is shared by server and browser scoring. It treats the CPI indicator's aligned date as the common month of all four CPI variants; it checks UNRATE/PAYEMS separately. Known lag removes only complete dependent indicators, preserving their old observed values and dates for reading. Unknown, malformed or future evidence does not become a false reason to remove scores. Data ahead of a cached official lower bound remain usable and are disclosed.
- The rule is applied during every dashboard projection, before cache-retention comparisons, and when the API responds. This closes the route where an obsolete higher-coverage cache could otherwise continue scoring. Coverage and scoring thresholds still come from the existing shared model.
- Publication fetching runs alongside market/calendar refreshes, without delaying existing-cache responses or early market publication. The server's automatic cadence remains 15 minutes; the service's 5-minute error retry eligibility is not a promise of a separate 5-minute scheduler.
- The page shows a separate CPI/employment verification notice and links to the official releases. Publication verification errors are distinct from market errors, but are visible in the overview and source details.

Dependency propagation: lagging CPI suspends inflation, policy, unemployment composite and payroll composite; lagging UNRATE suspends unemployment composite and policy; lagging PAYEMS suspends payroll composite and policy. This follows existing formula dependencies, not new weights. Sahm is an independent real-time/vintage series and is not forced to update at BLS's timestamp.

### Evidence and tests

- Current official release headers were read from https://www.bls.gov/news.release/cpi.nr0.htm and https://www.bls.gov/news.release/empsit.nr0.htm. As of this check, both reported September 2026; actual release times were October 14 / October 2 at 08:30 ET. The November 6 employment schedule was not treated as already published.
- Baseline on this Mac: 115 original automatic tests passed. Final package check command: 149 passed, zero failures/skips/cancellations, Node 24.22.1. The bundled Node executed the same `package.json` check commands because npm was not on the local PATH.
- New coverage: 20 parser/service cases, 12 shared-publication-state cases, and two HTTP integration cases. Cases cover real release-header layouts, HTML/entities, DST and cross-year/delayed periods, embargo boundary, unknown/malformed/contradictory evidence, monotonic lower bounds, retries/coalescing, dependency propagation and unchanged inputs.
- HTTP evidence: when markets remain pending, a newly verified September CPI against August cached observations removes four dependencies, reduces a 90% fixture to 57%, pauses the aggregate score, preserves raw values and persists the evidence. An offline restart with the same evidence keeps the obsolete cache excluded and preserves the last successful check time.
- Live local production-code run, isolated cache, real upstream network: 12 indicators, coverage 90%, score 45.4, no market or publication errors. CPI proof `2026-09` / `2026-10-14T12:30:00.000Z`; employment proof `2026-09` / `2026-10-02T12:30:00.000Z`. Both matched the source months. Snapshot generated `2026-11-05T11:13:28.220Z`. HTML v4.7.4 and the new public module returned HTTP 200.
- Static bindings: 57 unique HTML IDs, 46 static script ID references, none missing. Syntax and `git diff --check` passed.

### Limits retained

Full Mac Chrome was found, but it aborted in application registration (`RegisterApplication` / `TransformProcessType`) before reaching a page. The seven actual minimum-font preference cases remain unexecuted, not passed or product failures. No permission escalation was attempted. The v4.7.3 browser counts are historical and are not reused as v4.7.4 visual acceptance.

R01 is only partly addressed: this release establishes verified lower bounds for CPI and headline employment, not publication reconciliation for PCE, credit, Sahm or all market inputs. It does not verify reported numerical values, seasonally adjusted revisions or real-time vintages. Unknown evidence falls back to existing age checks with explicit disclosure. It does not claim instant detection between 15-minute refreshes, historical predictive calibration, real-device acceptance or a long production soak. Online release verification is separate from the local evidence above.

## Further adversarial review — v4.7.5 / 2026-11-05

Base: main `d2953677683920ffe9bf536eb7e994fcd89bb454`. This review continued after the user challenged whether passing the earlier tests meant the product was complete. It did not. Three reviewers investigated data integrity, client interaction and service reliability independently; the parent reviewed the integrated patch. No score weights, complete-input formulas, action thresholds, financial snapshots, runtime dependencies or domains changed.

### Additional reproduced defects

- **A15 — mixed policy-rate bounds (P2, fixed):** with an upper bound newly updated to 3.25% and the lower bound still at the previous day's 4%, the old builder displayed `4%–3.25%` as a current interval, kept the policy indicator scoreable and returned no related error. This is a controlled upstream simulation, not an observed current production interval. Both update directions and a same-day reversed interval reproduced the failure. Raw source points now require the same date and lower <= upper. Only the policy indicator's 10% weight is suspended; its two observations remain separately visible, while the invalid combined value and market-pricing judgment are removed. The shared dashboard projection applies the same check to complete, unique saved breakdown rows, before cache comparison and on API/browser projection. Offline restart tests show an anomalous high-coverage cache cannot restore the invalid score. Incomplete legacy evidence remains compatible and is not represented as verified. Valid same-day inputs and a zero lower bound retain the original formula.
- **A16 — delayed cross-tab notification loses another field (P2, fixed):** start both tabs at AI 20 / EPS 40; tab A saves AI 80; before tab B processes its asynchronous storage event, it saves only EPS 90. The old submit handler writes AI 20 / EPS 90. Submission now rereads persisted values, overlays this page's changes from failed writes, and then applies fields actually changed from the open dialog. The last successfully observed persistence snapshot tracks pending edits and deletions. Successful reads followed by failed writes, repeated failures, later retries and storage events cannot silently roll back those pending changes. A read failure keeps current memory. This closes the demonstrated already-written/notification-delayed sequence; localStorage read-merge-write is still not a fully atomic transaction across genuinely simultaneous tabs.
- **A17 — disappearing risk driver loses keyboard focus (P2, fixed):** focus a top-three driver, then refresh so that it exits the list. The old render removes the focused node and cannot find its old key, leaving focus on the body. Rendering now restores a matching visible replacement, falls back to the first remaining driver or the persistent manual control, and leaves a different control's newly acquired focus alone.
- **A18 — unread client error response survives rejection (P2, fixed):** a real local HTTP peer returned 503 headers and an indefinitely open body. Three rejected client requests left three error response bodies/sockets active after their deadlines had been cleared. The client now aborts its controller in `finally`, after preserving the original error classification. The real-socket regression verifies cleanup, keeps the 503 error message, and successfully reads a following normal JSON response; the existing complete-body timeout remains covered.
- **A19 — descriptions exceed implemented inputs (P2, fixed):** the rates card implied that its score used rising speed, and the payroll card implied historical revision vintages, hours and sector detail. Their actual formulas use rate levels/curve and current payroll totals/differences, respectively. The descriptions now identify the actual inputs and omitted dimensions. Artificially adding these inputs or adjusting coefficients was outside this fix. Manual-score source links now identify public reference material and explicitly distinguish it from the source of the user's judgment.

### Fresh evidence for this release

- The exact `package.json` check script ran with bundled Node 24.22.1: **172 tests passed, zero failed/skipped/cancelled**, 50.4 seconds. This includes 12 added policy test records (five top-level cases plus seven subtests), ten manual-state cases and one real HTTP client cleanup case. The 149 earlier tests were rerun as part of this release; they are not added again to inflate the count. Syntax and `git diff --check` also passed.
- The new anomalous-policy cases failed before the production guard; valid controls already passed. The actual old application submit handler failed the delayed-event scenario (`20 !== 80`) and the new handler preserved AI 80 / EPS 90. Executing the actual render/driver functions in a Node VM reproduced focus on `body` before the change and passed replacement, stable-key and no-focus-theft cases afterward. These are controlled function-level executions, not actual browser acceptance.
- Three new browser smoke scenarios are committed: delayed cross-tab notification, storage write failure followed by later save/read failure, and a driver leaving the top three. They were **not run** here: the previously diagnosed Mac Chrome application-registration crash remains unresolved, and the same broken launch was not repeatedly retried. Earlier browser pass counts and minimum-font results are not reused for v4.7.5.
- An isolated production-code server made real upstream requests and settled at `2026-11-05T11:38:53.244Z`: twelve indicators, 90% coverage, observed score 45.4, no market or publication errors. Both policy bounds were dated `2026-11-04` and formed a valid 3.75%–4% range; publication checks remained current. HTML v4.7.5 and all five requested JavaScript modules returned HTTP 200. This checks the actual network path without claiming a new visual/device result or a forecast.
- Temporary raw evidence: `/tmp/radar-v475-final-tests.log`, `/tmp/radar-v475-live-qa.json`, `/tmp/radar-manual-submit-{red,green}.log`, `/tmp/radar-render-focus-{red,green}.log`. `/tmp/radar-policy-20261105/{red,green}.log` contains labeled excerpts of captured results, not a reconstructed full stdout transcript. The durable reproduction and limits are recorded in this file; publication and online byte verification follow separately.

### Product gaps that passing these tests does not settle

1. **Model usefulness:** no complete historical or out-of-sample validation supports the weights or action thresholds. A credible evaluation needs dated source vintages, publication times, explicit outcomes/horizons and comparisons against simple baselines, with look-ahead leakage excluded. Synthetic monotonicity and missing-data checks cannot establish predictive value.
2. **Data completeness and operations:** professional EPS revisions remain unavailable, AI report interpretation remains manually maintained, and publication reconciliation still covers only CPI/headline employment. PCE, credit, revisions and report-update workflows need separate source-backed work and acceptance criteria.
3. **Actual usability:** new-browser, real iOS/Android, other engines, assistive technology and observed user tasks remain verification gaps. The current environment cannot turn these into passes. Cross-tab atomic storage and a long production soak are also still unverified.

This release resolves specific newly demonstrated failures. It is not a claim that the product is perfect, its scores are calibrated, or further defects have been exhausted.

## Validation and maintenance infrastructure — v4.8.0 / 2026-11-05

Base: main `3336e2a4168b98c19b2fa64cc430b1dcfe4abd5d`. The user authorized solving the remaining validation and upkeep gaps. This release implements actual source monitors, reproducible historical diagnostics and prospective observation storage. Scoring weights, complete-input formulas, score bands and scoring version **4.7.0** stay unchanged; the product version is **4.8.0**. Research prompts replace uncalibrated allocation instructions while keeping the existing action keys and band boundaries for compatibility.

### Historical evidence, including unfavorable results

- `scripts/history-validate.mjs` calls the production indicator/scoring pipeline in a frozen isolated runtime. It checks all 28 quarter ends from 2019 Q1 through 2025 Q4, rather than selecting crisis dates. ALFRED columns must match the requested vintage exactly; observations after the as-of cutoff cannot enter. Historical AI judgments and EPS breadth are explicitly absent.
- Twenty macro series had verified historical vintages. Historical SP500 and high-yield-spread vintages were not available through the tested public route. The benchmark uses currently fetched historical SP500 closes; market breadth uses currently fetched Nasdaq price history. The entire credit composite's 15% is excluded instead of substituting revised current data. AI and EPS add another 15% excluded weight. This is a **partial diagnostic with a maximum 70% coverage**, not a completed twelve-signal point-in-time backtest.
- Actual coverage: 25 periods at 70%, two early periods at 62% because Sahm had no contemporaneous archive, and one period at 37% because PCE exceeded its existing age limit. The 37% period remains unscored. There are **27 scoreable periods out of 28**; both 21- and 63-observation outcomes are mature for all 28 dates. Scored-period baselines use the same 27 dates as score bands; the separate scheduled baseline retains all 28.
- The risk bands do not show a stable monotone relation across horizons. The two highest bands contain only two and one scoreable observations. A low score in late 2019 was followed by the COVID drawdown; that is evidence against treating low rule scores as a guarantee, not proof that a single external shock invalidates every contemporaneous risk measure. No weights or thresholds were fitted to improve this report.
- The first real run made **75 bounded source requests**, with zero unexpected source failures. Final-source offline replay made **zero network requests** and reproduced every score, coverage, indicator, outcome and summary number. Later source/input hashes are additional lineage, not a claim that metadata bytes from development runs were identical. Four representative outcomes were independently recomputed directly from cached SP500 data using a separate peak/trough oracle; these spot checks are not added to the automatic-test count.
- The durable report `reports/history-validation-2019-2025.json` records retrieval receipts/hashes, input hashes, production-file hashes, the starting Git base and dirty working-tree status, intentional judgment placeholders, exclusions, overlapping-window counts and explicit false claims for full-model validation, independent out-of-sample validation, calibrated probability and allocation thresholds. Raw bulk price files remain outside the public report. `scripts/build-validation-summary.mjs` derives the visible summary; the website links both summary and complete report.

### Prospective observation storage

- `scripts/capture-evidence.mjs` reads the actual public dashboard API, validates its completed nonexpired state and numeric reference, rejects active manual overrides, and retains unavailable placeholders and source-outage days. It stores the displayed model score/coverage, per-indicator state, actual capture/generation times, producer version/commit, publication evidence, observed revisions and an integrity hash. It does not invent earlier observations.
- One immutable first record is retained for each New York date/model version. Exclusive linking prevents replacement on rerun; corrupt existing evidence is rejected. Benchmarks start at the first actual market close strictly after the capture's New York date, never at an older cached reference close. Duplicate dates cannot inflate samples; conflicting prices, future prices/captures and mixed model versions are rejected. Outcomes remain null until enough actual price observations arrive. Low-coverage null scores are counted as excluded, not as calm zero scores or samples that will become scoreable by waiting.
- A failed benchmark fetch preserves prior confirmed statistics with their old evaluation time, marks the source error, and still preserves the new actual observation. The page hides unverified maturity counts during such an outage. No mature sample or return result is claimed before it exists.
- `.github/workflows/capture-evidence.yml` schedules collection at 22:30 UTC Monday–Friday: Tuesday–Saturday 06:30 in Asia/Shanghai. Actual capture times are authoritative; scheduled execution is not a promise of an exact minute. Captures and `public/forward-validation.json` are committed to repository history, avoiding reliance on Render's transient disk for prospective evidence. Future price windows overlap and remain descriptive, without probability calibration, dividends, transaction costs or a trading strategy.

### Publication, report and revision integrity

- BEA PCE now joins CPI and headline employment. The monitor starts from the fixed PCE index page, follows only a validated same-origin Current Release article, and verifies report period, actual embargo, Eastern offset/weekday consistency and no future release. The canonical source and validated article URL are retained. Old two-source publication caches remain readable; unknown PCE evidence is disclosed.
- Inflation stores explicit headline/core PCE input dates. Core PCE is the actual score dependency; headline PCE is display information. A verified newer core-PCE period removes the existing inflation/policy/unemployment/payroll dependencies. Legacy caches use only a uniquely parseable saved core-PCE period; explicit null never falls back to display text. New HTTP tests verify 90% to 57% coverage, raw-value retention, persistence and offline restart without revival.
- Six publicly traded US companies use SEC formal reports; TSM requires an actual quarterly results exhibit and excludes monthly revenue 6-Ks; SK hynix uses its official financial-results RSS. Same-quarter late filings, future calls, contradictory periods and changed fiscal-calendar assumptions do not manufacture a new quarter. Confirmed newer reports set a derived review requirement; older prose/tones remain unchanged and leave automatic AI scoring. Updating reviewed period and release date resets the requirement from evidence rather than a sticky flag. Unknown or delayed sources stay explicit; formal filings can arrive later than press releases.
- All eight official report checks succeeded on the real-network verification, with no false newer-quarter alert against the current reviewed content. Applying the same actual proof to the older fixture correctly identifies six newer quarters without changing its prose or tones. Actual HTTP regressions cover refresh, valid high-coverage old caches, restart, same-quarter controls and killing the process while another source is still held.
- `source-revisions.mjs` retains up to 400 raw points for each of the 22 FRED inputs and the latest 100 revision events. Only a changed value for the same source/date is a revision; a new date is not. Failed or empty sources retain their previous points. Floating-point values are compared before display rounding. Hydration rejects future/corrupt metadata and validates event chains and final values; repeated refresh/restart does not create duplicate events. Ordinary API responses expose only labeled notices; the explicit read-only `?evidence=1` export supplies the source ledger to the collector. The latest valid baseline is checkpointed to `evidence/source-ledger.json` and restored when a fresh host has no runtime ledger. The immutable daily score record is not overwritten when this checkpoint advances. This observes supplier revisions from the first capture onward; it does not reconstruct all past official revisions.
- Fresh source spot reconciliation read eight actual official/provider pages and matched six CPI/employment values at publication precision. These are review-time checks, not a permanent gate against an old initial-release number: legitimate revisions must not be treated as errors.

### Reproduced integration coupling and repair

The first final suite had one real failure: CPI proof was usable in memory, but the newly added held PCE source delayed aggregate publication completion and disk persistence. Removing the old cache assertion would have hidden a restart risk. Publication and earnings services now notify after **each source's state update**, independently persisting completed proof while unrelated fetches remain pending. Notification-write errors are logged separately and cannot change provider success into provider failure. The original CPI assertion stays; gated service tests and a real earnings HTTP kill/restart case fail when only this notification is disabled and pass with it enabled.

The stalled-refresh test also gained a deterministic ready marker after both rate-limited initial SEC calls start. Strict request-count equality remains unchanged. Browser acceptance found one obsolete shared status-copy assertion used by four cases; only that text expectation was synchronized with the new research-data wording, keeping all error counts, disclosure, visibility and keyboard assertions. Failed runs remain failed evidence, rather than being combined with later passes.

### Acceptance evidence

- Exact final package check with Node 24.22.1: **259 passed, zero failed/skipped/cancelled**, about 64 seconds. Includes parser/state, history/evidence, revision-chain, source-monitor, deployment-checkpoint and isolated HTTP/restart/resource tests. The initial 249-pass/one-failure run is superseded only after the production coupling repair and complete reruns.
- Independent real-network isolated production-code run: twelve indicators, 90% coverage, observed score 45.4, **three publication checks, eight report checks and 22 ledger sources**, no market/publication/earnings errors. Private source ledgers were absent from the API; the numeric benchmark reference and new module routes were present. Snapshot `2026-11-05T12:36:17.546Z` is an observed result, not a forecast.
- Static bindings: 63 unique HTML IDs, 51 static script references, none missing. Syntax and `git diff --check` passed.
- Remote candidate `cec1bcf1a2f5cc0454789338c459e6663b3ecb8d`, [run 42030952947](https://github.com/closedoor/kk-us-equity-radar/actions/runs/42030952947), passed its own 255 automatic tests and **84 browser scenarios**: 46 smoke, 30 product, four Chromium journeys and four Linux WebKit journeys. Seven genuine full-Chromium minimum-font checks are included in the 30, not added again. All zero skips. Screenshots and artifact digest were checked, including phone model history, eight-source report status, new-report review links and WebKit financial cards. This candidate predates the two additional checkpoint HTTP cases; release-main acceptance is recorded separately. Earlier failed runs are not combined into a fictional pass.

### Limits that remain material

The complete model has not passed predictive or allocation calibration. The historical subset is partly revised market history, has small high-score cohorts and overlapping outcomes, and is not independent out-of-sample evidence. Future observations need real time to mature. AI interpretation remains reviewed research; automation detects new documents and pauses outdated use, rather than inventing analysis. PCE/CPI/employment publication lower bounds and supplier revision tracking do not establish complete official numerical/vintage reconciliation for every source. Linux browser and touch/viewport simulation do not verify a physical iPhone, iOS Safari, native keyboard, all assistive technology or a production load soak.

Deployment checkpoints also retain publication and report proof using the services' own monotone hydration. A newer failed check cannot erase the last successful report timestamp or known reports; both merge orders are tested. A fresh-host HTTP test with an empty raw ledger restores a confirmed newer CPI period before held upstream requests finish, immediately reducing an obsolete 90% board to 57%. Corrupt or future checkpoints are ignored without breaking an otherwise valid board. The collector can advance this checkpoint while preserving the first immutable daily score record; a benchmark outage does not roll either artifact backward.

### Published-main acceptance and first actual observation

- Release main: `d3c53e3b2124b1481d6fd907178f29ae88c3f7e4`. Its own [Product QA run 42034668952](https://github.com/closedoor/kk-us-equity-radar/actions/runs/42034668952) completed successfully: **259 automatic tests and 84 browser scenarios**, zero failures/skips. The browser total is 46 smoke + 30 product + four Chromium + four Linux WebKit; the seven genuine minimum-font cases are within the 30. The fixed zero-maturity test now injects an explicit fixture, so real prospective results can mature without breaking that regression. The main artifact digest and representative new screenshots were checked; these remain recorded-fixture desktop/browser simulations, not actual iPhone certification.
- [Forward capture run 42034669007](https://github.com/closedoor/kk-us-equity-radar/actions/runs/42034669007) succeeded and committed actual production evidence as `cea7fcbd91b1cf174e9bd0493a5911071d34fb10`. The first record is `evidence/forward/2026-11-05_model-4.7.0.json`, captured at `2026-11-05T13:19:25.286Z`, scoring version 4.7.0, observed score 45.4 and coverage 90%. Its integrity hash/schema were independently checked. The checkpoint has 22 source baselines plus valid three-source publication proof and eight-company report proof. The scheduled workflow is installed on main and its first automatic run succeeded.
- Both 21/63-day cohorts currently have **one waiting sample, zero mature outcomes, null return/drawdown statistics**, with no benchmark error. These are honest pending observations, not a claim that prospective validation has passed.
- Actual site verification checked ten deployed assets byte-for-byte against the release and validated the live API/explicit evidence export. A second check after the automatic commit observed build `cea7fcbd...`, version4.8.0 and one live forward sample, with zero market, publication or earnings errors. The three official periods and eight report states remained coherent after the checkpoint deployment. Temporary receipt: `/tmp/radar-v480-online-acceptance.json`; durable records and reproduction details are in this repository.
