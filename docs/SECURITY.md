# 安全说明

## 这个 MCP 能做什么

`bilibili-mcp` 是一个本地 stdio MCP Server，使用调用方提供的 B站 Cookie 访问 B站 Web API。写工具包括点赞、投币、收藏、评论、发动态、关注、私信。

## 写操作

- 所有写工具默认 **dry-run**；只有 `confirm: true` 才会真正执行。
- `coin_video` **不可撤销**；单稿最多 2 枚，执行前会检查当前已投数量。
- `post_comment`、`post_dynamic`、`send_message` 是公开/对外行为；执行前应确认目标和文案。
- 服务端对非 GET 请求默认 **不自动重试**，避免超时/网络错误导致重复评论、重复私信或重复投币。
- DSH/客户端层面的超时重试仍可能造成重复调用；重要写操作建议先 dry-run，并在执行后用对应读取工具确认。

## Cookie

Cookie 等价于账号密码。

- MCP 不读取浏览器、不解密 Cookie 数据库、不做扫码登录。
- 登录态由外部 skill/脚本写入 `cookies.json`，或通过 `BILI_COOKIE` 环境变量提供。
- `scripts/save-cookie.mjs` 通过 stdin 读取，命令行参数中不含 Cookie；`scripts/import-cookie-file.mjs` 只接收本地文件路径。
- 使用 `chrome-devtools` MCP 读取 `nav` 请求时，完整 Cookie 会出现在工具输出/会话记录中。这是当前登录流程的已知取舍；如果会话记录可能被导出或共享，请在 B站退出登录并重新登录，或重新生成 Cookie。
- 不要把 Cookie 写入仓库、README、截图、issue 或提交记录。
- 配置文件应位于用户目录；POSIX 下尽量使用 0600，Windows 下以用户目录 ACL 为准。

## 图片上传

`post_dynamic` / `post_comment` 的 `image_paths` **按设计允许读取本机任意可读图片路径**，不限制目录。这是为了方便本地工作流，但也意味着：

- 这是一个本地特权能力；不要在不可信提示、不可信 agent 或远程调用下开放写工具。
- 只上传你明确知道路径和内容的图片。
- 服务端会校验扩展名、文件签名（PNG/JPEG/GIF）、单图 10MB、单次总量 25MB，并清洗 multipart 文件名；这些检查不限制目录。
- 上传成功后图片会进入 B站 BFS，属于公开内容的一部分。

## 网络与数据

- 工具返回 B站公开数据、账号相关数据（关注、收藏、私信、通知等）。不要把私人数据提交到公开仓库。
- 媒体/关键帧缓存位于 `BILI_CACHE_DIR` 或系统缓存目录；长期使用可手动清理。
- 本项目不是 B站官方 SDK；使用时应遵守 B站服务条款和当地法律。

## 报告问题

如果发现安全问题，请通过仓库 issue 或维护者公开联系方式报告，不要在 issue 中粘贴 Cookie、SESSDATA、bili_jct 或完整请求头。
