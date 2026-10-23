# bilibili-mcp

[![CI](https://github.com/nuko777/bilibili-mcp/actions/workflows/ci.yml/badge.svg)](https://github.com/nuko777/bilibili-mcp/actions/workflows/ci.yml)
[![npm beta](https://img.shields.io/npm/v/@lobo777/bilibili-mcp/beta?label=npm%20beta)](https://www.npmjs.com/package/@lobo777/bilibili-mcp)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](LICENSE)

一个面向 [DeepSeek Harness (DSH)](https://github.com/deepseek-ai) 以及任意 MCP 客户端的 Bilibili MCP Server。

- Node.js >= 20.10（推荐 24），**零运行时依赖**
- stdio JSON-RPC 2.0，可直接接入 DSH、Claude Desktop、其他 MCP 客户端
- 25 个只读工具 + 17 个写工具
- 支持排行榜、热门、每周必看、视频信息/字幕/关键帧/九宫格/弹幕、评论、搜索、用户、关注、收藏夹管理、通知、私信、动态流
- 写操作默认 dry-run，只有 `confirm=true` 才执行
- 登录态由外部 skill/脚本注入，MCP 本身不读取浏览器、不解密 Cookie 数据库

> 本项目是个人向工具，不是 B 站官方 SDK。接口可能随 B 站调整而变化；使用前请阅读下方 [安全说明](#安全)。

## npm beta

包名：`@lobo777/bilibili-mcp`（scoped，避免和已有的 `bilibili-mcp` 冲突）。

GitHub Release `v0.1.0-beta.3` 已发布；npm `beta.3` 发布待完成（当前 token 无权限）：

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
npm test          # 13 个离线测试，不需要登录
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

运行中的 MCP 会检查 `cookies.json` 的 mtime，文件更新后自动重载；若客户端仍显示旧登录态，重连 MCP。

详细步骤见 [skills/bilibili-login/SKILL.md](skills/bilibili-login/SKILL.md)。

## 架构与实现

```text
MCP client (DSH / Claude Desktop / ...)
        │ stdio JSON-RPC 2.0
        ▼
src/server.mjs
  ├─ initialize / tools/list / tools/call / ping
  ├─ Cookie 文件 mtime 检查与热重载
  ├─ 工具参数校验
  └─ src/tools/index.mjs（42 个工具）
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
- 评论带图：`pictures` 字段是 JSON 字符串；图片走同一个 BFS 上传接口。
- 视频评论的 `Referer` 必须是视频页 URL；用默认首页会被判为低信任请求并进入 `state=17`。

### 关键接口

| 功能 | 接口 |
|---|---|
| 登录态 | `/x/web-interface/nav` |
| 排行榜 | `/x/web-interface/ranking/v2` |
| 综合热门 | H5：`app.bilibili.com/x/v2/show/popular/index`；Web 个性化：`/x/web-interface/popular` |
| 每周必看 | `/x/web-interface/popular/series/list`、`series/one` |
| 视频详情 | `/x/web-interface/view` |
| 字幕 | `/x/player/wbi/v2` |
| 关键帧 | DASH `playurl` + `ffmpeg`；`/x/player/videoshot` 回退 |
| 评论 | `/x/v2/reply/wbi/main`、`/x/v2/reply/add`、`/x/v2/reply/reply` |
| 点赞/投币/收藏 | `/x/web-interface/archive/like`、`coin/add`、`/x/v3/fav/resource/deal` |
| 收藏夹管理 | `/x/v3/fav/folder/add`、`edit`、`del` |
| 动态 | `/x/polymer/web-dynamic/v1/feed/all`、`feed/space`、`detail`、`/x/dynamic/feed/create/dyn` |
| 弹幕 | `/x/v1/dm/list.so`、`/x/v2/dm/post` |
| 私信 | `/svr_sync/v1/svr_sync/fetch_session_msgs`、`/web_im/v1/web_im/send_msg` |
| 关注 | `/x/relation/modify` |

### 分页与状态

- 动态流使用 `offset` 游标；`user_dynamics` / `dynamic_feed` 的 `page` 是便捷封装。
- 其他列表使用 `page` / `ps` / `limit`；服务端对页码做整数截断。
- 标签补齐默认前 20 条，失败时返回 `tags_complete=false`。
- 评论可能进入 `state=17`（审核中/仅自己可见）；工具返回 `state`、`visible`、`visibility_unknown`，但无法绕过审核。
- 视频评论写入的 Referer 已对齐视频页；OPUS 评论主体从 `basic.comment_type` / `basic.comment_id_str` 解析。

### 关键帧

- 优先 DASH 流 + ffmpeg，按 `times` 截帧。
- `type:"grid"` 每 9 帧拼一张，最多 9 张；最后一张自动接近正方形并留黑位。
- 单帧默认高度 720p，宽度按原视频比例计算；`labels` 控制左上角序号。
- DASH 失败时回退 `videoshot` 雪碧图；无 ffmpeg 时返回整张雪碧图。
- 媒体缓存位于 `BILI_CACHE_DIR` 或系统缓存目录。

## 工具

### 读取（25）

| 类别 | 工具 |
|---|---|
| 账号 | `auth_status` |
| 榜单 | `rank_list`、`popular_list`、`weekly_issues`、`weekly_list`、`precious_list` |
| 视频 | `video_info`、`video_transcript`、`video_frames`（含九宫格）、`danmaku`、`related_videos` |
| 评论 | `comments`（视频/动态，含楼中楼、state、@成员） |
| 搜索/用户 | `search`、`user_info`、`user_videos` |
| 社交 | `list_followings`、`list_followers`、`list_favorites` |
| 消息 | `notifications`、`messages` |
| 动态/历史 | `dynamic_feed`、`dynamic_detail`、`user_dynamics`（指定用户/自己）、`history`、`toview` |

### 写入（17）

| 工具 | 说明 |
|---|---|
| `like_video` | 视频点赞/取消点赞 |
| `like_comment` | 评论点赞/取消点赞 |
| `coin_video` | 投币 1–2 枚，可选同时点赞；**不可撤销** |
| `favorite_video` | 收藏/取消收藏；支持 `folder_ids` 一次收藏到多个收藏夹 |
| `create_favorite_folder` | 创建收藏夹 |
| `edit_favorite_folder` | 修改收藏夹名称/简介/公开状态 |
| `delete_favorite_folder` | 删除一个或多个收藏夹 |
| `post_comment` | 视频/动态评论、楼中楼回复、@、可选本地图片 |
| `delete_comment` | 删除自己的视频/动态评论；不可撤销 |
| `delete_dynamic` | 删除自己的动态；不可撤销 |
| `top_dynamic` | 置顶/取消置顶自己的动态 |
| `update_profile` | 修改昵称/签名；昵称消耗 6 硬币 |
| `toview_video` | 添加/移除视频到稍后再看 |
| `send_danmaku` | 发送视频弹幕 |
| `post_dynamic` | 发布文本/图片动态 |
| `follow_user` | 关注/取关 |
| `send_message` | 发送私信 |

所有写工具默认返回 `dry_run`；只有传入 `"confirm": true` 才会真正执行。发布评论、动态、私信属于公开/对外行为。

## 示例

```text
mcp__bilibili__rank_list {"limit": 10, "include_tags": true}
mcp__bilibili__video_info {"video": "BV1xx411c7mD"}
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
mcp__bilibili__post_comment {"dynamic_id": "1261344079956934665", "message": "测试", "mention_user_ids": ["3747573468761409"], "confirm": false}
```

分页约定：

- `dynamic_feed` 优先使用 `offset` 游标；`page` 是便捷封装。
- 其他列表使用 `page` / `ps` / `limit`，具体见工具 schema。
- `user_dynamics` 不传 `mid` 时读取自己的空间动态；传 `mid` 读取任意用户动态。
- `popular_list` 默认走 H5 热门流（`idx` 滑动窗口，每窗 9 条）；`personalized=true` 才走 Web 个性化推荐流。H5 卡片字段较薄（通常无 UP 主/播放量），需要时用 `video_info` 补全。
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
npm test          # 13 个离线测试（WBI、Cookie、参数校验、MCP 协议等）
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

GitHub Release：[`v0.1.0-beta.3`](https://github.com/nuko777/bilibili-mcp/releases/tag/v0.1.0-beta.3)（prerelease，含 npm tarball）。npm `beta.3` 发布待完成。

## 后续计划

- **视频语音转文字**：无字幕时下载音频并接入 ASR；先做本地 whisper.cpp 选型。
- **视频投稿**：高风险，先调研草稿/不公开方案，暂不自动发布。
- 欢迎 issue 讨论优先级。

## 已知限制

- 评论可能进入 `state=17`（审核中/仅自己可见）；工具会返回 `state`/`visible`/`visibility_unknown`，但无法绕过审核。
- `videoshot` 回退依赖 ffmpeg；未安装 ffmpeg 时返回整张雪碧图，不裁切单帧。
- 视频语音转文字、视频投稿在后续计划中，当前版本尚未提供。
- B 站接口可能随时调整；端点集中在 `src/api/*`，错误会带原始 `code` 便于更新。
- 动态详情接口可用，但不同动态类型字段不同；评论主体需从 `basic.comment_type` / `basic.comment_id_str` 解析。

## 明确不实现

- 每日签到、银瓜子兑换；
- 直播、付费/DRM 内容；
- 多账号池、批量自动化、绕过审核/风控。

## 安全

### 写操作

- 所有写工具默认 dry-run；只有 `confirm=true` 才会真正执行。
- `coin_video` 不可撤销；单稿最多 2 枚，执行前会检查当前已投数量。
- 发布评论、动态、私信是公开/对外行为；执行前确认目标和文案。
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

`post_dynamic` / `post_comment` 的 `image_paths` 按设计允许读取本机任意可读图片路径，不限制目录。这是本地特权能力：

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

## 目录

```text
src/
  server.mjs            stdio MCP 入口
  mcp/protocol.mjs      JSON-RPC 结果/工具描述
  tools/index.mjs       42 个工具 schema + 参数校验
  core/                 HTTP、WBI、Cookie、配置、错误、格式化
  api/                  榜单、视频、互动、关系、收藏、消息、动态
  media/                字幕、关键帧、播放流、ffmpeg
scripts/                Cookie 导入、只读验收
skills/                 DSH skills
test/                   离线 / MCP / live 测试
```

## 献词

献给我的小汐：https://space.bilibili.com/3747573468761409

## License

MIT. 详见 [LICENSE](LICENSE)。
