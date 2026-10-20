# Review 处理状态

本文件记录一次内部代码审查后的处理结果，便于后续维护者了解哪些风险是已知的、哪些是刻意保留的。

## 已修复

- **非 GET 请求默认不重试**：避免评论/私信重复发布、投币已扣款但返回失败；点赞对 65004/65006 做了幂等处理。
- **写请求显式 `retry: 0`**：评论、动态、投币、收藏、关注、私信。
- **图片文件检查**：PNG/JPEG/GIF 魔数、单图 10MB、单次总量 25MB、multipart 文件名清洗。
- **WBI 编码统一**：签名和最终 query 使用同一个编码函数；已用带空格/特殊字符的搜索关键词实测。
- **HTTP 4xx 处理**：非 2xx 且空 body 不再静默返回 `{}`；403/412/429 有明确提示。
- **工具参数运行时校验**：必填、类型、enum、min/max、multipleOf、数组 items；字符串 `"false"` 不会反转布尔写操作。
- **Cookie 热重载**：每次 `tools/call` 检查 `cookies.json` mtime；文件更新后重建 client。
- **坏 Cookie 文件不阻止启动**：JSON 解析错误只记录安全提示，不把解析器消息（可能含片段）写进日志。
- **Cookie 环境变量合并**：单项 `BILI_SESSDATA` 等与文件合并；`BILI_COOKIE` 仍是完整覆盖。
- **`save-cookie --verify` 先验证再覆盖**：失败时保留旧文件。
- **评论参数校验**：`video`/`dynamic_id` 二选一；`parent` 必须配 `root`；状态未知返回 `visibility_unknown`。
- **`post_dynamic` 先 dry-run 再检查 CSRF**。
- **分页整数化**：小数页码截断，不再索引越界。
- **`tags_complete`**：标签请求失败时为 false。
- **`video_frames`**：120s 整体预算、单帧 30s；无 ffmpeg 返回整张雪碧图；空 `times` 拒绝。
- **`video_info`**：标签/字幕失败分别返回 `tags_error` / `subtitle_error`，不拖垮整个工具。
- **MCP 协议**：batch 返回单数组、未知版本回退、空 batch/-32600、`id:null` 拒绝、顶层 title。
- **ffmpeg 路径**：移除本机绝对路径，改用 `BILI_FFMPEG` + PATH + 常见安装目录。

## 刻意保留（按项目所有者决定）

- **图片路径不限制目录**：`image_paths` 可读取本机任意可读图片。这是本地特权能力；只做魔数/大小/文件名检查。见 `docs/SECURITY.md`。
- **登录 skill 会让 Cookie 出现在工具输出**：当前流程使用 chrome-devtools 读取 nav 请求，完整 Cookie 会进入会话记录。这是已知取舍；如会话记录可能外泄，使用后轮换 Cookie。

## 仍未处理（非阻塞）

- 大整数 ID 的完全无损解析（已优先使用 `*_str` 字段，但没有专用 JSON parser）。
- 通知点赞接口的分页语义、私信会话数上限与 schema 的完全对齐。
- 媒体缓存自动清理（下载有 20MB 上限，帧返回有总大小上限）。
- 部分 P3 死代码/文档细节。
