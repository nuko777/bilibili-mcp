---
name: bilibili-video-digest
description: 用 bilibili MCP 工具读取 B 站榜单、视频、字幕、关键帧、弹幕、评论、动态和用户信息；按类型决定看字幕还是看画面，评价可带截图；写操作先预览再确认。
whenToUse: 当用户要求“看/评价某个 B 站视频”“找最触动的一帧/截图”“整理热榜/每周必看”“读字幕/截画面/九宫格/弹幕/热评”“查用户动态/评论”“点赞/投币/收藏/评论/发弹幕/关注/私信”“管理收藏夹/稍后再看/个人资料”时。
---

# B 站内容理解与互动工作流

工具命名空间：`mcp__bilibili__*`。登录态由 `bilibili-login` skill 负责，本 skill 不处理 Cookie。

本 skill 面向「用户明确提出请求」的场景，写操作默认先预览、征得同意再执行。账号自主运营（见 `bilibili-ops`）中已授权的自发互动，不适用「先问用户」，但仍要传 `confirm: true` 才会真正发出。

## 1. 看懂视频与动态

用户给出 BV 号、av 号、完整链接或 `b23.tv` 短链时，先 `mcp__bilibili__video_info` 拿标题、UP 主、时长、cid、分P、标签和 `subtitle_languages`；有字幕就先抽 `video_transcript`，再按内容类型和字幕质量定主证据。

**按类型定主证据：字幕优先，还是画面优先**

| 内容类型 | 第一优先级 | 做法 |
| --- | --- | --- |
| 知识讲解、口播、访谈、课程、测评、纪录片解说 | 字幕 | 字幕有效（语言对得上、能读通、不是空壳或错位 ASR）就以字幕为准，按 `segments` 的 `from`/`to` 引时间点；无效再转画面 |
| 二创、鬼畜、MAD/AMV、舞蹈、歌曲、MV、动画、手书、纯剪辑 | 画面帧 | 以 `video_frames` 为主；用 `type:"grid"` 一次看多帧，歌舞和剧情向要覆盖副歌、高潮段；刚抽的字幕只用来对歌词、台词 |
| 混合型（剧情+解说、科技评测带实拍） | 字幕 + 画面 | 字幕拿信息，帧拿产品细节和名场面，两边互相印证 |

字幕不是有就用：没字幕、只有外语、机器转写明显错乱、或台词只占很小一部分时，转 `video_frames`，别硬拿字幕编内容。反过来，字幕优先也别只看字幕：知识类抽 1–2 帧核对画面、找配图；画面优先的也别跳过字幕，歌词、台词、字幕卡经常是关键信息。

工具细节：

- `video_transcript`：传 `page` 看指定分P；返回 `text`、`segments`（`from`/`to`/`content`）、`available`、`char_count`；没有字幕时 `has_subtitle: false` 并带 `hint`。
- `video_frames`：默认 3 帧（15%/50%/85%）；`frames` 模式 `count` 最多 6，显式 `times` 最多 12 个；要一眼看全貌用 `type:"grid"`（最多 81 帧、9 张拼图、`labels` 标序号）；抽帧慢可传 `timeout_ms`，单帧失败会降宽度重试，DASH 失败回退 `videoshot` 缩略图（需要 ffmpeg）。返回图片数由 `max_images` 控制（默认 3）：要看 6 帧传 `max_images:6`，要看 9 张拼图传 `max_images:9`；grid 不传 `count` 默认 9 帧。`frames` 模式每帧带 `time`、`file`；grid 模式返回拼图（`from`/`to` 为单元格范围）和 `times` 列表。
- 主动补充观众视角：`danmaku` 按 `items[].time_text` 对齐时间点，刷屏处往往是名场面或高能点；`comments` 先看 `sort:"hot"` 热评，再补 `sort:"time"` 最新。两者都是观众反应，不能当事实，和字幕/画面冲突时以字幕/画面为准。
- 评论细节：置顶评论在 `top_replies`，传 `root` 读完整楼中楼；顺藤摸瓜用 `related_videos`。

**评价视频**

