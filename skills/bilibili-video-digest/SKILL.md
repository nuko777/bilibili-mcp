---
name: bilibili-video-digest
description: 用 bilibili MCP 工具理解单个 B 站视频：读元信息、字幕和关键帧，按内容类型决定看字幕还是看画面。
whenToUse: 当用户要求“看/理解/评价某个 B 站视频”“读字幕”“截画面/九宫格/取某一帧截图”时。
---

# B 站视频理解（工具用法）

工具命名空间：`mcp__bilibili__*`。登录态由 `bilibili-login` skill 负责，本 skill 不处理 Cookie。

## 1. 取元信息

先 `video_info`：标题、UP 主、时长、cid、分P、标签和 `subtitle_languages`。看指定分P传 `page`；BV 号、av 号、完整链接和 `b23.tv` 短链都可以直接传。

## 2. 选主证据：字幕还是画面

| 内容类型 | 第一优先级 | 做法 |
| --- | --- | --- |
| 知识讲解、口播、访谈、课程、测评、纪录片解说 | 字幕 | 字幕有效（语言对得上、能读通、不是空壳或错位 ASR）就以字幕为准，按 `segments` 的 `from`/`to` 引时间点；无效再转画面 |
| 二创、鬼畜、MAD/AMV、舞蹈、歌曲、MV、动画、手书、纯剪辑 | 画面帧 | 以 `video_frames` 为主；用 `type:"grid"` 一次看多帧，歌舞和剧情向要覆盖副歌、高潮段；字幕只用来对歌词、台词 |
| 混合型（剧情+解说、科技评测带实拍） | 字幕 + 画面 | 字幕拿信息，帧拿产品细节和名场面，两边互相印证 |

字幕不是有就用：没字幕、只有外语、机器转写明显错乱、或台词只占很小一部分时，转 `video_frames`，别硬拿字幕编内容。反过来，字幕优先也别只看字幕：知识类抽 1–2 帧核对画面；画面优先的也别跳过字幕，歌词、台词、字幕卡经常是关键信息。

## 3. 返回字段与默认值

参数（`count`、`times`、`type`、`labels`、`timeout_ms`、`max_images` 等）以 MCP 工具描述为准；下面只记工具描述里没有的部分：

- `video_transcript` 返回 `text`、`segments`（`from`/`to`/`content`）、`available`、`char_count`；无字幕时 `has_subtitle: false` 并带 `hint`。
- `video_frames` 不传 `count` 时：`frames` 模式取 3 帧（15%/50%/85%），`grid` 模式取 9 帧。`frames` 每帧带 `time`、`file`；`grid` 返回拼图（`from`/`to` 为单元格范围）和 `times` 列表。
- `max_images` 默认 3，不会随 `count` 自动增加：要看 6 帧就传 `max_images:6`，要看 9 张拼图传 `max_images:9`；只取某一秒的单帧用 `times:["12:34"]` + `max_images:1`，返回的帧带 `file` 路径可直接贴图。

## 4. 失败处理

- 无字幕/字幕无效 → 按类型改用 `video_frames`；只能靠画面时，说明信息缺口；
- 抽帧失败 → 检查 ffmpeg，或依赖 `videoshot` 回退；两者都失败就退回字幕；
- `-101`：登录态失效 → `bilibili-login`；`-352`：风控 → 降低频率，等待几分钟。
