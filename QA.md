# QA · 2026-11-14

## Round 1 — model, raw data, calendar

Original crypto accounting coverage retained; stock long/short and a shared account ledger added. Verified isolated loss caps, actual marketable-limit stop validation, fee-inclusive 100% sizing, frozen limit funds, cancellation, duplicate-action protection, legacy backup compatibility and schema/ledger validation.

Verified US opening/closing second boundaries, EST/EDT, weekends, Good Friday, observed holidays, early closes, pre/post-market limits, and fail-closed unknown calendar years. Data fixtures cover security identity, USD, raw quote time, impossible OHLC, future/old timestamps and the separate Sina Beijing page-refresh field.

A live backend sample returned all 28 supported stocks with no missing symbols. NVDA and MU closing reference prices independently matched Tencent and Sina. This validates that sample, not perpetual source reliability.

## Round 2 — desktop scenarios and repairs

Observed real stock prices, stock day candles, crypto quotes and fallback data. Confirmed 100x stock limit at the displayed reference price stays pending off-hours; 100 USDT margin freezes exactly 105 USDT with entry fee reserved. No off-hours market fill.

Repairs: category changes select a matching instrument; stock prices/TP/SL use USD labels; history request timeout accommodates real provider latency; source refresh preserves operation buttons and chart contents; delayed/asynchronous source timestamps do not create false conflicts.

## Round 3 — mobile and deployment

Verified 440 px and 375 px iframe viewports; the 375 px page had content width equal to viewport width. Verified USD limit/TP/SL fields and selected-market visibility. Render production was live and anonymously returned all 10 crypto and 28 stock instruments. Public access removes the ChatGPT sign-in gate. All page assets and API requests are same-origin. Each browser retains its own virtual account.

Known limits: no physical-device Safari verification, no authenticated paid real-time SIP feed, and no proof of universal mainland carrier reachability. The page explicitly labels reference/delayed data and browser-driven order automation.


## Additional review — 2026-11-14

- Re-ran all 64 automated cases successfully. The deployed Render stock snapshot had all 28 symbols, with matching Tencent/Sina prices in the NVDA, MU and MSFT sample. Crypto quotes were available through the clearly labeled OKX fallback.
- Found that the original Sites URL still served the old 10-crypto release while the Render address served the 38-instrument release; both are being synchronized to version 2026.11.14.2.
- Fixed keyed list ordering and duplicate summary accumulation. Imported a valid synthetic 51-trade account through the real backup UI: exactly 50 displayed trade cards and one summary remained across refreshes and a category change, with constant 8049 px content height. Restored the previous test account from its downloaded backup.
- Submitted one small stock limit while viewing existing orders. The new MSFT order appeared above the previous MU order. Cancelling MSFT restored free balance exactly to 99,896.99 in the test account.
- Fixed remaining stock trigger-dialog USD labels, CSV instrument/market/currency headers, invalid-limit field feedback, and restored selected symbols into their scroll container without moving the page. At a 375 px test viewport, the effective 360 px content did not overflow and the selected MSFT item was visible.
- Added a server version identifier for independent verification of both production addresses.
