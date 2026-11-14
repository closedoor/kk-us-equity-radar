# QA · 2026-11-14

## Round 1 — model, raw data, calendar

Original crypto accounting coverage retained; stock long/short and a shared account ledger added. Verified isolated loss caps, actual marketable-limit stop validation, fee-inclusive 100% sizing, frozen limit funds, cancellation, duplicate-action protection, legacy backup compatibility and schema/ledger validation.

Verified US opening/closing second boundaries, EST/EDT, weekends, Good Friday, observed holidays, early closes, pre/post-market limits, and fail-closed unknown calendar years. Data fixtures cover security identity, USD, raw quote time, impossible OHLC, future/old timestamps and the separate Sina Beijing page-refresh field.

A live backend sample returned all 28 supported stocks with no missing symbols. NVDA and MU closing reference prices independently matched Tencent and Sina. This validates that sample, not perpetual source reliability.

## Round 2 — desktop scenarios and repairs

Observed real stock prices, stock day candles, crypto quotes and fallback data. Confirmed 100x stock limit at the displayed reference price stays pending off-hours; 100 USDT margin freezes exactly 105 USDT with entry fee reserved. No off-hours market fill.

Repairs: category changes select a matching instrument; stock prices/TP/SL use USD labels; history request timeout accommodates real provider latency; source refresh preserves operation buttons and chart contents; delayed/asynchronous source timestamps do not create false conflicts.

## Round 3 — mobile and deployment

Mobile viewport checks, persistence and deployment outcomes are recorded after execution. Public access removes the ChatGPT sign-in gate. All page assets and API requests are same-origin. Each browser retains its own virtual account.

Known limits: no physical-device Safari verification, no authenticated paid real-time SIP feed, and no proof of universal mainland carrier reachability. The page explicitly labels reference/delayed data and browser-driven order automation.
