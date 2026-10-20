# 设计与实现

## 目标

为 DSH 和任意 MCP 客户端提供 B站 Web API 的读写能力，重点是：

- 榜单/热门/每周必看的内容发现；
- 视频信息、字幕、关键帧的内容理解；
- 评论、动态、私信、关注、收藏等互动；
- 登录态外置，MCP 本身不提取浏览器 Cookie；
- 零运行时依赖，单进程 stdio 接入。

## 架构

```text
MCP client (DSH / Claude Desktop / ...)
        │ stdio JSON-RPC 2.0
        ▼
src/server.mjs
  ├─ initialize / tools/list / tools/call / ping
  ├─ Cookie 文件 mtime 检查与热重载
  ├─ 工具参数校验（required/type/enum/min/max/items）
  └─ src/tools/index.mjs（29 个工具）
        ├─ src/api/*      业务 API 与字段归一化
        ├─ src/core/*     HTTP、WBI、Cookie、配置、错误
        └─ src/media/*    字幕、关键帧、播放流、ffmpeg
```

## 读工具（22）

- 账号：`auth_status`
- 榜单：`rank_list`、`popular_list`、`weekly_issues`、`weekly_list`、`precious_list`
- 视频：`video_info`、`video_transcript`、`video_frames`、`video_comments`、`related_videos`
- 搜索/用户：`search`、`user_info`、`user_videos`
- 社交：`list_followings`、`list_followers`、`list_favorites`
- 消息：`notifications`、`messages`
- 动态/历史：`dynamic_feed`、`history`、`toview`

## 写工具（7）

`like_video`、`coin_video`、`favorite_video`、`post_comment`、`post_dynamic`、`follow_user`、`send_message`。

全部默认 dry-run；`confirm === true` 才发送写请求。非 GET 请求默认不重试。

## 关键接口

| 功能 | 接口 |
|---|---|
| 登录态 | `/x/web-interface/nav` |
| 排行榜 | `/x/web-interface/ranking/v2` |
| 综合热门 | `/x/web-interface/popular` |
| 每周必看 | `/x/web-interface/popular/series/list`、`series/one` |
| 视频详情 | `/x/web-interface/view` |
| 字幕 | `/x/player/wbi/v2` |
| 关键帧 | DASH `playurl` + `ffmpeg`；`/x/player/videoshot` 回退 |
| 评论 | `/x/v2/reply/wbi/main`、`/x/v2/reply/add` |
| 点赞/投币/收藏 | `/x/web-interface/archive/like`、`coin/add`、`/x/v3/fav/resource/deal` |
| 动态 | `/x/polymer/web-dynamic/v1/feed/all`、`/x/dynamic/feed/create/dyn` |
| 图片上传 | `/x/dynamic/feed/draw/upload_bfs` |
| 私信 | `/svr_sync/v1/svr_sync/fetch_session_msgs`、`/web_im/v1/web_im/send_msg` |
| 关注 | `/x/relation/modify` |

## 认证与签名

- Cookie 来源：`BILI_COOKIE` 完整头，或 `cookies.json` + 单项环境变量合并。
- CSRF：写请求使用表单字段 `csrf`（不是 `csrf_token`）。
- WBI：`wts` + `w_rid`；签名和最终 query 使用同一个编码函数，避免 `%20` / `+` 与 `!'()*` 二次编码不一致。
- 图片上传：手写 multipart 并显式设置 `Content-Length`；Node `FormData` 的 chunked 编码会被 B站 CSRF 解析拒绝。
- 评论带图：`pictures` 字段是 JSON 字符串；图片走同一个 BFS 上传接口。

## 分页

- 动态流使用 `offset` 游标；`page` 通过缓存游标实现便捷翻页。
- 其他列表使用 `page` / `ps` / `limit`；服务端对页码做整数截断，schema 限制为整数倍。
- 标签补齐默认前 20 条，失败时 `tags_complete=false`。

## 评论状态

B站可能把评论置为 `state=17`（审核中/仅自己可见）。工具会返回：

- `state`
- `visible`（`state === 0`）
- `visibility_unknown`（查询暂时失败）

工具无法绕过审核。不要仅凭“接口 code=0”判断评论已公开。

## 登录态刷新

`src/server.mjs` 在每次 `tools/call` 前检查 `cookies.json` 的 mtime；文件变化时重建 `BiliClient`。
`BILI_COOKIE` 环境变量在进程生命周期内固定，不会热更新。

## 关键帧

- 优先 DASH 流 + ffmpeg，按 `times` 截帧。
- 单次调用有 120s 整体预算，单帧最多 30s。
- DASH 失败回退 `videoshot` 雪碧图。
- 未安装 ffmpeg 时返回整张雪碧图（`sprite_only=true`），不裁切单帧。
- 媒体缓存位于 `BILI_CACHE_DIR` 或系统缓存目录。

## 明确不实现

- 每日签到、银瓜子兑换；
- 弹幕发送、直播、付费/DRM 内容；
- 多账号池、批量自动化、绕过审核/风控。

## 测试

- `npm test`：离线单元 + MCP 协议测试；不访问 B站。
- `npm run test:live`：真实只读/可逆写测试；需要 Cookie，默认跳过写测试。
- `npm run verify`：只读端到端检查；`BILI_TEST_BVID` 可选。

真实写测试前先 dry-run；投币不可撤销。
