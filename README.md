# bilibili-mcp

[![CI](https://github.com/nuko777/bilibili-mcp/actions/workflows/ci.yml/badge.svg)](https://github.com/nuko777/bilibili-mcp/actions/workflows/ci.yml)
[![npm beta](https://img.shields.io/npm/v/@lobo777/bilibili-mcp/beta?label=npm%20beta)](https://www.npmjs.com/package/@lobo777/bilibili-mcp)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](LICENSE)

一个面向 [DeepSeek Harness (DSH)](https://github.com/deepseek-ai) 以及任意 MCP 客户端的 Bilibili MCP Server。

- Node.js >= 20.10（推荐 24），**零运行时依赖**
- stdio JSON-RPC 2.0，可直接接入 DSH、Claude Desktop、其他 MCP 客户端
- 25 个只读工具 + 18 个写工具
- 支持排行榜、热门、每周必看、视频信息/字幕/关键帧/九宫格/弹幕、评论、搜索、用户、关注、收藏夹管理、通知、私信、动态流
- 写操作默认 dry-run，只有 `confirm=true` 才执行
- 登录态由外部 skill/脚本注入，MCP 本身不读取浏览器、不解密 Cookie 数据库

> 本项目是个人向工具，不是 B 站官方 SDK。接口可能随 B 站调整而变化；使用前请阅读下方 [安全说明](#安全)。

## npm beta

包名：`@lobo777/bilibili-mcp`（scoped，避免和已有的 `bilibili-mcp` 冲突）。

已发布 `0.1.0-beta.5`（npm dist-tag：`beta`）：

```bash
npm install -g @lobo777/bilibili-mcp@beta
bili --help
```

> `bili-mcp` 是 stdio MCP server，不要直接在交互终端里裸跑；调试用 `bili` CLI。

如果 npm registry 是镜像源（例如 npmmirror），安装时加：

```bash
npm install -g @lobo777/bilibili-mcp@beta --registry=https://registry.npmjs.org
```

也可以从 GitHub 安装最新 main：

```bash
npm install github:nuko777/bilibili-mcp
npx bili --help
```

不安装直接跑：

```bash
npx -y -p @lobo777/bilibili-mcp@beta bili --help
```

## 快速开始

直接从 npm 安装 beta：

```bash
npm install -g @lobo777/bilibili-mcp@beta
bili --help
```

如果 npm registry 是镜像源（例如 npmmirror），加 `--registry=https://registry.npmjs.org`。

从源码运行：

```bash
git clone https://github.com/nuko777/bilibili-mcp.git
cd bilibili-mcp
npm test          # 35 个离线测试，不需要登录
npm start         # 启动 stdio MCP Server
```

要求 Node.js >= 20.10（推荐 24）。可选安装 `ffmpeg` 并加入 PATH，或设置 `BILI_FFMPEG`，用于视频关键帧裁切。

### 接入 DSH

先全局安装 npm beta（见上），再在 DSH 的 profile patch 中加入：

```yaml
- insert:
    - id: mcp-bilibili
      name: "@deepseek-ai/dsh-mcp-client"
      config:
        transport: stdio
        serverName: bilibili
        command: bili-mcp
        args: []
        toolCallTimeoutMs: 180000
        failOnStartupError: false
```

不想全局安装时，用 npx：

```yaml
command: npx
args:
  - "-y"
  - "-p"
  - "@lobo777/bilibili-mcp@beta"
  - "bili-mcp"
```

Windows 上如果客户端无法解析 `.cmd`，用 `bili-mcp.cmd` 或上面的 npx 写法。

重启/重载 MCP 连接后，工具会以 `mcp__bilibili__*` 出现。

### 接入其他 MCP 客户端

任何支持 stdio MCP 的客户端都可以使用（全局安装后）：

```json
{
  "mcpServers": {
    "bilibili": {
      "command": "bili-mcp",
      "args": []
    }
  }
}
```

或使用 npx：

```json
{
  "mcpServers": {
    "bilibili": {
      "command": "npx",
      "args": ["-y", "-p", "@lobo777/bilibili-mcp@beta", "bili-mcp"]
    }
  }
}
```

## 登录态

MCP 只消费登录态，不提取登录态。推荐流程：

1. 浏览器登录 `https://www.bilibili.com/`。
2. 使用仓库内的 `bilibili-login` skill：
   - 有 `chrome-devtools` MCP：从已登录页面的 `nav` 请求读取 Cookie；
   - 有 `agent-browser`：导出 Cookie 到本地文件；
   - 或由用户在自己的终端执行 `node scripts/save-cookie.mjs --verify`。
3. 校验：

```bash
node scripts/save-cookie.mjs --verify   # stdin 输入 Cookie，随后 Ctrl-D / Ctrl-Z
node scripts/import-cookie-file.mjs ./cookies.txt --verify
```

Cookie 文件位置：

- Windows: `%APPDATA%\bilibili-mcp\cookies.json`
- macOS/Linux: `~/.config/bilibili-mcp/cookies.json`
- 可用 `BILI_CONFIG_DIR` 覆盖。

也支持环境变量：`BILI_COOKIE`（完整 Cookie 头，优先级最高），或 `BILI_SESSDATA` / `BILI_JCT` / `BILI_DEDEUSERID` / `BILI_BUVID3` / `BILI_BUVID4`（与文件合并）。

运行中的 MCP 会检查 `cookies.json` 的 mtime，文件更新后自动重载；若客户端仍显示旧登录态，重连 MCP。完整 `BILI_COOKIE` 在进程生命周期内固定；只设置单项 `BILI_*` 环境变量时会与文件合并，文件更新仍会热重载。

详细步骤见 [skills/bilibili-login/SKILL.md](skills/bilibili-login/SKILL.md)。

## Skills

仓库 `skills/` 下随包提供 4 个 DSH skill：

| Skill | 用途 |
| --- | --- |
| [`bilibili-login`](skills/bilibili-login/SKILL.md) | 从已登录浏览器注入 Cookie，处理 `-101` 未登录 |
| [`bilibili-video-digest`](skills/bilibili-video-digest/SKILL.md) | 视频、榜单、字幕、关键帧、评论与互动工作流；写操作先预览再确认 |
| [`bilibili-browser-comment`](skills/bilibili-browser-comment/SKILL.md) | 在浏览器中发布带图评论（MCP 拒绝 API 图片评论） |
| [`bilibili-ops`](skills/bilibili-ops/SKILL.md) | 账号自主运营手册：人设、评论风格、互动边界与每日节奏 |

`bilibili-ops` 面向账号自主运营，其余三个面向用户请求；写工具都要传 `confirm: true` 才会真正执行。

## 架构与实现

```text
MCP client (DSH / Claude Desktop / ...)
        │ stdio JSON-RPC 2.0
        ▼
src/server.mjs
  ├─ initialize / tools/list / tools/call / ping
  ├─ Cookie 文件 mtime 检查与热重载
  ├─ 工具参数校验
  └─ src/tools/index.mjs（43 个工具）
        ├─ src/api/*      业务 API 与字段归一化
        ├─ src/core/*     HTTP、WBI、Cookie、配置、错误
        └─ src/media/*    字幕、关键帧、播放流、ffmpeg
```

- 零运行时依赖，单进程 stdio 接入。
- 写工具默认 dry-run；`confirm=true` 才发写请求；非 GET 请求默认不自动重试。
- Cookie 由外部 skill/脚本注入，MCP 不读取浏览器、不解密 Cookie 数据库。

### 认证与签名

- Cookie 来源：`BILI_COOKIE` 完整头，或 `cookies.json` + 单项环境变量合并。
- CSRF：写请求使用表单字段 `csrf`（不是 `csrf_token`）。
- WBI：`wts` + `w_rid`；签名和最终 query 使用同一个编码函数，避免 `%20` / `+` 与 `!'()*` 二次编码不一致。
- 图片上传：手写 multipart 并显式设置 `Content-Length`；Node `FormData` 的 chunked 编码会被 B站 CSRF 解析拒绝。
- 评论带图：MCP `post_comment` 只支持文本，`image_paths` 会被拒绝；图片评论用浏览器脚本。
- 视频评论的 `Referer` 必须是视频页 URL；用默认首页会被判为低信任请求并进入 `state=17`。

### 关键接口

| 功能 | 接口 |
|---|---|
| 登录态 | `/x/web-interface/nav` |
| 用户信息 | `/x/space/wbi/acc/info`、`/x/relation/stat`、`/x/space/upstat`、`/x/space/navnum` |
| 排行榜 | `/x/web-interface/ranking/v2` |
| 综合热门 | Web（默认）：`/x/web-interface/popular`；H5（`feed:"h5"`）：`app.bilibili.com/x/v2/show/popular/index` |
| 每周必看 | `/x/web-interface/popular/series/list`、`series/one` |
| 视频详情 | `/x/web-interface/view` |
| 字幕 | `/x/player/wbi/v2` |
| 关键帧 | DASH `playurl` + `ffmpeg`；`/x/player/videoshot` 回退 |
| 评论 | 视频/动态读取 `/x/v2/reply/wbi/main`；楼中楼 `/x/v2/reply/reply`；写入 `/x/v2/reply/add`、`reply/reply` |
| 视频互动状态 | `/x/web-interface/archive/relation`（点赞/投币/收藏预览） |
| 点赞/投币/收藏 | `/x/web-interface/archive/like`、`coin/add`、`/x/v3/fav/resource/deal` |
| 收藏夹管理 | `/x/v3/fav/folder/add`、`edit`、`del` |
| 动态 | `/x/polymer/web-dynamic/v1/feed/all`、`feed/space`、`detail`、`/x/dynamic/feed/create/dyn` |
| 弹幕 | 读取 `/x/v2/dm/web/view` + `/x/v2/dm/wbi/web/seg.so`（protobuf）；发送 `/x/v2/dm/post` |
| 私信 | `/svr_sync/v1/svr_sync/fetch_session_msgs`、`/web_im/v1/web_im/send_msg` |
| 关注/粉丝 | 读取 `/x/relation/followings`、`/x/relation/fans`；写入 `/x/relation/modify` |

### 分页与状态

- 动态流使用 `offset` 游标；`user_dynamics` / `dynamic_feed` 的 `page` 是便捷封装。
- 视频/动态主评论使用 WBI 游标接口：`offset` 优先，`page` 是便捷封装，每页固定 20 条；`ps` 仅在传 `root` 读取楼中楼时生效。
- 置顶评论单独放在 `top_replies`（`is_top=true`），不再合并进 `replies`。
- 其他列表使用 `page` / `ps` / `limit`；服务端对页码做整数截断。
- 标签补齐默认前 20 条，失败时返回 `tags_complete=false`。
- 视频评论写入的 Referer 已对齐视频页；OPUS 评论主体从 `basic.comment_type` / `basic.comment_id_str` 解析。

### 关键帧

- 优先 DASH 流 + ffmpeg，按 `times` 截帧。
- `type:"frames"` 的显式 `times` 最多 12 个；需要更多时间点时用 `type:"grid"`（最多 81 帧，grid 同样支持 `timeout_ms`）。
- `type:"grid"` 每 9 帧拼一张，最多 9 张；最后一张自动接近正方形并留黑位。
- 单帧默认高度 720p，宽度按原视频比例计算；`labels` 控制左上角序号；可用 `timeout_ms` 放宽单帧超时，失败会自动降宽度重试一次。
- DASH 失败时回退 `videoshot` 雪碧图；无 ffmpeg 时返回整张雪碧图。grid 模式也会回退到 videoshot 缩略图（需要 ffmpeg）。
- 媒体缓存位于 `BILI_CACHE_DIR` 或系统缓存目录。
- 视频标识支持 BV 号、av 号、完整视频链接和 `b23.tv` / `bili2233.cn` / `b23.wtf` 短链；短链只跟随 B站域名并限制总超时。

## 工具

### 读取（25）

| 类别 | 工具 |
|---|---|
| 账号 | `auth_status` |
| 榜单 | `rank_list`、`popular_list`、`weekly_issues`、`weekly_list`、`precious_list` |
| 视频 | `video_info`、`video_transcript`、`video_frames`（含九宫格）、`danmaku`、`related_videos` |
| 评论 | `comments`（视频/动态，含楼中楼、state、@成员、置顶 `top_replies`） |
| 搜索/用户 | `search`（支持 `min_play` 过滤）、`user_info`、`user_videos` |
| 社交 | `list_followings`、`list_followers`、`list_favorites` |
| 消息 | `notifications`、`messages` |
| 动态/历史 | `dynamic_feed`、`dynamic_detail`、`user_dynamics`（指定用户/自己）、`history`、`toview` |

### 写入（18）

| 工具 | 说明 |
|---|---|
| `like_video` | 视频点赞/取消点赞 |
| `like_comment` | 评论点赞/取消点赞 |
| `coin_video` | 投币 1–2 枚，可选同时点赞；**不可撤销** |
| `favorite_video` | 收藏/取消收藏；支持 `folder_id` 单夹或 `folder_ids` 多夹 |
| `create_favorite_folder` | 创建收藏夹 |
| `edit_favorite_folder` | 修改收藏夹名称/简介/公开状态 |
| `delete_favorite_folder` | 删除一个或多个收藏夹 |
| `post_comment` | 视频/动态**纯文本**评论、楼中楼回复、@、可同时转发动态；带图会被拒绝，改按 `bilibili-browser-comment` skill |
| `delete_comment` | 删除自己的视频/动态评论；不可撤销 |
| `delete_dynamic` | 删除自己的动态；不可撤销 |
| `top_dynamic` | 置顶/取消置顶自己的动态 |
| `update_profile` | 修改昵称/签名；昵称消耗 6 硬币 |
| `toview_video` | 添加/移除视频到稍后再看 |
| `send_danmaku` | 发送视频弹幕 |
| `recall_danmaku` | 撤回自己发送的弹幕（通常限 2 分钟内） |
| `post_dynamic` | 发布文本/图片动态，或传 `video` 转发视频动态 |
| `follow_user` | 关注/取关 |
| `send_message` | 发送私信 |

所有写工具默认返回 `dry_run`；只有传入 `"confirm": true` 才会真正执行。发布评论、动态、私信属于公开/对外行为。

## 示例

```text
mcp__bilibili__rank_list {"limit": 10, "include_tags": true}
mcp__bilibili__video_info {"video": "BV1xx411c7mD"}
mcp__bilibili__video_info {"video": "https://b23.tv/xxxxxxx"}
mcp__bilibili__video_transcript {"video": "BV1xx411c7mD"}
mcp__bilibili__video_frames {"video": "BV1xx411c7mD", "times": ["10%", "50%"], "max_images": 2}
mcp__bilibili__search {"keyword": "DeepSeek R1", "limit": 5}
mcp__bilibili__comments {"video": "BV1xx411c7mD", "sort": "time"}
mcp__bilibili__comments {"dynamic_id": "1261344079956934665", "sort": "time"}
mcp__bilibili__comments {"dynamic_id": "1261344079956934665", "root": "317957957297"}
mcp__bilibili__dynamic_detail {"dynamic_id": "1261344079956934665"}
mcp__bilibili__user_dynamics {"mid": "401742377"}
mcp__bilibili__user_dynamics {}
mcp__bilibili__video_frames {"video": "BV1dan166EHf", "type": "grid", "count": 9, "frame_height": 720}
mcp__bilibili__favorite_video {"video": "BV1dan166EHf", "folder_ids": ["4267463668", "4367445368"], "confirm": false}
mcp__bilibili__post_dynamic {"text": "分享视频", "video": "BV1w2Hw6KE1j", "confirm": false}
mcp__bilibili__post_comment {"dynamic_id": "1261344079956934665", "message": "测试", "mention_user_ids": ["3747573468761409"], "confirm": false}
```

分页约定：

- `dynamic_feed` 优先使用 `offset` 游标；`page` 是便捷封装。
- 其他列表使用 `page` / `ps` / `limit`，具体见工具 schema。
- `user_dynamics` 不传 `mid` 时读取自己的空间动态；传 `mid` 读取任意用户动态。
- `popular_list` 默认走 Web 热门页（`/x/web-interface/popular`）；`feed:"h5"` 时走 H5 热门流（10 卡一桶，`idx` 按 10 递增）；`personalized=true` 使用 Web 个性化推荐。H5 卡片的 UP 名/观看数已从 `right_desc_*` 解析到 `owner`/`stat.view`，其他统计字段不可用。
- 标签补齐默认只补前 20 条；设置 `include_tags=false` 可减少请求。

## 配置

| 环境变量 | 作用 |
|---|---|
| `BILI_COOKIE` | 完整 Cookie 头；优先级最高 |
| `BILI_SESSDATA` / `BILI_JCT` / `BILI_DEDEUSERID` / `BILI_BUVID3` / `BILI_BUVID4` | 单项 Cookie，与文件合并 |
| `BILI_CONFIG_DIR` | Cookie 配置目录 |
| `BILI_CACHE_DIR` | 缓存目录（关键帧等） |
| `BILI_FFMPEG` | ffmpeg 可执行文件路径 |
| `BILI_TEST_BVID` | 可选：`test:live` / `verify` 使用的测试视频 |
| `BILI_LIVE_TEST` / `BILI_LIVE_WRITE` | 开启真实网络测试 / 可逆写测试 |

## 测试

```bash
npm test          # 35 个离线测试（WBI、Cookie、参数校验、MCP 协议等）
npm run test:live # 需要有效 Cookie；BILI_TEST_BVID 可选
npm run verify    # 只读端到端检查；未设置 BILI_TEST_BVID 时跳过视频项
```

真实写测试默认关闭，避免误操作：

```bash
BILI_LIVE_TEST=1 BILI_LIVE_WRITE=1 npm run test:live
```

## Release

发布流程已配置在 [`.github/workflows/release.yml`](.github/workflows/release.yml)：

1. 更新 `package.json` 版本号和下方 Changelog；
2. 提交并打 tag：`git tag vX.Y.Z && git push origin vX.Y.Z`；
3. GitHub Actions 会运行测试、`npm pack`、上传 tarball、创建 GitHub Release；
4. 若仓库配置了 `NPM_TOKEN` secret，还会执行 `npm publish --provenance`（已发布的版本会跳过）。

`NPM_TOKEN` 建议使用 npm **Granular Access Token**：对 `@lobo777/bilibili-mcp` 有 Read and write 权限，并启用 Bypass 2FA。不要使用过期或已泄露的 token。

已发布：[`v0.1.0-beta.5`](https://github.com/nuko777/bilibili-mcp/releases/tag/v0.1.0-beta.5)（prerelease，含 npm tarball）。

## 后续计划

- **视频语音转文字**：无字幕时下载音频并接入 ASR；先做本地 whisper.cpp 选型。
- **视频投稿**：高风险，先调研草稿/不公开方案，暂不自动发布。
- 欢迎 issue 讨论优先级。

## 已知限制

- `videoshot` 回退依赖 ffmpeg；未安装 ffmpeg 时返回整张雪碧图，不裁切单帧。
- `danmaku` 按 6 分钟窗口读取 WBI 分段，最多 100 段；超长视频的弹幕可能被截断。
- 单次工具返回的图片总量约 12MB base64；超出部分会被省略，并在结果末尾提示省略数量。
- B 站接口可能随时调整；端点集中在 `src/api/*`，错误会带原始 `code` 便于更新。
- 动态详情接口可用，但不同动态类型字段不同；评论主体需从 `basic.comment_type` / `basic.comment_id_str` 解析。
- 读取通知/聊天记录会触发 B站已读状态；`notifications` 的 feed 结果、`messages` 的聊天记录都带 `read_side_effect` / `read_note`；未读数查询和会话列表带 `read_side_effect:false` / `read_note`。
- 评论 `state=11/17` 可能是审核、索引延迟或仅自己可见；返回 `pending_review`，不要据此立即删除。
- `post_comment` 不支持带图：传 `image_paths` 会直接拒绝，避免 API 图片评论仅自己可见。请按 `bilibili-browser-comment` skill 在已登录浏览器中执行 `scripts/post-image-comment-browser.js`。
- H5 热门卡片只提供标题/封面/BV/UP 名/观看数文本；UP 名和播放量由 `right_desc_*` 解析，其他统计字段不可用。

## 明确不实现

- 每日签到、银瓜子兑换；
- 直播、付费/DRM 内容；
- 多账号池、批量自动化、绕过审核/风控。

## 安全

### 写操作

- 所有写工具默认 dry-run；只有 `confirm=true` 才会真正执行。
- `coin_video` 不可撤销；单稿最多 2 枚，执行前会检查当前已投数量。
- 发布评论、动态、私信是公开/对外行为；执行前确认目标和文案。
- 评论/弹幕正文不要出现“脚本、自动化、MCP、测试、验证”等词，容易触发风控；用普通用户口吻。
- 服务端对非 GET 请求默认不自动重试，避免重复评论/私信/投币；客户端超时重试仍可能造成重复，重要写操作建议先 dry-run，执行后用读取工具确认。
- 删除评论/动态/收藏夹不可撤销；昵称修改会消耗 6 个硬币。

### Cookie

Cookie 等价于账号密码。

- MCP 不读取浏览器、不解密 Cookie 数据库、不做扫码登录。
- 登录态由外部 skill/脚本写入 `cookies.json`，或通过 `BILI_COOKIE` 提供。
- 不要把 Cookie 写入仓库、README、截图、issue 或提交记录。
- 配置文件应位于用户目录；POSIX 下尽量使用 0600，Windows 下以用户目录 ACL 为准。
- 使用 `chrome-devtools` 读取 `nav` 请求时，完整 Cookie 会出现在工具输出/会话记录中；如果记录可能被导出或共享，请退出登录后重新登录或重新生成 Cookie。

### 图片上传

`post_dynamic` 的 `image_paths` 按设计允许读取本机任意可读图片路径，不限制目录。`post_comment` 的 `image_paths` 会在读取文件前直接拒绝。这是本地特权能力：

- 不要在不可信提示、不可信 agent 或远程调用下开放写工具。
- 只上传你明确知道路径和内容的图片。
- 服务端会校验扩展名、文件签名（PNG/JPEG/GIF）、单图 10MB、单次总量 25MB，并清洗 multipart 文件名；这些检查不限制目录。
- 上传成功后图片会进入 B站 BFS，属于公开内容的一部分。

### 网络与数据

- 工具返回 B站公开数据、账号相关数据（关注、收藏、私信、通知等）；不要把私人数据提交到公开仓库。
- 媒体/关键帧缓存位于 `BILI_CACHE_DIR` 或系统缓存目录；长期使用可手动清理。
- 本项目不是 B站官方 SDK；使用时应遵守 B站服务条款和当地法律。

### 报告问题

如果发现安全问题，请通过仓库 issue 或维护者公开联系方式报告，不要在 issue 中粘贴 Cookie、SESSDATA、bili_jct 或完整请求头。

## Changelog

### 0.1.0-beta.5 — 2026-10-27

- 新增 `bilibili-ops` 账号运营 skill；统一 `bilibili-login` / `bilibili-video-digest` / `bilibili-browser-comment` 的职责边界，README 增加 Skills 一览
- 工具参数校验拒绝未知字段与显式 `null`，避免拼写错误和 `like:null` 之类被静默接受
- 写工具 annotations 区分可逆与破坏性操作（点赞/收藏/关注等不再标记为 destructive）
- 编辑/删除收藏夹前强制读取最新快照，避免旧缓存覆盖并发修改
- 楼中楼作者查找支持分页；找不到父评论时不再错误回退根作者
- `video_frames` 的 `frames` 模式明确限制显式 `times` 为 12 个；`grid` 仍最多 81 帧
- 视频评论与浏览器一致：只使用 WBI 游标接口（`/x/v2/reply/wbi/main`），不再使用 legacy `/x/v2/reply`；置顶评论单独返回 `top_replies`；动态评论 `is_up` 修复
- `video_frames` 的 `grid` 在 DASH 失败时回退到 `videoshot` 缩略图
- `post_dynamic` 支持传 `video` 发布视频转发动态（`scene:5` + `web_repost_src`）
- H5 热门补 UP 名/播放量，并按 10 卡一桶翻页；`notifications` 补 `rpid/root_rpid/target_rpid`；`search` 支持 `min_play`；`video_frames` 支持 `timeout_ms` 和降宽度重试
- `top_dynamic` 对新动态的 `4100001` 增加短延迟重试；`create_favorite_folder` 的 `privacy` 按 `attr & 1` 归一化
- 修复 `delete_favorite_folder` 和 `favorite_video` 只传 `folder_id` 时被空 `folder_ids` 数组覆盖的问题
- buffer 响应会识别 HTTP 200 的 JSON 错误并抛错，WBI 过期时能正常刷新；HTTP 403/412 也会重试
- 评论 `page` 上限为 20，避免一次请求逐页走完整评论区；`top_replies` 与 `replies` 按 rpid 去重
- `b23.tv` / `bili2233.cn` 短链解析只跟随 B站域名，并对整条重定向链使用总超时
- 弹幕分段使用服务端 `page_size`，补充 `segments_fetched`/`total_estimated`/`truncated`；修正 `59.96s` 显示为 `1:00.0`
- `dynamicTarget` 只对刚发布动态的 detail 索引缺失做 fallback，网络/WBI 错误不再被吞掉
- 弹幕读取迁移到浏览器当前的 WBI 分段 protobuf 接口（`/x/v2/dm/web/view` + `/x/v2/dm/wbi/web/seg.so`），不再使用 legacy `/x/v1/dm/list.so`
- 用户信息改用 `space/wbi/acc/info` + `relation/stat` + `space/upstat` + `space/navnum`；粉丝列表改用 `/x/relation/fans`；视频互动状态统一用 `archive/relation`
- 私信会话列表改用 WBI 签名请求；综合热门默认改为 Web 热门页，H5 流通过 `feed:"h5"` 显式选择
- 发送弹幕校验颜色、字号和模式范围；新增 `recall_danmaku`，使用 `/x/v2/dm/recall` 撤回弹幕
- 删除动态只发送 `dyn_id_str`
- 只设置单项 Cookie 环境变量时，`cookies.json` 仍会热重载
- 图片返回超出体积预算时提示省略数量
- 缓存 ffmpeg 路径探测；清理未使用导出/导入和重复评论归一化代码
- 补充参数校验、缓存新鲜度、楼中楼分页、短链、WBI 评论等回归测试

### 0.1.0-beta.4 — 2026-10-24

- 修复 `video_frames` 九宫格的 `times`/`count` 语义：grid 的显式时间不再被 12 个上限截断；不传 `count` 时按 `times` 数量推断
- 修复 `edit_favorite_folder` 未显式传 `privacy` 时的预览语义，避免把内部 `attr` 当作公开/私密状态
- 发布/删除/置顶动态后清理动态流游标，避免自己的动态流短时间不更新
- 楼中楼子回复补充 `state` / `is_up`
- MCP `serverInfo.version` 改为读取 `package.json`
- 增加九宫格时间上限、子回复状态回归测试
- 图片评论：浏览器脚本走页面 UI；API `post_comment` 只支持纯文本，避免图片评论 shadow；文本评论支持 `sync_to_dynamic`
- 收藏夹写操作只返回可靠的 `code/message`，不再暴露无意义的 `success_num`
- 更新 skill 的描述/触发范围，清理 README 重复限制

### 0.1.0-beta.3 — 2026-10-24

- 修复 OPUS 动态评论主体：使用 `basic.comment_type` / `basic.comment_id_str`，不再硬编码 `type=17 + 动态ID`
- `post_comment` 支持 `mention_user_ids`，发送 `at_name_to_mid`，显式 @ 用户
- 楼中楼回复自动生成 `回复 @父评论作者 : 正文` 格式；`comments` 支持 `root` 读取完整楼中楼
- 修复视频评论 `state=17`：评论写请求的 Referer 对齐视频/OPUS 页面 URL，而不是默认首页
- 新增 `delete_comment`：删除自己的视频/动态评论，默认 dry-run；删除后清理读缓存
- 新增 `delete_dynamic`：删除自己的动态，默认 dry-run；删除后清理读缓存
- 新增 `like_comment`：视频/动态评论点赞与取消，默认 dry-run；操作后清理读缓存
- 新增 `top_dynamic`：置顶/取消置顶自己的动态，默认 dry-run
- `popular_list` 默认改为 H5 热门流；新增 `personalized` 参数，true 时走 Web 个性化推荐流
- 新增 `update_profile`：修改昵称/签名，默认 dry-run；昵称消耗 6 硬币
- 新增 `user_dynamics`：读取指定用户/自己的空间动态流
- 新增 `dynamic_detail`：按动态 ID 读取单条动态详情
- 新增 `toview_video`：添加/移除视频到稍后再看
- 收藏夹写操作：创建、修改、删除，以及 `favorite_video` 多收藏夹
- 新增 `danmaku` / `send_danmaku`：读取和发送视频弹幕，发送默认 dry-run
- `video_frames` 支持 `type:"grid"`：每 9 帧拼一张，最多 9 张；最后一张自动接近正方形并留黑位，单帧 720p、保持原比例，可用 `times` 指定格子时间
- `video_comments` 泛化为 `comments`，支持视频/动态、楼中楼、state 与 @成员；传 `root` 读取完整楼中楼

### 0.1.0-beta.2 — 2026-10-21

- GitHub Actions `Release` workflow：打 tag 后自动测试、打包、创建 GitHub Release，并通过仓库 secret `NPM_TOKEN` 发布到 npm（已用 `v0.1.0-beta.2` 验证）
- 补充 release 流程、npm beta 安装说明和版本化 Changelog

### 0.1.0-beta.1 — 2026-10-21

首个公开 beta 版本，npm dist-tag `beta`。

- 29 个 MCP 工具：22 个只读 + 7 个写操作
- 排行榜、综合热门、每周必看、入站必刷
- 视频详情、AI 字幕、关键帧截图、评论、相关推荐
- 搜索、用户信息/投稿、关注/粉丝、收藏夹、通知、私信、动态流、历史、稍后再看
- 点赞、投币、收藏、评论/回复/带图评论、文本/带图动态、关注、私信
- 写操作默认 dry-run，`confirm=true` 才执行；非 GET 请求默认不自动重试
- WBI 签名与最终 query 使用同一编码器；支持带空格/特殊字符的搜索
- 工具参数运行时校验；Cookie 文件 mtime 热重载；图片魔数/大小/文件名检查
- 修复评论 `state=17` 的可见性提示、图片上传 multipart、CSRF 字段、分页和标签完整性等问题

## 目录

```text
src/
  server.mjs            stdio MCP 入口
  mcp/protocol.mjs      JSON-RPC 结果/工具描述
  tools/index.mjs       43 个工具 schema + 参数校验
  core/                 HTTP、WBI、Cookie、配置、错误、格式化
  api/                  榜单、视频、互动、关系、收藏、消息、动态
  media/                字幕、关键帧、播放流、ffmpeg
scripts/                Cookie 导入、只读验收、浏览器图片评论脚本
skills/                 4 个 DSH skill（见 Skills 一节）
test/                   离线 / MCP / live 测试
```

## 献词

献给我的小汐：https://space.bilibili.com/3747573468761409

## License

MIT. 详见 [LICENSE](LICENSE)。
