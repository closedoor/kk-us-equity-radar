# 部署到 GitHub + Render

这个项目不是纯静态网页，`server.mjs` 会提供 `/api/dashboard` 并抓取外部数据，所以要部署为 Render Web Service。

## 需要上传到 GitHub 的文件

需要：

- `public/`
- `server.mjs`
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
cd "/Users/iscream/Desktop/美股"
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
