import { authStatus } from '../api/account.mjs';
import { preciousList, popularList, rankList, weeklyIssues, weeklyList } from '../api/rankings.mjs';
import {
  relatedVideos,
  search,
  toviewList,
  userInfo,
  userVideos,
  videoInfo,
  watchHistory,
} from '../api/videos.mjs';
import { getTranscript } from '../media/subtitles.mjs';
import { framesAsImages, videoFrames } from '../media/frames.mjs';
import { listFavoriteFolders, listFavorites } from '../api/favorites.mjs';
import { listFollowers, listFollowings, relationStat } from '../api/relations.mjs';
import {
  atNotifications,
  likeNotifications,
  replyNotifications,
  unreadNotifications,
} from '../api/notifications.mjs';
import { fetchSessionMessages, listSessions } from '../api/messages.mjs';
import { dynamicFeed } from '../api/dynamics.mjs';
import { listComments } from '../api/comments.mjs';
import { BiliError } from '../core/errors.mjs';
import {
  coinVideo,
  deleteComment,
  favoriteVideo,
  followUser,
  likeVideo,
  postComment,
  postDynamic,
  sendMessage,
} from '../api/actions.mjs';

const str = (description, extra = {}) => ({ type: 'string', description, ...extra });
const num = (description, extra = {}) => ({ type: 'number', multipleOf: 1, description, ...extra });
const bool = (description, extra = {}) => ({ type: 'boolean', description, ...extra });
const arr = (description, extra = {}) => ({ type: 'array', description, ...extra });

function schema(properties, required = []) {
  return { type: 'object', properties, required, additionalProperties: false };
}

function readOnly() {
  return { readOnlyHint: true, openWorldHint: true };
}

function write() {
  return { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: true };
}

const videoRef = str('视频标识：BV 号、av 号或视频链接，例如 BV1xx411c7mD / https://www.bilibili.com/video/BV...');

