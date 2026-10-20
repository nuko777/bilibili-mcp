---
name: bilibili-login
description: 为 B站 MCP 注入登录态。通过 chrome-devtools MCP 或 agent-browser 读取已登录浏览器的 Cookie，写入 bilibili-mcp 配置并校验；MCP 本身不提取登录态。
whenToUse: 当 mcp__bilibili__* 工具返回未登录/-101，或首次使用 B站 MCP、Cookie 过期需要刷新登录态时。
---

# B站登录态注入（MCP 之外）

这个 skill 只做一件事：把**已经登录的浏览器**里的 B站 Cookie 交给 `bilibili-mcp`。
MCP server 不连接浏览器、不读 Cookie 数据库、不做扫码登录；它只读取
`BILI_COOKIE` 环境变量或用户配置目录下的 `cookies.json`。

## 前置条件

- 浏览器已登录 `https://www.bilibili.com/`。
- 以下任一可用：
  - `chrome-devtools` MCP 工具（`list_network_requests` / `get_network_request`）；
  - `agent-browser`（能导出 Cookie 到本地文件）；
  - 用户自己从浏览器开发者工具复制 Cookie。
- 命令都在 `bilibili-mcp` 仓库根目录执行。

## 步骤

### 方式 A：chrome-devtools MCP

1. 选中 B站标签页并刷新首页：
   - `select_page` 选择 `https://www.bilibili.com/`；
   - `navigate_page`，`type: reload`。

2. 列出 XHR/fetch 请求，找到 `api.bilibili.com/x/web-interface/nav`：
   - `list_network_requests`，`resourceTypes: ["xhr","fetch"]`；
   - 找到 URL 以 `/x/web-interface/nav` 结尾的那条，记下 `reqid`。

3. 读取请求头：
   - `get_network_request`，传入 `reqid`；
   - 在 **Request Headers** 中找到 `cookie:`，复制整行值（关键项：`SESSDATA`、`bili_jct`、`DedeUserID`）。

4. 写入并校验（Cookie 通过 stdin 传入，不出现在命令行参数里）：

   ```bash
   node scripts/save-cookie.mjs --verify
   # 粘贴 Cookie，然后 Ctrl-D（Linux/macOS）或 Ctrl-Z + Enter（Windows）
   ```

   期望输出：

   ```json
   {
     "ok": true,
     "path": "<用户配置目录>/bilibili-mcp/cookies.json",
     "verify": { "ok": true, "is_login": true, "uname": "...", "mid": "..." }
   }
   ```

### 方式 B：agent-browser / 本地 Cookie 文件

1. 用 agent-browser 或浏览器扩展把 B站 Cookie 导出到本地文件（JSON 对象、`{cookies:{...}}`
   或 `Cookie:` 请求头文本均可）。不要 `cat` 该文件，也不要把内容贴进对话。

2. 导入并校验：

   ```bash
   node scripts/import-cookie-file.mjs ./cookies.txt --verify
   ```

### 方式 C：用户本地手动输入

让用户在自己的终端运行：

```bash
node scripts/save-cookie.mjs --verify
```

用户粘贴 Cookie，agent 只读取命令的 `ok` / `verify` 摘要，不读取 Cookie 内容。

## 最终校验

调用 `mcp__bilibili__auth_status`，必须看到 `is_login: true` 和正确昵称。
如果刚写入 Cookie，运行中的 MCP 会按文件 mtime 自动重载；若客户端仍显示旧状态，重连 MCP。

## 安全规则

- Cookie 等价于账号密码。不要写入仓库、README、截图、提交记录或 issue。
- `chrome-devtools` 方式会让 Cookie 出现在本轮工具输出中；如果会话记录可能被导出/共享，
  使用后在 B站退出登录并重新登录，或重新生成 Cookie。
- 不要把 Cookie 保存到 workspace；`save-cookie.mjs` 写到用户配置目录并尽量设为 0600
  （Windows 上以用户目录 ACL 为准）。
- 不要为了取 Cookie 在 MCP 里实现 CDP、Cookie DB 解密或扫码登录。
- 只使用当前用户自己的账号，不做多账号池、批量操作或自动化滥用。

## 备选方式

如果不想写配置文件，可以在启动 `bilibili-mcp` 的 DSH profile 里设置环境变量：

```yaml
env:
  BILI_COOKIE: 'SESSDATA=...; bili_jct=...; DedeUserID=...; buvid3=...'
```

`BILI_COOKIE` 优先级最高；只设置 `BILI_SESSDATA` 等单项时，会与 `cookies.json` 合并。

## 常见问题

- **找不到 nav 请求**：先刷新首页；或打开 `https://space.bilibili.com/` 再刷新。筛选 XHR/fetch。
- **Cookie 里有换行/引号**：只复制 `cookie:` 后面的值，不要带 `cookie:` 前缀和引号。
- **只读能用、写操作失败**：通常缺少 `bili_jct` 或 `DedeUserID`，重新复制完整请求头。
- **-352 风控**：不要连续刷新；等几分钟，或重新登录后再试。
- **-101 未登录**：Cookie 过期，重复本 skill。