不要只凭标题、封面或简介（`desc`）评价：至少按上面的流程看过字幕或关键帧，再扫一遍热评。也别只复述“讲了什么”，挑 2–3 个真有差别的角度说，别逐项打分：

- 内容：信息密度、观点站不站得住、结构；
- 画面：构图、色彩、清晰度、名场面；
- 剪辑：节奏、转场、信息组织、卡点；
- 画风：动画/二创/手书的美术、分镜、风格统一度；
- 配音/配乐/音效：默认不评；台词和旁白的写法可从字幕看，声音本身只有弹幕、评论或 UP 主说明能佐证时才谈，并说明依据。

配图选“最触动你的那一帧”：情绪最强、信息量最大、或最能代表风格的那一刻。用 `video_frames` 传 `times:["12:34"]`、`type:"frames"`、`max_images:1` 单取一张（返回的帧带 `file` 路径），在回答里贴图，并写清时间点和这一帧为什么打动人。多帧时挑 1–2 张就够，不刷图。

评论区也是灵感来源：热评里的梗、反驳、补充信息和争议点，可以变成评价角度或互动切口；但观点自己过一遍，别把高赞当结论。

回答要求：

- 先给 2–4 句概要，再给带时间点的要点；
- 关键结论标注依据（字幕、画面、评论），推断处说明是推断，不必每句贴标签；
- 引用视频链接；有截图就配图；
- 用户只看某个分P时传 `page`。

**看动态**

动态没有字幕和关键帧：`dynamic_detail` 看正文、图片和视频卡片，`comments` 传 `dynamic_id` 看热评/最新，传 `root` 读楼中楼；不要套用视频流程。

## 2. 榜单 / 热门 / 每周必看

- 排行榜：`mcp__bilibili__rank_list`，可传 `rid` 分区、`type`；
- 综合热门：`mcp__bilibili__popular_list`；默认 Web 热门页，`feed:"h5"` 走 H5 热门流（10 卡一桶，`idx` 按 10 递增，已解析 `owner`/`stat.view`），`personalized=true` 走 Web 个性化推荐；
- 每周必看：先 `weekly_issues` 找期数，再 `weekly_list`（不传 number 默认最新）；
- 标签由工具逐条补齐，默认只补前 20 条；需要更省请求时设 `include_tags=false`，或降低 `tag_limit`。

做“今日/本周摘要”时：

1. 拉列表（limit 10–20）；
2. 选 3–5 个与用户兴趣相关的（兴趣清单见 `bilibili-ops` §1；未配置时按近期关注和互动判断）；
3. 按类型选证据：知识讲解先看字幕，二创/歌舞/动画先看画面，再补弹幕和热评；
4. 输出“标题 + UP 主 + 链接 + 一句话看点 + 标签”，挑 1–2 个各配一张最有代表性的帧。

## 3. 互动（写操作）

所有写工具默认 dry-run：