export const tools = [
  {
    name: 'auth_status',
    title: 'B站登录态与账号状态',
    description:
      '读取当前 B 站登录态、昵称、UID、硬币、等级、未读通知/私信数。MCP 不提取登录态；未登录时请使用 bilibili-login skill 从浏览器注入 Cookie。',
    annotations: readOnly('读取登录态与账号状态'),
    inputSchema: schema({}),
    handler: async (_args, ctx) => authStatus(ctx.client),
  },
  {
    name: 'rank_list',
    title: 'B站排行榜',
    description:
      '获取 B 站排行榜（对应 /v/popular/rank/all）。返回标题、BV 号、链接、UP 主、分区、统计与标签。标签需逐条补齐，默认只补前 20 条。',
    annotations: readOnly('读取排行榜'),
    inputSchema: schema({
      rid: num('分区 ID；0 为全站', { default: 0, minimum: 0 }),
      type: str('榜单类型', { enum: ['all', 'origin', 'rookie'], default: 'all' }),
      limit: num('返回条数 1-100', { default: 20, minimum: 1, maximum: 100 }),
      include_tags: bool('是否补齐标签（默认 true）', { default: true }),
      tag_limit: num('最多为多少条视频补齐标签', { default: 20, minimum: 0, maximum: 50 }),
    }),
    handler: async (args, ctx) =>
      rankList(ctx.client, {
        rid: args.rid ?? 0,
        type: args.type || 'all',
        limit: args.limit ?? 20,
        includeTags: args.include_tags !== false,
        tagLimit: args.tag_limit ?? 20,
      }),
  },
  {
    name: 'popular_list',
    title: 'B站综合热门',
    description: '获取 B 站综合热门视频（对应 /v/popular/all），支持分页与标签补齐。',
    annotations: readOnly('读取综合热门'),
    inputSchema: schema({
      page: num('页码，从 1 开始', { default: 1, minimum: 1 }),
      ps: num('每页数量 1-20', { default: 20, minimum: 1, maximum: 20 }),
      limit: num('本次返回条数（可选）', { minimum: 1, maximum: 20 }),
      include_tags: bool('是否补齐标签（默认 true）', { default: true }),
      tag_limit: num('最多补标签条数', { default: 20, minimum: 0, maximum: 50 }),
    }),
    handler: async (args, ctx) =>
      popularList(ctx.client, {
        page: args.page ?? 1,
        ps: args.ps ?? 20,
        limit: args.limit,
        includeTags: args.include_tags !== false,
        tagLimit: args.tag_limit ?? 20,
      }),
  },
  {
    name: 'weekly_issues',
    title: '每周必看期数',
    description: '列出 B 站每周必看的期数、主题与链接（对应 /v/popular/weekly）。',
    annotations: readOnly('读取每周必看期数'),
    inputSchema: schema({
      limit: num('返回期数 1-50', { default: 12, minimum: 1, maximum: 50 }),
    }),
    handler: async (args, ctx) => weeklyIssues(ctx.client, { limit: args.limit ?? 12 }),
  },
  {
    name: 'weekly_list',
    title: '每周必看单期',
    description:
      '获取指定期数的每周必看视频列表（对应 /v/popular/weekly?num=395）。不传 number 时默认最新一期。返回标题、链接、标签等。',
    annotations: readOnly('读取每周必看内容'),
    inputSchema: schema({
      number: num('期数，例如 395', { minimum: 1 }),
      limit: num('返回条数 1-100', { default: 50, minimum: 1, maximum: 100 }),
      include_tags: bool('是否补齐标签（默认 true）', { default: true }),
      tag_limit: num('最多补标签条数', { default: 20, minimum: 0, maximum: 100 }),
    }),
    handler: async (args, ctx) =>
      weeklyList(ctx.client, {
        number: args.number,
        limit: args.limit ?? 50,
        includeTags: args.include_tags !== false,
        tagLimit: args.tag_limit ?? 20,
      }),
  },
  {
    name: 'precious_list',
    title: '入站必刷',
    description: '获取 B 站“入站必刷”列表（扩展能力）。',
    annotations: readOnly('读放入站必刷'),
    inputSchema: schema({
      limit: num('返回条数 1-100', { default: 20, minimum: 1, maximum: 100 }),
      include_tags: bool('是否补齐标签', { default: true }),
      tag_limit: num('最多补标签条数', { default: 20, minimum: 0, maximum: 100 }),
    }),
    handler: async (args, ctx) =>
      preciousList(ctx.client, {
        limit: args.limit ?? 20,
        includeTags: args.include_tags !== false,
        tagLimit: args.tag_limit ?? 20,
      }),
  },
  {
    name: 'video_info',
    title: '视频详情',
    description: '获取视频详情：标题、简介、封面、UP 主、统计、分P、标签、可用字幕语言。',
    annotations: readOnly('读取视频详情'),
    inputSchema: schema({
      video: videoRef,
      page: num('分P 序号，从 1 开始', { default: 1, minimum: 1 }),
      include_subtitles: bool('是否查询可用字幕语言（默认 true）', { default: true }),
    }, ['video']),
    handler: async (args, ctx) =>
      videoInfo(ctx.client, {
        bvid: args.video,
        page: args.page ?? 1,
        includeSubtitles: args.include_subtitles !== false,
      }),
  },
  {
    name: 'video_transcript',
    title: '视频字幕/转写文本',
    description:
      '读取视频字幕全文与时间分段。B 站 AI 字幕通常可用；无字幕时返回可用语言与改用 video_frames 的提示。支持多语言字幕。',
    annotations: readOnly('读取视频字幕'),
    inputSchema: schema({
      video: videoRef,
      page: num('分P 序号，从 1 开始', { default: 1, minimum: 1 }),
      lang: str('首选字幕语言，例如 ai-zh、zh-CN、ai-en；不传则自动选择中文优先'),
    }, ['video']),
    handler: async (args, ctx) =>
      getTranscript(ctx.client, {
        bvid: args.video,
        page: args.page ?? 1,
        lang: args.lang,
      }),
  },
  {
    name: 'video_frames',
    title: '视频关键帧截图',
    description:
      '截取视频关键帧并作为图片返回。默认取 15%/50%/85% 三帧；可传秒数、时间（1:23）或百分比。DASH 抽帧失败时回退 B 站缩略图雪碧图；无 ffmpeg 时返回整张雪碧图。',
    annotations: readOnly('截取视频画面（只读）'),
    inputSchema: schema({
      video: videoRef,
      times: {
        description: '时间点数组，例如 ["10%","50%","1:23"] 或 [12, 60]；不传则按 count 均匀取点',
        anyOf: [
          { type: 'string' },
          { type: 'array', items: { anyOf: [{ type: 'string' }, { type: 'number' }] }, minItems: 1, maxItems: 8 },
        ],
      },
      count: num('默认取帧数 1-6', { default: 3, minimum: 1, maximum: 6 }),
      width: num('输出宽度 320-1920', { default: 960, minimum: 320, maximum: 1920 }),
      page: num('分P 序号', { default: 1, minimum: 1 }),
      max_height: num('选流最大高度', { default: 1080, minimum: 360, maximum: 2160 }),
      fallback: bool('抽帧失败时回退 videoshot 缩略图', { default: true }),
      max_images: num('随结果返回的图片数量 1-4', { default: 3, minimum: 1, maximum: 4 }),
    }, ['video']),
    handler: async (args, ctx) => {
      const result = await videoFrames(ctx.client, {
        bvid: args.video,
        times: args.times,
        count: args.count ?? 3,
        width: args.width ?? 960,
        page: args.page ?? 1,
        maxHeight: args.max_height ?? 1080,
        fallback: args.fallback !== false,
      });
      let images = await framesAsImages(result.frames, { limit: args.max_images ?? 3 });
      if (!images.length && result.sprite) {
        try {
          images = [await imageFile(result.sprite)];
        } catch {
          images = [];
        }
      }
      return {
        ...result,
        images: images.map(({ data, ...meta }) => meta),
        __images: images,
        hint:
          result.source === 'videoshot'
            ? result.sprite_only
              ? '已回退到整张缩略图雪碧图；安装 ffmpeg 后可裁切为单帧。'
              : '已回退到低分辨率缩略图；如需更清晰画面，可安装 ffmpeg 或检查视频是否可播放。'
            : undefined,
      };
    },
  },
  {
    name: 'comments',
    title: '评论区（视频/动态）',
    description:
      '读取视频或动态评论区，包含评论内容、作者、点赞数、state、@成员和楼中楼回复。video 与 dynamic_id 二选一；动态评论使用 offset 游标，可用 page 便捷翻页。',
    annotations: readOnly('读取视频/动态评论'),
    inputSchema: schema({
      video: videoRef,
      dynamic_id: str('动态 ID；与 video 二选一'),
      page: num('页码', { default: 1, minimum: 1 }),
      ps: num('视频评论每页 1-49（动态使用服务端页大小）', { default: 20, minimum: 1, maximum: 49 }),
      sort: str('排序', { enum: ['hot', 'time'], default: 'hot' }),
      offset: str('动态评论游标；传了就按游标读取'),
      root: str('可选：根评论 rpid；传了就读取该评论的楼中楼回复'),
    }),
    handler: async (args, ctx) => {
      if (!args.video && !args.dynamic_id) throw new Error('需要提供 video 或 dynamic_id');
      if (args.video && args.dynamic_id) throw new Error('video 与 dynamic_id 只能提供其中一个');
      return listComments(ctx.client, {
        bvid: args.video,
        dynamicId: args.dynamic_id,
        page: args.page ?? 1,
        ps: args.ps ?? 20,
        sort: args.sort || 'hot',
        offset: args.offset,
        root: args.root,
      });
    },
  },
  {
    name: 'search',
    title: '搜索视频/用户',
    description: '按关键词搜索 B 站视频或用户；视频结果含 BV 号、链接、作者、标签。',
    annotations: readOnly('搜索 B 站内容'),
    inputSchema: schema({
      keyword: str('搜索关键词'),
      type: str('搜索类型', { enum: ['video', 'user'], default: 'video' }),
      page: num('页码', { default: 1, minimum: 1 }),
      limit: num('返回条数 1-50', { default: 20, minimum: 1, maximum: 50 }),
      order: str('排序：totalrank / click / pubdate / dm / stow', { default: 'totalrank' }),
    }, ['keyword']),
    handler: async (args, ctx) =>
      search(ctx.client, {
        keyword: args.keyword,
        type: args.type || 'video',
        page: args.page ?? 1,
        limit: args.limit ?? 20,
        order: args.order || 'totalrank',
      }),
  },
  {
    name: 'user_info',
    title: '用户信息',
    description: '获取 UP 主/用户的名片信息、等级、粉丝数、关注数。',
    annotations: readOnly('读取用户信息'),
    inputSchema: schema({ mid: str('用户 UID') }, ['mid']),
    handler: async (args, ctx) => userInfo(ctx.client, { mid: args.mid }),
  },
  {
    name: 'user_videos',
    title: '用户投稿',
    description: '获取指定 UP 主的投稿视频列表。',
    annotations: readOnly('读取用户投稿'),
    inputSchema: schema({
      mid: str('用户 UID'),
      page: num('页码', { default: 1, minimum: 1 }),
      limit: num('每页 1-50', { default: 20, minimum: 1, maximum: 50 }),
      order: str('排序：pubdate / click / stow', { default: 'pubdate' }),
    }, ['mid']),
    handler: async (args, ctx) =>
      userVideos(ctx.client, {
        mid: args.mid,
        page: args.page ?? 1,
        limit: args.limit ?? 20,
        order: args.order || 'pubdate',
      }),
  },
  {
    name: 'list_followings',
    title: '关注列表',
    description: '获取当前账号（或指定用户）的关注列表，支持分页。',
    annotations: readOnly('读取关注列表'),
    inputSchema: schema({
      mid: str('用户 UID；不传则使用当前登录账号'),
      page: num('页码', { default: 1, minimum: 1 }),
      ps: num('每页 1-50', { default: 50, minimum: 1, maximum: 50 }),
    }),
    handler: async (args, ctx) =>
      listFollowings(ctx.client, {
        mid: args.mid,
        page: args.page ?? 1,
        ps: args.ps ?? 50,
      }),
  },
  {
    name: 'list_followers',
    title: '粉丝列表（扩展）',
    description: '获取当前账号（或指定用户）的粉丝列表。',
    annotations: readOnly('读取粉丝列表'),
    inputSchema: schema({
      mid: str('用户 UID；不传则使用当前登录账号'),
      page: num('页码', { default: 1, minimum: 1 }),
      ps: num('每页 1-50', { default: 50, minimum: 1, maximum: 50 }),
    }),
    handler: async (args, ctx) =>
      listFollowers(ctx.client, { mid: args.mid, page: args.page ?? 1, ps: args.ps ?? 50 }),
  },
  {
    name: 'list_favorites',
    title: '收藏夹与收藏内容',
    description:
      '不传 folder_id 时列出收藏夹；传 folder_id 时读取该收藏夹的视频内容（支持分页）。',
    annotations: readOnly('读取收藏夹'),
    inputSchema: schema({
      folder_id: str('收藏夹 media_id；不传则只列收藏夹'),
      page: num('页码', { default: 1, minimum: 1 }),
      ps: num('每页 1-40', { default: 20, minimum: 1, maximum: 40 }),
      keyword: str('收藏夹内搜索关键词'),
      order: str('排序：mtime / view / pubtime', { default: 'mtime' }),
    }),
    handler: async (args, ctx) =>
      listFavorites(ctx.client, {
        folderId: args.folder_id,
        page: args.page ?? 1,
        ps: args.ps ?? 20,
        keyword: args.keyword || '',
        order: args.order || 'mtime',
      }),
  },
  {
    name: 'notifications',
    title: '回复 / @ / 点赞通知',
    description:
      '读取 B 站消息中心通知。kind=unread 返回未读数；reply 返回“回复我的”；at 返回“@ 我的”；like 返回“收到的赞”。',
    annotations: readOnly('读取通知'),
    inputSchema: schema({
      kind: str('通知类型', { enum: ['unread', 'reply', 'at', 'like'], default: 'unread' }),
      page: num('页码（reply/at/like 有效）', { default: 1, minimum: 1 }),
      ps: num('每页 1-20', { default: 20, minimum: 1, maximum: 20 }),
    }),
    handler: async (args, ctx) => {
      const kind = args.kind || 'unread';
      if (kind === 'unread') return unreadNotifications(ctx.client);
      if (kind === 'reply') return replyNotifications(ctx.client, { page: args.page ?? 1, ps: args.ps ?? 20 });
      if (kind === 'at') return atNotifications(ctx.client, { page: args.page ?? 1, ps: args.ps ?? 20 });
      return likeNotifications(ctx.client, { page: args.page ?? 1, ps: args.ps ?? 20 });
    },
  },
  {
    name: 'messages',
    title: '私信会话 / 聊天记录',
    description:
      '不传 talker_id 时列出私信会话；传 talker_id 时读取与该用户的聊天记录（按时间升序）。',
    annotations: readOnly('读取私信'),
    inputSchema: schema({
      talker_id: str('会话对方的 UID；不传则列出会话'),
      limit: num('会话数或消息数 1-100', { default: 20, minimum: 1, maximum: 100 }),
    }),
    handler: async (args, ctx) => {
      if (args.talker_id) {
        return fetchSessionMessages(ctx.client, { talkerId: args.talker_id, limit: args.limit ?? 30 });
      }
      return listSessions(ctx.client, { limit: args.limit ?? 20 });
    },
  },
  {
    name: 'dynamic_feed',
    title: '关注动态流',
    description:
      '读取关注动态流，包含作者、文本、图片、视频卡片与互动数。支持翻页：用返回的 next_offset 作为 offset 继续，或直接传 page；B 站每页 20 条。',
    annotations: readOnly('读取动态'),
    inputSchema: schema({
      page: num('页码，从 1 开始；不传 offset 时生效', { default: 1, minimum: 1, maximum: 20 }),
      offset: str('游标；优先于 page。把上一页返回的 next_offset 传进来'),
      type: str('动态流类型', { enum: ['all', 'video', 'article'], default: 'all' }),
    }),
    handler: async (args, ctx) => {
      return dynamicFeed(ctx.client, {
        page: args.page ?? 1,
        offset: args.offset,
        type: args.type || 'all',
      });
    },
  },
  {
    name: 'history',
    title: '观看历史',
    description: '读取当前账号的观看历史（扩展能力）。',
    annotations: readOnly('读取历史记录'),
    inputSchema: schema({
      ps: num('返回条数 1-30', { default: 20, minimum: 1, maximum: 30 }),
    }),
    handler: async (args, ctx) => watchHistory(ctx.client, { ps: args.ps ?? 20 }),
  },
  {
    name: 'toview',
    title: '稍后再看（扩展）',
    description: '读取当前账号的“稍后再看”列表。',
    annotations: readOnly('读取稍后再看'),
    inputSchema: schema({
      ps: num('返回条数 1-30', { default: 20, minimum: 1, maximum: 30 }),
    }),
    handler: async (args, ctx) => toviewList(ctx.client, { ps: args.ps ?? 20 }),
  },
  {
    name: 'related_videos',
    title: '相关推荐（扩展）',
    description: '读取某个视频的相关推荐列表。',
    annotations: readOnly('读取相关推荐'),
    inputSchema: schema({
      video: videoRef,
      limit: num('返回条数 1-50', { default: 20, minimum: 1, maximum: 50 }),
    }, ['video']),
    handler: async (args, ctx) => relatedVideos(ctx.client, { bvid: args.video, limit: args.limit ?? 20 }),
  },
  {
    name: 'like_video',
    title: '点赞 / 取消点赞',
    description: '点赞或取消点赞视频。默认只预览，不执行；confirm=true 才真正发送请求。可逆。',
    annotations: write('点赞或取消点赞（默认 dry-run）'),
    inputSchema: schema({
      video: videoRef,
      like: bool('true 点赞，false 取消', { default: true }),
      confirm: bool('必须为 true 才执行', { default: false }),
    }, ['video']),
    handler: async (args, ctx) =>
      likeVideo(ctx.client, { bvid: args.video, like: args.like !== false, confirm: args.confirm === true }),
  },
  {
    name: 'coin_video',
    title: '投币',
    description:
      '给视频投 1-2 枚硬币。默认只预览；confirm=true 才执行。硬币不可撤销，请先确认余额与数量。',
    annotations: write('投币（默认 dry-run，不可撤销）'),
    inputSchema: schema({
      video: videoRef,
      multiply: num('投币数量 1-2', { default: 1, minimum: 1, maximum: 2 }),
      select_like: bool('是否同时点赞', { default: false }),
      confirm: bool('必须为 true 才执行', { default: false }),
    }, ['video']),
    handler: async (args, ctx) =>
      coinVideo(ctx.client, {
        bvid: args.video,
        multiply: args.multiply ?? 1,
        selectLike: args.select_like === true,
        confirm: args.confirm === true,
      }),
  },
  {
    name: 'favorite_video',
    title: '收藏 / 取消收藏',
    description:
      '把视频加入或移出指定收藏夹。默认只预览；confirm=true 才执行。不传 folder_id 时会返回可用收藏夹列表。',
    annotations: write('收藏或取消收藏（默认 dry-run）'),
    inputSchema: schema({
      video: videoRef,
      folder_id: str('目标收藏夹 media_id'),
      favorite: bool('true 收藏，false 取消', { default: true }),
      confirm: bool('必须为 true 才执行', { default: false }),
    }, ['video']),
    handler: async (args, ctx) =>
      favoriteVideo(ctx.client, {
        bvid: args.video,
        folderId: args.folder_id,
        favorite: args.favorite !== false,
        confirm: args.confirm === true,
      }),
  },
  {
    name: 'post_comment',
    title: '发表评论 / 回复',
    description:
      '在视频或动态下发表评论，可选本地图片；提供 root/parent 可回复某条评论。默认只预览；confirm=true 才发布。评论是公开内容。',
    annotations: write('发表公开评论（默认 dry-run）'),
    inputSchema: schema({
      video: videoRef,
      dynamic_id: str('动态 ID；与 video 二选一'),
      message: str('评论内容，最多 1000 字', { minLength: 1, maxLength: 1000 }),
      root: str('根评论 rpid（回复二级评论时）'),
      parent: str('父评论 rpid（回复某条评论时）'),
      mention_user_ids: arr('要显式 @ 的用户 UID 数组，最多 10 个', { items: { type: 'string' }, maxItems: 10 }),
      image_paths: arr('本地图片路径数组，最多 9 张（jpg/png/gif）', { items: { type: 'string' }, maxItems: 9 }),
      confirm: bool('必须为 true 才发布', { default: false }),
    }, ['message']),
    handler: async (args, ctx) => {
      if (!args.video && !args.dynamic_id) throw new Error('需要提供 video 或 dynamic_id');
      return postComment(ctx.client, {
        bvid: args.video,
        message: args.message,
        dynamicId: args.dynamic_id,
        root: args.root,
        parent: args.parent,
        mentionUserIds: args.mention_user_ids || [],
        imagePaths: args.image_paths || [],
        confirm: args.confirm === true,
      });
    },
  },
  {
    name: 'delete_comment',
    title: '删除自己的评论',
    description:
      '删除当前账号自己的视频/动态评论。默认只预览；confirm=true 才删除。只能删除自己的评论，删除不可撤销。',
    annotations: write('删除评论（默认 dry-run）'),
    inputSchema: schema({
      video: videoRef,
      dynamic_id: str('动态 ID；与 video 二选一'),
      rpid: str('要删除的评论 rpid'),
      confirm: bool('必须为 true 才删除', { default: false }),
    }, ['rpid']),
    handler: async (args, ctx) => {
      if (!args.video && !args.dynamic_id) throw new Error('需要提供 video 或 dynamic_id');
      if (args.video && args.dynamic_id) throw new Error('video 与 dynamic_id 只能提供其中一个');
      return deleteComment(ctx.client, {
        bvid: args.video,
        dynamicId: args.dynamic_id,
        rpid: args.rpid,
        confirm: args.confirm === true,
      });
    },
  },
  {
    name: 'post_dynamic',
    title: '发布动态',
    description:
      '发布一条动态（文本，可选本地图片路径）。默认只预览；confirm=true 才发布。动态是公开内容。',
    annotations: write('发布公开动态（默认 dry-run）'),
    inputSchema: schema({
      text: str('动态正文，最多 2000 字', { maxLength: 2000 }),
      image_paths: arr('本地图片路径数组，最多 9 张（jpg/png/gif）', {
        items: { type: 'string' },
        maxItems: 9,
      }),
      confirm: bool('必须为 true 才发布', { default: false }),
    }),
    handler: async (args, ctx) =>
      postDynamic(ctx.client, {
        text: args.text,
        imagePaths: args.image_paths || [],
        confirm: args.confirm === true,
      }),
  },
  {
    name: 'follow_user',
    title: '关注 / 取关',
    description: '关注或取关某个用户。默认只预览；confirm=true 才执行。可逆。',
    annotations: write('关注或取关（默认 dry-run）'),
    inputSchema: schema({
      mid: str('目标用户 UID'),
      follow: bool('true 关注，false 取关', { default: true }),
      confirm: bool('必须为 true 才执行', { default: false }),
    }, ['mid']),
    handler: async (args, ctx) =>
      followUser(ctx.client, { mid: args.mid, follow: args.follow !== false, confirm: args.confirm === true }),
  },
  {
    name: 'send_message',
    title: '发送私信',
    description: '给指定用户发送私信。默认只预览；confirm=true 才发送。私信会立即送达对方。',
    annotations: write('发送私信（默认 dry-run）'),
    inputSchema: schema({
      receiver_id: str('接收者 UID'),
      text: str('私信内容，最多 2000 字节', { minLength: 1 }),
      confirm: bool('必须为 true 才发送', { default: false }),
    }, ['receiver_id', 'text']),
    handler: async (args, ctx) =>
      sendMessage(ctx.client, {
        receiverId: args.receiver_id,
        text: args.text,
        confirm: args.confirm === true,
      }),
  },
];

