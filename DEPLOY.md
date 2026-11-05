# 部署到 GitHub + Render

这个项目不是纯静态网页，`server.mjs` 会提供 `/api/dashboard` 并抓取外部数据，所以要部署为 Render Web Service。

## 需要上传到 GitHub 的文件

需要：

- `public/`
- `server.mjs`
- `earnings-data.mjs`
- `publication.mjs`
- `publication.test.mjs`
- `publication-state.test.mjs`
- `earnings-monitor.mjs`
- `earnings-monitor.test.mjs`
- `earnings-state.test.mjs`
- `earnings-integration.test.mjs`
- `source-revisions.mjs`
- `source-revisions.test.mjs`
- `history-validation.mjs`
- `history-validation.test.mjs`
- `validation-evidence.mjs`
- `validation-evidence.test.mjs`
- `calendar.mjs`
- `calendar.test.mjs`
- `market-data.mjs`
- `market-data.test.mjs`
- `market-pulse-source.mjs`
- `market-pulse-source.test.mjs`
- `market-pulse-reference.mjs`
- `market-pulse.test.mjs`
- `risk-model.test.mjs`
- `dashboard-state.test.mjs`
- `dashboard-client.test.mjs`
- `manual-state.test.mjs`
- `server.test.mjs`
- `backend-reliability.test.mjs`
- `fixtures/earnings-data.json`
- `scripts/browser-smoke.cjs`
- `scripts/product-audit.cjs`
- `scripts/scoring-audit.mjs`
- `scripts/check-earnings.mjs`
- `scripts/history-validate.mjs`
- `scripts/capture-evidence.mjs`
- `scripts/build-validation-summary.mjs`
- `scripts/ci-fixture-server.mjs`
- `scripts/ci-screenshots.cjs`
- `.github/workflows/`
- `reports/`
- `evidence/forward/`（首次采集后生成）
- `evidence/source-ledger.json`（首次采集后生成的最近来源基线）
- `package.json`
- `dashboard-cache.json`
- `README.md`
- `.gitignore`
- `DEPLOY.md`

不需要：

- `*.zip`
- `*.log`
- `*.pid`
- `*.webloc`
- `start.command`
- `com.iscream.bear-market-radar.plist`
- `.DS_Store`

`.gitignore` 已经帮你排除了这些本机文件。

## 1. 创建 GitHub 仓库

1. 打开 <https://github.com/new>
2. Repository name 填：`kk-us-equity-radar`
3. 选择 `Public`
4. 不要勾选 `Add a README file`
5. 不要添加 `.gitignore`
6. 点 `Create repository`

创建后，GitHub 会显示一个仓库地址，类似：

```text
https://github.com/你的用户名/kk-us-equity-radar.git
```

## 2. 在本地上传代码

打开 macOS 终端，执行：

```bash
cd "/Users/iscream/Desktop/美股雷达"
git init -b main
git add .
git status
git commit -m "Initial public deploy"
git remote add origin https://github.com/你的用户名/kk-us-equity-radar.git
git push -u origin main
```

把 `你的用户名` 替换成你的 GitHub 用户名。

如果 `git push` 时要求登录，按 GitHub 页面提示登录即可。

## 3. 在 Render 创建 Web Service

1. 打开 <https://dashboard.render.com>
2. 登录后点 `New +`
3. 选择 `Web Service`
4. 连接 GitHub
5. 选择 `kk-us-equity-radar` 仓库
6. 填写：

```text
Name: kk-us-equity-radar
Language: Node
Branch: main
Build Command: npm install
Start Command: npm start
Instance Type: Free
```

7. 点 `Deploy Web Service`

部署完成后，Render 会给你一个公网地址，例如：

```text
https://kk-us-equity-radar.onrender.com
```

把这个链接发给朋友即可。

## 注意

Render 免费服务 15 分钟没人访问会休眠。朋友第一次打开可能需要等大约一分钟。
## 当日市场压力数据

默认发布一份有纽约日期的市场核对记录，并直接链接 Cboe 官方 VIX、VXSMH 页面。默认部署不从公开报价网页自动抓取或持续转载数据。接通获得公开展示授权的行情服务后，在服务端设置 `RADAR_MARKET_PULSE_URL` 为该服务的 HTTPS JSON 快照 URL；如需凭证，设置 `RADAR_MARKET_PULSE_TOKEN` 为 Bearer token。变量与凭证不发往浏览器。

接口契约为 `{checkedAt, quotes, errors}`。每个 `quotes` 元素为 `{symbol, value, changePercent, date, at, session, source}`。标的限 `SPX`、`RSP`、`QQQ`、`SMH`、`VIX`、`VXSMH`，不得重复。`date` 为纽约交易日 `YYYY-MM-DD`，`at` 为带明确时区的观察时间，`session` 为 `regular`、`close` 或 `unconfirmed`，`source` 为该报价可公开点击的 HTTPS 来源页。`changePercent` 相对上一常规收盘，无法核实则为 `null`；`errors` 是可以公开的简短状态文案。请勿把请求时间作为报价时间，也勿把盘后变动或没有收盘证据的延时报价标为 `close`。

行情访问与 `/api/dashboard` 相互独立。行情服务失败会保留已有报价和原观察时间，页面重新核对是否仍具备判定条件；历史记录不能替代当天未到的报价。公开站自动分发的授权范围需按供应商核对；Cboe 对开放网站的延时报价展示有单独的许可条款。
