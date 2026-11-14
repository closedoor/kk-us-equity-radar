# 环球模拟盘 · 美股与加密

Chinese-language paper trading with 100,000 virtual USDT, browser-local accounts and 1–100x isolated leverage. No real orders, account credentials, deposits or exchange connection.

## Instruments

10 crypto assets: BTC, ETH, SOL, BNB, XRP, DOGE, ADA, AVAX, LINK, DOT.

28 US equities/ETFs: NVDA, AMD, AVGO, INTC, QCOM, ARM, TSM, ASML, AMAT, LRCX, KLAC, SMH; MU, STX, WDC, SNDK; MSFT, ORCL, PLTR, CRM, ADBE, NOW, CRWD, SNOW; AAPL, GOOGL, AMZN, META.

## Data and execution

- Crypto: Binance public spot data; transparent OKX spot fallback. Quotes expire at 30 seconds. Polling every 4 seconds.
- Stocks: Tencent Finance quote feed with Sina Finance verification/fallback. Quote identity, USD currency, source timestamp and OHLC are validated. Prefer newer regular-session quotes; compare independent sources only at effectively the same timestamp or for closing prints. Same-time material conflicts disable execution.
- US source time is parsed as America/New_York, with explicit EST/EDT handling for Sina. Its Beijing page-refresh timestamp is never substituted for quote time.
- Stock reference data may be delayed. Delays over two minutes are labeled, and reference quotes up to 20 minutes old can be used for clearly labeled delayed simulation. Older, wrong-session, future or conflicting data cannot execute.
- Stock execution runs only during the regular NY session, with weekends, holidays, early close and daylight saving handled for 2026–2028. Unknown calendar years fail closed. Off-hours limit orders reserve funds and remain queued.
- Stock candles are genuine Tencent forward-adjusted daily data. Weekly/monthly bars aggregate actual daily OHLCV. Stock trading reference prices are unadjusted. No invented price/history fallback.
- Market, limit, cancellation, absolute TP/SL, isolated liquidation and per-position long/short. Fees 0.05% of notional per side; maintenance 0.5% plus projected exit fee. Isolated losses cannot consume unrelated free cash.
- Stocks are simulated CFDs, not exchange-listed futures/options. USD stock prices settle at the explicit virtual equivalence 1 USD = 1 USDT. Funding, slippage, dividends and corporate-action adjustments to held positions are not modeled.
- Orders/TP/SL/liquidation are browser-driven. Closing/suspending the page pauses them; fresh quotes are used on return without replaying the offline path.

## Accounts and public access

Each visitor's account is stored only in that browser. The original v1 storage key and ledger remain compatible. Web Locks serialize same-origin tabs. JSON backups validate ledger balance, symbols, fees and timestamps; CSV exports retain signed numbers. Different origins/devices have independent accounts, transferable by backup.

The production UI, scripts, styles and fonts are self-contained. Browsers call only the site's own API; blocked overseas quote/CDN domains are not required on visitors' devices. Public deployment does not require a ChatGPT account. Actual mainland carrier reachability must be verified on those networks; an international smoke test is not mainland verification.

## Run and test

Requires Node 22+. No npm dependencies.

- `npm start`: standalone Node server for Render, binding 0.0.0.0 and PORT.
- `npm run dev -- --port 4173`: local preview; development-only `/__qa/mobile?width=440` or `375` iframe viewports.
- `npm test`: deterministic accounting, market calendar, data parsing, source reconciliation and HTTP contract tests.
- `npm run build && npm run validate`: dependency-free Worker deployment artifact for the canonical Sites checkout.

## QA

Three rounds: engine/data/calendar tests; desktop live-feed and limit/cancel flows; phone viewport, persistence, multi-market and production checks. See QA.md. Physical iPhone/Safari and continuous offline operation are not represented as tested.

## Sources

- https://developers.binance.com/docs/binance-spot-api-docs/faqs/market_data_only
- https://www.okx.com/docs-v5/en/
- https://gu.qq.com/
- https://finance.sina.com.cn/stock/usstock/
- https://www.nyse.com/trade/hours-calendars
