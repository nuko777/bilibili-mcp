---
name: bilibili-browser-comment
description: 用 agent-browser 一条命令发布 B站视频/动态图片评论，自动注入 MCP Cookie 并返回 rpid/has_image。MCP post_comment 会拒绝带图，图片评论走这里。
whenToUse: 当用户要求在 B站视频或动态下发带图评论，或 mcp__bilibili__post_comment 因 image_paths 返回“已阻止带图评论发布”时。
---

# B站浏览器图片评论

## 为什么不用 MCP API 发图

B站网页版发表图片评论时会带浏览器生成的 `b_wet` 和 `x-bili-metadata-gaia-bin` 风控 token；MCP 的 API 路径没有这些 token，图片评论即使返回 `state=0`，也可能只有作者自己可见。

因此：

- `mcp__bilibili__post_comment` 带 `image_paths` 会直接报错拒绝，**不会发布**；
- 看到拒绝，**不要重复调用 API 发图**；
- 改用本 skill 的 agent-browser 一条命令。

## 前置条件

- 已安装 [`agent-browser`](https://github.com/vercel-labs/agent-browser)，且能执行 `agent-browser eval`；
- Node.js 24+（agent-browser 的 npm 包要求）；
- MCP 的 Cookie 仍然有效（默认读 MCP 配置里的 `cookies.json`），或传 `--cookie-file` / `BILI_COOKIE`；
- 本地图片存在；支持 jpg/jpeg/png/gif，单张建议小于 20MB。

## 一条命令

```bash
node scripts/post-image-comment-agent-browser.mjs \
  --url https://www.bilibili.com/video/BV1ZN4y1x74v/ \
  --image /path/to/comment.jpg \
  --text "@汐儿不是鱼 喵"
```

只输出 rpid 和是否带图：

```bash
node scripts/post-image-comment-agent-browser.mjs ... --quiet
# rpid=319... has_image=true
```

先检查 agent-browser、Cookie 注入和页面打开：

```bash
node scripts/post-image-comment-agent-browser.mjs --probe \
  --url https://www.bilibili.com/ --quiet
```

可选参数：

- `--cookie-file <path>`：用指定 Cookie 文件，而不是 MCP 的 `cookies.json`；
- `--no-cookie`：不注入 Cookie，沿用 agent-browser 当前登录态；
- `--cookie-domain <domain>`：默认 `.bilibili.com`；
- `--timeout <ms>`：页面脚本超时，默认 120000；
- `--agent-browser <path>`：agent-browser 可执行文件，也可用 `AGENT_BROWSER_BIN`。

## 内部流程

1. 读 MCP Cookie，用 `agent-browser cookies set` 逐项注入 6 个登录 Cookie，避免浏览器自带登录过期；
2. 用 Node 读取页面脚本和图片，在内存中生成 JS payload，直接 `agent-browser eval --stdin` 注入，不经过 shell 大字符串；
3. 读取/轮询阶段遇到临时错误会重试；启动发布的 eval **不重试**，避免重复发评论；
4. 在 CLI 进程内轮询 `window.__biliResult`，不需要外部 `sleep`；
5. 页面脚本跟踪所有可观察的 fetch `upload_bfs`，等待上传成功和组件状态稳定；
6. 发布前拦截可观察到的 fetch/XHR `/x/v2/reply/add`，请求体没有非空且带有效 URL 的 `pictures` 就抛错；
7. 返回结果包含 `rpid`、`has_image`、`picture_count`、`pictures`。

## 返回与判定

成功：

```json
{
  "ok": true,
  "rpid": "319...",
  "state": 0,
  "has_image": true,
  "picture_count": 1,
  "pictures": [
    {
      "url": "https://i0.hdslb.com/bfs/new_dyn/...",
      "width": 1317,
      "height": 1230,
      "size": 258.741
    }
  ],
  "link": "https://www.bilibili.com/video/BV.../#reply319..."
}
```

- `has_image=false` 时 CLI 退出码为 2：评论可能已经发出，但图片没有确认，先检查评论列表，不要直接重试；
- 返回 `ok=false` 的 error：没有发布，按错误处理；
- 发布后必须用 `mcp__bilibili__comments` 按时间和内容回读，确认 `pictures` 非空、`mentions` 正确、`state` 正常；
- 需要他人可见性验证时，让用户换账号看这条评论。

## 失败处理

- `agent-browser` 不存在：先安装并运行 `agent-browser install`；
- Cookie 过期：用 `bilibili-login` skill 重新注入 MCP Cookie，或传有效的 `--cookie-file`；
- 找不到评论框/图片按钮：确认已登录、评论区开放；页面改版时优先检查 `bili-comments` shadow DOM；
- `评论请求没有 pictures，已阻止发布`：图片没有挂到表单上，脚本已阻止纯文本评论；刷新页面后重试，或改用 agent-browser 的 `upload <selector> <files>` 直接上传文件；
- 等待 `__biliResult` 超时：评论可能已经发出，先查评论列表，**不要直接重试**。

## 不要做

- 不要用纯 API 重试图片评论来“碰运气”；
- 不要在未确认上一条是否发出时重复执行命令；
- 不要移除“无 pictures 则中止”的保护。