export const toolMap = new Map(tools.map((tool) => [tool.name, tool]));

function typeMatches(value, type) {
  switch (type) {
    case 'string':
      return typeof value === 'string';
    case 'number':
      return typeof value === 'number' && Number.isFinite(value);
    case 'integer':
      return Number.isInteger(value);
    case 'boolean':
      return typeof value === 'boolean';
    case 'array':
      return Array.isArray(value);
    case 'object':
      return value !== null && typeof value === 'object' && !Array.isArray(value);
    default:
      return true;
  }
}

function validateValue(value, spec, path) {
  if (!spec || value === undefined || value === null) return;
  if (spec.anyOf) {
    const valid = spec.anyOf.some((branch) => {
      try {
        validateValue(value, branch, path);
        return true;
      } catch {
        return false;
      }
    });
    if (!valid) throw new BiliError(`参数 ${path} 类型不匹配`, { code: -400, hint: '检查参数类型。' });
    return;
  }
  if (spec.enum && !spec.enum.includes(value)) {
    throw new BiliError(`参数 ${path} 必须是 ${spec.enum.join(' / ')} 之一`, { code: -400 });
  }
  if (spec.type && !typeMatches(value, spec.type)) {
    throw new BiliError(`参数 ${path} 应为 ${spec.type}`, { code: -400, hint: 'MCP 客户端应按 inputSchema 传参。' });
  }
  if (typeof value === 'number') {
    if (spec.minimum !== undefined && value < spec.minimum) {
      throw new BiliError(`参数 ${path} 不能小于 ${spec.minimum}`, { code: -400 });
    }
    if (spec.maximum !== undefined && value > spec.maximum) {
      throw new BiliError(`参数 ${path} 不能大于 ${spec.maximum}`, { code: -400 });
    }
    if (spec.multipleOf !== undefined) {
      const quotient = value / spec.multipleOf;
      if (Math.abs(quotient - Math.round(quotient)) > 1e-9) {
        throw new BiliError(`参数 ${path} 必须是 ${spec.multipleOf} 的整数倍`, { code: -400 });
      }
    }
  }
  if (typeof value === 'string') {
    if (spec.minLength !== undefined && value.length < spec.minLength) {
      throw new BiliError(`参数 ${path} 长度不能小于 ${spec.minLength}`, { code: -400 });
    }
    if (spec.maxLength !== undefined && value.length > spec.maxLength) {
      throw new BiliError(`参数 ${path} 长度不能大于 ${spec.maxLength}`, { code: -400 });
    }
  }
  if (Array.isArray(value)) {
    if (spec.minItems !== undefined && value.length < spec.minItems) {
      throw new BiliError(`参数 ${path} 至少需要 ${spec.minItems} 项`, { code: -400 });
    }
    if (spec.maxItems !== undefined && value.length > spec.maxItems) {
      throw new BiliError(`参数 ${path} 最多 ${spec.maxItems} 项`, { code: -400 });
    }
    if (spec.items) value.forEach((item, index) => validateValue(item, spec.items, `${path}[${index}]`));
  }
}

export function validateToolArgs(tool, args) {
  const schema = tool.inputSchema || {};
  const properties = schema.properties || {};
  for (const key of schema.required || []) {
    if (args[key] === undefined) {
      throw new BiliError(`缺少必填参数：${key}`, { code: -400, hint: '检查工具参数。' });
    }
  }
  for (const [key, value] of Object.entries(args)) {
    if (properties[key]) validateValue(value, properties[key], key);
  }
}

export async function runTool(name, args, ctx) {
  const tool = toolMap.get(name);
  if (!tool) throw new Error(`未知工具：${name}`);
  const normalized = args || {};
  validateToolArgs(tool, normalized);
  return tool.handler(normalized, ctx);
}