- 先调用一次不带 `confirm` 的工具，把返回的 `action`、`target`、`details` 给用户看；
- 用户明确同意后，再带 `confirm: true` 调用；
- 本地调试用 `bili call <tool> '{...}'`，同样要加 `--confirm` 才真正执行；
- `coin_video` **不可撤销**，执行前必须确认数量和余额；
- `post_comment`、`post_dynamic`、`send_message` 是公开/对外行为，先复述文案；
- `delete_comment` / `delete_dynamic` 只能删自己的内容，且不可撤销，必须先 dry-run 并让用户确认 rpid/动态 ID。
- `top_dynamic` 置顶/取消置顶自己的动态；`top:true/false`，默认 dry-run。
- `update_profile` 修改昵称/签名；昵称消耗 6 硬币，必须先 dry-run 并让用户确认。
- `toview_video` 添加/移除稍后再看，可逆；`add:true/false`，默认 dry-run。
- `send_danmaku` 发送弹幕是公开内容，先 dry-run 并让用户确认文本；`recall_danmaku` 撤回自己的弹幕（通常限发送后 2 分钟内）。
- 需要显式 @ 时给 `post_comment` 传 `mention_user_ids`（数字 UID，不是昵称，最多 10 个）；直接回复顶层评论传 `root=parent=顶层 rpid`，正文保持原样；回复楼中楼传 `root=顶层 rpid`、`parent=目标 rpid`，工具会自动生成 `回复 @父作者 : 正文`。
- 自主运营中主动 @ 主人的时机和分寸见 `bilibili-ops`。
- 评论带图：MCP 会拒绝（传 `image_paths` 会被拦下）；请按 `bilibili-browser-comment` skill 运行 `scripts/post-image-comment-agent-browser.mjs`。动态评论要同时转发到自己的动态时传 `sync_to_dynamic: true`（仅文本）。
- 发布后回读：看返回的 `state`/`pending_review`/`visibility_unknown`；状态不明或 11/17 时，等一会用 `comments` 回读，确认没发出再重试，不要立即删除或重发。
- `post_dynamic` 传 `video` 可发布视频转发动态；传 `image_paths` 可发布图片动态；传 `mention_user_ids` 可显式 @ 用户（最多 10 个，正文里已有 `@昵称` 时会就地转成 AT 组件，否则追加在末尾）。
- `like_video`、`like_dynamic`、`like_comment`、`favorite_video`、`follow_user` 可逆，但也要用户确认目标；`like_dynamic` 的 `dynamic_id` 必填，`like:true/false` 控制点赞/取消；
- 收藏夹创建/改名/删除是写操作，必须先 dry-run；`create_favorite_folder` / `edit_favorite_folder` / `delete_favorite_folder` 分别对应。
- 收藏单个夹传 `folder_id`，多个夹传 `folder_ids`；不知道 folder id 时先调 `list_favorites` 不带 folder_id。

不要（用户请求场景；账号自主运营按 `bilibili-ops` §5 执行）：

- 不要在用户没要求时主动点赞/投币/关注/发私信；
- 不要批量操作或自动关注；
- 不要实现或调用每日签到、银瓜子兑换（已明确不做）。

## 4. 账号信息

- 登录态/硬币/未读：`mcp__bilibili__auth_status`；
- 关注列表：`mcp__bilibili__list_followings`；
- 收藏：`mcp__bilibili__list_favorites`；
- 回复/@/赞：`mcp__bilibili__notifications`；回复/@ 的 `source.rpid`/`root_rpid`/`target_rpid` 可直接用于楼中楼；
- 私信：`mcp__bilibili__messages`（不传 talker_id 列会话，传了读聊天记录）；读通知/聊天记录会触发 B 站已读；
- 动态：`mcp__bilibili__dynamic_feed`（关注流）、`mcp__bilibili__dynamic_detail`（单条）、`mcp__bilibili__user_dynamics`（指定用户/自己）。

如果 `auth_status` 返回 `is_login: false`，转到 `bilibili-login` skill，不要尝试在 MCP 内提取登录态。

## 5. 其它读取

- 搜索：`mcp__bilibili__search`（`keyword`、`type: video/user`、`order`、`page`、`min_play`）；
- 观看历史：`mcp__bilibili__history`；稍后再看：`mcp__bilibili__toview`（写入用 `toview_video`）；
- 入站必刷：`mcp__bilibili__precious_list`；
- 某个 UP 主的投稿：`mcp__bilibili__user_videos`（`mid`、`order`）；
- 粉丝列表：`mcp__bilibili__list_followers`（传 `mid` 可查他人）。

## 6. 失败处理

- `-101`：登录态失效 → `bilibili-login`；
- `-352`：风控 → 降低频率，等待几分钟；
- 无字幕/字幕无效 → 按类型改用 `video_frames`；只能靠画面和评论时，说明信息缺口；
- 抽帧失败 → 检查 ffmpeg，或依赖 `videoshot` 回退；两者都失败就退回字幕和评论区；
- 弹幕为空/接口失败 → 不影响主流程，用热评和字幕补；
- 评论区关闭/加载失败 → 正常现象，别硬刷；
- `b23.tv` 短链解析失败 → 让用户提供 BV 号或完整视频链接；
- 写操作返回 `dry_run` → 正常，需 `confirm=true`。
