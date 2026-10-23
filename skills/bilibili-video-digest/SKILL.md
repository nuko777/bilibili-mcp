---
name: bilibili-video-digest
description: 用 bilibili MCP 工具读取 B 站榜单/视频字幕/关键帧/评论，完成视频内容理解与榜单摘要；写操作先预览再确认。
whenToUse: 当用户要求“看/总结某个 B 站视频”“整理热榜/每周必看”“读字幕或截画面”“点赞/投币/收藏/评论/关注/私信”时。
---

# B站内容理解与互动工作流

工具命名空间：`mcp__bilibili__*`。登录态由 `bilibili-login` skill 负责，本 skill 不处理 Cookie。

## 1. 看懂一个视频

用户给出 BV 号、av 号或链接时：

1. `mcp__bilibili__video_info`：拿标题、UP 主、时长、cid、分P、标签、可用字幕语言。
2. `mcp__bilibili__video_transcript`：
   - 有字幕：直接用 `text` 和 `segments` 总结，引用时间点；
   - 无字幕：不要编造内容，改用下一步。
3. 无字幕或需要画面证据：`mcp__bilibili__video_frames`
   - 默认 3 帧（15%/50%/85%）；
   - 可传 `times: ["0:30","1:20","50%"]`；
   - 工具会返回图片；直接看图片描述画面、字幕、场景。
4. 需要观众反馈：`mcp__bilibili__comments`（视频传 `video`，动态传 `dynamic_id`；先看热门，必要时按时间；传 `root` 可读完整楼中楼）。
5. 需要关联内容：`mcp__bilibili__related_videos`。

回答要求：

- 先给 2–4 句概要，再给带时间点的要点；
- 明确区分“字幕原文”与“从画面推断”；
- 引用视频链接；
- 用户只看某个分P时传 `page`。

## 2. 榜单 / 热门 / 每周必看

- 排行榜：`mcp__bilibili__rank_list`，可传 `rid` 分区、`type`；
- 综合热门：`mcp__bilibili__popular_list`；
- 每周必看：先 `weekly_issues` 找期数，再 `weekly_list`（不传 number 默认最新）；
- 标签由工具逐条补齐，默认只补前 20 条；需要更省请求时设 `include_tags=false`，或降低 `tag_limit`。

做“今日/本周摘要”时：

1. 拉列表（limit 10–20）；
2. 选 3–5 个与用户兴趣相关的；
3. 对每个调用 `video_transcript` 或 `video_frames`；
4. 输出“标题 + UP 主 + 链接 + 一句话看点 + 标签”。

## 3. 互动（写操作）

所有写工具默认 dry-run：

- 先调用一次不带 `confirm` 的工具，把返回的 `action`、`target`、`details` 给用户看；
- 用户明确同意后，再带 `confirm: true` 调用；
- `coin_video` **不可撤销**，执行前必须确认数量和余额；
- `post_comment`、`post_dynamic`、`send_message` 是公开/对外行为，先复述文案；
- 需要显式 @ 时给 `post_comment` 传 `mention_user_ids`；回复评论继续用 `root`/`parent`，工具会自动生成 `回复 @父作者 : 正文`。
- `like_video`、`favorite_video`、`follow_user` 可逆，但也要用户确认目标；
- 收藏需要 `folder_id`：先调 `list_favorites` 不带 folder_id，拿到收藏夹列表。

不要：

- 不要在用户没要求时主动点赞/投币/关注/发私信；
- 不要批量操作或自动关注；
- 不要实现或调用每日签到、银瓜子兑换（已明确不做）。

## 4. 账号信息

- 登录态/硬币/未读：`mcp__bilibili__auth_status`；
- 关注列表：`mcp__bilibili__list_followings`；
- 收藏：`mcp__bilibili__list_favorites`；
- 回复/@/赞：`mcp__bilibili__notifications`；
- 私信：`mcp__bilibili__messages`（不传 talker_id 列会话，传了读聊天记录）；
- 动态：`mcp__bilibili__dynamic_feed`。

如果 `auth_status` 返回 `is_login: false`，转到 `bilibili-login` skill，不要尝试在 MCP 内提取登录态。

## 5. 失败处理

- `-101`：登录态失效 → `bilibili-login`；
- `-352`：风控 → 降低频率，等待几分钟；
- 无字幕 → `video_frames`；
- 抽帧失败 → 检查 ffmpeg，或依赖 `videoshot` 回退；
- 写操作返回 `dry_run` → 正常，需 `confirm=true`。
