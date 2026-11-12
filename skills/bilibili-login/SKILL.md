---
name: bilibili-login
description: 为 B站 MCP 注入登录态。agent-browser 扫码登录并导出 Cookie，或用 chrome-devtools 读取已登录浏览器的 Cookie，写入 bilibili-mcp 配置并校验；MCP 本身不提取登录态。
whenToUse: 当 mcp__bilibili__* 工具返回未登录/-101，或首次使用 B站 MCP、Cookie 过期需要刷新登录态时。
---

# B站登录态注入（MCP 之外）

这个 skill 只做一件事：把 B站 Cookie 写进 `bilibili-mcp` 的配置。MCP server 不连接浏览器、
不读 Cookie 数据库；扫码和导出由外部工具完成，MCP 只读取 `BILI_COOKIE` 环境变量或用户配置
目录下的 `cookies.json`。

## 前置条件

- 方式 A 不需要浏览器预先登录；方式 B/C 需要浏览器已登录 `https://www.bilibili.com/`。
- 以下任一可用：
  - `agent-browser`（推荐：能打开页面、截图、`read`、导出 Cookie）；
  - `chrome-devtools` MCP（`list_network_requests` / `get_network_request`）；
  - 用户自己从浏览器开发者工具复制 Cookie。
- 方式 A 建议安装 `ffmpeg`，用来放大二维码。
- 命令都在 `bilibili-mcp` 仓库根目录执行；用 npx 安装时改用 `BILI_COOKIE`，或先 clone 仓库再执行。

## 方式 A：agent-browser 扫码（实测流程）

### 1. 打开海外登录页并截二维码

```bash
agent-browser open 'https://passport.bilibili.com/login?site=OVERSEAS'
agent-browser screenshot 'img[src^="data:image/png"]' /tmp/qr.png
ffmpeg -y -i /tmp/qr.png -vf 'scale=560:560:flags=neighbor' /tmp/qr-big.png
```

- 页面会落到英文海外登录页，左边是二维码；canvas 与 `img[src^="data:image/png"]` 两层叠着。
  **只截 `img` 这一层**，整页截图可能被 canvas 挡住。
- 截图约 140×140，直接扫容易糊；用 `flags=neighbor` 放大到 560×560，把 `qr-big.png` 发给用户。
- 二维码约 3 分钟一轮；过期就重新 `open`/刷新页面再截。

### 2. 验证登录（避开假阴性）

```bash
agent-browser open https://api.bilibili.com/x/web-interface/nav
agent-browser read
```

- **不要** `agent-browser read https://api.bilibili.com/x/web-interface/nav`。
  实测直接读 API 地址会回 `code -101`，这是假阴性。
- 必须先让页面真的跳到 nav 地址，再 `read` 当前页；确认 `isLogin: true` 和正确的 `uname`。
- 没登录成功就回第 1 步重新扫码，不要继续导 Cookie。

### 3. 导出并导入 Cookie（统一脚本）

直接管道，不落地 Cookie 文件：

```bash
agent-browser cookies get | node scripts/cookie.mjs --save --verify
```

- `--save` 把清洗后的 Cookie 写入 MCP 的 `cookies.json`；`--verify` 先请求 nav，失败不写。
- 脚本自动处理 CRLF、逐行 `name=value`，过滤 `bmg_af_sc` 等坏值；输出摘要 JSON（`mode`、`changed`、`total`、`skipped`、`verification`），不输出 Cookie 值。
- 确认 `verification.is_login: true`、`uname` 正确，`skipped` 里只有 `bmg_af_sc` 这类预期值。
- 如果只想得到 Cookie 头而不保存：`agent-browser cookies get | node scripts/cookie.mjs`。

### 4. 收尾

```bash
rm -f /tmp/qr.png /tmp/qr-big.png
```

- 二维码截图用后即删；本流程不落 Cookie 临时文件。
- 最后按下方「最终校验」复核登录态。

## 方式 B：chrome-devtools MCP

1. `select_page` 选中 `https://www.bilibili.com/`，`navigate_page` 用 `reload` 刷新。
2. `list_network_requests`（`resourceTypes: ["xhr","fetch"]`）找到 `/x/web-interface/nav`，记下 `reqid`。
3. `get_network_request` 读取 Request Headers 的 `cookie:` 整行，保留 `SESSDATA` / `bili_jct` / `DedeUserID`。
4. 通过 stdin 写入并校验：

```bash
node scripts/cookie.mjs --save --verify
# 输入来自 stdin：粘贴 Cookie，然后 Ctrl-D（Linux/macOS）或 Ctrl-Z + Enter（Windows）
```

非交互场景用 `cat cookie-header.txt | node scripts/cookie.mjs --save --verify`。
输出摘要里的 `verification.is_login` 必须为 `true`。

## 方式 C：用户手动输入

让用户在自己的终端执行 `node scripts/cookie.mjs --save --verify` 并粘贴 Cookie。
agent 只读取命令输出的摘要，不读取 Cookie 内容。

## 最终校验

调用 `mcp__bilibili__auth_status`，必须看到 `is_login: true` 和正确昵称。
刚写入 Cookie 时，运行中的 MCP 会按 `cookies.json` 的 mtime 热重载；若仍显示旧状态，重连 MCP。
`auth_status` 只返回票据刷新元数据，不返回 Cookie 值；需要写回时运行
`node scripts/cookie.mjs --refresh-ticket`。

## 安全

- Cookie 等价于账号密码；不要写入仓库、README、截图、issue 或提交记录。
- 二维码截图和默认输出的 Cookie 头都按敏感数据处理，用后即删。
- 不加 `--save` 时脚本会把 Cookie 头打到 stdout；不要把这种输出贴进日志或聊天。
- chrome-devtools 方式会让完整 Cookie 出现在工具输出中；如果会话记录可能被导出或共享，用后退出登录再重新登录。
- 只使用当前用户自己的账号，不做多账号池、批量操作或自动化滥用。

## 备选：BILI_COOKIE

在启动 `bilibili-mcp` 的 DSH profile 里设置：

```yaml
env:
  BILI_COOKIE: 'SESSDATA=...; bili_jct=...; DedeUserID=...; buvid3=...'
```

`BILI_COOKIE` 优先级最高且在进程生命周期内固定；只设置单项 `BILI_*` 环境变量时会与
`cookies.json` 合并，文件更新仍会热重载。

## 常见问题

- **导入后仍 `-101`**：先看摘要里的 `verification.is_login`；失败时脚本不会写文件，重新导出。`bmg_af_sc` 被跳过是正常的。
- **agent-browser read 返回 `-101`**：先 `open` nav 再 `read`，不要直接 `read` API 地址。
- **只读能用、写操作失败**：通常缺 `bili_jct` 或 `DedeUserID`，重新导出完整 Cookie。
- **`-352` 风控**：不要连续刷新，等几分钟再试。
