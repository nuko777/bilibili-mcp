---
name: bilibili-browser-comment
description: 在已登录的浏览器里执行 B站图片评论脚本，发布视频/动态的带图评论；MCP post_comment 会拒绝带图，图片评论必须走这里。
whenToUse: 当用户要求在 B站视频或动态下发带图评论，或 mcp__bilibili__post_comment 因 image_paths 返回“已阻止带图评论发布”时。
---

# B站浏览器图片评论

## 为什么不用 MCP API 发图

B站网页版发表图片评论时会带浏览器生成的 `b_wet` 和 `x-bili-metadata-gaia-bin` 风控 token；MCP 的 API 路径没有这些 token，图片评论即使返回 `state=0`，也可能只有作者自己可见。

因此：

- `mcp__bilibili__post_comment` 带 `image_paths` 会直接报错拒绝，**不会发布**；
- 看到拒绝，**不要重复调用 API 发图**；
- 改用本 skill：在已登录浏览器页面中执行独立脚本 [scripts/post-image-comment-browser.js](../../../scripts/post-image-comment-browser.js)。

## 前置条件

- agent browser 已打开并登录 B站；
- 目标是视频页或动态/opus 页；
- 本地图片可以由 agent 读取为 base64（脚本不读本地路径）。

## 步骤

1. **打开目标页面**

   - 视频：`https://www.bilibili.com/video/<BV号>/`
   - 动态：`https://www.bilibili.com/opus/<动态ID>`

2. **读取图片**

   把本地图片读成 base64（不需要保留 `data:image/...;base64,` 前缀也可以）。建议单张小于 10MB。

3. **在页面上下文执行脚本**

   把 [scripts/post-image-comment-browser.js](../../../scripts/post-image-comment-browser.js) 的内容注入当前页面，然后调用：

   ```js
   await window.postBiliImageComment({
     text: "喵",
     imageBase64: "<图片 base64>",
     imageName: "7.png",
     imageType: "image/png",
     timeoutMs: 120000
   });
   ```

   如果图片有可访问的 http/https 地址，也可以传 `imageUrl` 代替 `imageBase64`。

4. **检查返回值**

   成功时返回：

   ```json
   {
     "ok": true,
     "action": "comment_browser",
     "rpid": "318...",
     "state": 0,
     "link": "https://www.bilibili.com/opus/...#reply318..."
   }
   ```

   如果 `rpid` 为空但 `ok=true`，说明页面已提交但没捕获到响应；用 `mcp__bilibili__comments` 按时间和内容确认。

5. **回读确认**

   - 视频：`mcp__bilibili__comments` + `video`
   - 动态：`mcp__bilibili__comments` + `dynamic_id`

   确认评论内容、图片和 rpid；必要时让用户用另一个账号复核是否对外可见。

## 脚本行为

- 兼容视频页和动态/opus 页的 `bili-comments` 组件；
- 自动进入评论区、激活评论框；
- 通过页面自己的图片按钮触发表单上传；
- 从 base64 构造 `File`，用 `DataTransfer` 填入 file input；
- 点击页面“发布”，并尝试捕获 `/x/v2/reply/add` 的响应；
- 不直接调用评论 API，不伪造 `b_wet` / Gaia。

## 失败处理

- 找不到评论框：确认已登录、评论区开放，先滚动到评论区；
- 找不到图片按钮 / file input：让 agent browser 使用自身的文件上传能力点击图片按钮，或检查页面 DOM 是否改版；
- 上传未完成：增加 `timeoutMs`，检查图片大小和网络；
- 发布按钮不可用：确认未触发频率限制、未登录或正文为空；
- 页面改版：优先用 `bili-comments` shadow DOM 内的 `bili-comment-box` / `.brt-editor` / `#footer button.tool-btn` / `#pub button` 定位。

## 不要做

- 不要用纯 API 重试图片评论来“碰运气”；
- 不要逆向或伪造 `b_wet` / Gaia 风控 token；
- 不要在未确认文案和图片时自动发布。
