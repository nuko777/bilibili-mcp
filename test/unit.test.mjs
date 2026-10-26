import test from 'node:test';
import assert from 'node:assert/strict';
import { buildQuery, extractWbiKeys, getMixinKey, signParams } from '../src/core/wbi.mjs';
import { normalizeCookieObjects, parseCookieHeader, serializeCookies, missingLoginCookies } from '../src/core/cookies.mjs';
import { normalizeDynamic } from '../src/api/dynamics.mjs';
import { parseMessageContent } from '../src/api/messages.mjs';
import { normalizeVideo, parseVideoRef, resolveFrameTimes, formatDuration } from '../src/core/format.mjs';
import { selectVideoStream } from '../src/media/playurl.mjs';
import { BiliClient } from '../src/core/http.mjs';
import { choosePage, resolveShortVideoRef, search } from '../src/api/videos.mjs';
import { popularList } from '../src/api/rankings.mjs';
import { replyNotifications } from '../src/api/notifications.mjs';
import { runTool, toolMap, validateToolArgs } from '../src/tools/index.mjs';
import { listComments, normalizeReply, resolveCommentTarget } from '../src/api/comments.mjs';
import {
  deleteFavoriteFolder,
  editFavoriteFolder,
  favoriteVideo,
  postComment,
  postDynamic,
  recallDanmaku,
  replyAuthorName,
  sendDanmaku,
  sendMessage,
} from '../src/api/actions.mjs';
import { videoFrames } from '../src/media/frames.mjs';
import { decodeDanmakuSeg, decodeDanmakuView } from '../src/api/danmaku.mjs';

const IMG = '7cd084941338484aae1ad9425b84077c';
const SUB = '4932caff0ff746eab6f01bf08b70ac45';

test('WBI mixin key and signature match a fixed vector', () => {
  const mixin = getMixinKey(IMG, SUB);
  assert.equal(mixin, 'ea1db124af3c7062474693fa704f4ff8');
  const signed = signParams({ foo: '114', bar: '514', zab: '1919810' }, mixin, { wts: 1700000000 });
  assert.equal(signed.wts, 1700000000);
  assert.equal(signed.w_rid, '8ae2d96aa0a4f8c5afa194a6ecca1bf9');
});

test('extractWbiKeys reads nav payload', () => {
  const keys = extractWbiKeys({
    data: { wbi_img: { img_url: `https://i0.hdslb.com/bfs/wbi/${IMG}.png`, sub_url: `https://i0.hdslb.com/bfs/wbi/${SUB}.png` } },
  });
  assert.equal(keys.imgKey, IMG);
  assert.equal(keys.subKey, SUB);
  assert.equal(keys.mixinKey.length, 32);
});

test('cookie parsing, serialization, dedupe and expiry', () => {
  const parsed = parseCookieHeader('SESSDATA=abc; bili_jct=xyz=1; empty=');
  assert.equal(parsed.SESSDATA, 'abc');
  assert.equal(parsed.bili_jct, 'xyz=1');
  assert.equal(serializeCookies(parsed), 'SESSDATA=abc; bili_jct=xyz=1; empty=');

  const normalized = normalizeCookieObjects([
    { name: 'SESSDATA', value: 'old', domain: '.bilibili.com', expires: 1 },
    { name: 'SESSDATA', value: 'new', domain: 'www.bilibili.com', expires: 9999999999 },
    { name: 'buvid3', value: 'b3', domain: '.bilibili.com', expires: -1 },
    { name: 'other', value: 'x', domain: '.example.com', expires: 9999999999 },
    { name: 'expired', value: 'x', domain: '.bilibili.com', expires: 1 },
  ]);
  assert.equal(normalized.SESSDATA, 'new');
  assert.equal(normalized.buvid3, 'b3');
  assert.equal(normalized.other, undefined);
  assert.equal(normalized.expired, undefined);
  assert.deepEqual(missingLoginCookies({ SESSDATA: 'a' }), ['bili_jct', 'DedeUserID', 'DedeUserID__ckMd5', 'buvid3', 'buvid4']);
});

test('video references and frame time expressions', () => {
  assert.deepEqual(parseVideoRef('BV1xx411c7mD'), { bvid: 'BV1xx411c7mD', aid: null });
  assert.deepEqual(parseVideoRef('https://www.bilibili.com/video/BV1xx411c7mD/?p=2'), {
    bvid: 'BV1xx411c7mD',
    aid: null,
  });
  assert.deepEqual(parseVideoRef('av12345'), { bvid: null, aid: '12345' });
  assert.deepEqual(parseVideoRef({ bvid: 'BV1xx411c7mD' }), { bvid: 'BV1xx411c7mD', aid: null });
  assert.deepEqual(parseVideoRef({ bvid: 'https://www.bilibili.com/video/BV1xx411c7mD' }), {
    bvid: 'BV1xx411c7mD',
    aid: null,
  });
  assert.throws(() => parseVideoRef({ bvid: 'https://b23.tv/abc' }), /需要提供/);
  assert.deepEqual(resolveFrameTimes({ times: ['10%', '50%', '1:00'], duration: 200 }), [20, 60, 100]);
  assert.deepEqual(resolveFrameTimes({ count: 2, duration: 100 }), [15, 50]);
  assert.deepEqual(resolveFrameTimes({ times: ['10%', '30%', '55%', '80%'], count: 3, duration: 200 }), [20, 60, 110, 160]);
  assert.equal(formatDuration(355), '5:55');
});

test('video normalization keeps title, tags and URL', () => {
  const video = normalizeVideo(
    {
      bvid: 'BV1xx411c7mD',
      aid: 1,
      title: '<em>标题</em>',
      pic: 'http://i0.hdslb.com/a.jpg',
      duration: 355,
      owner: { mid: 2, name: 'UP', face: '//i0.hdslb.com/f.jpg' },
      stat: { view: 10, like: 2 },
      tags: [{ tag_name: '动画' }],
    },
    'test',
  );
  assert.equal(video.url, 'https://www.bilibili.com/video/BV1xx411c7mD');
  assert.equal(video.title, '标题');
  assert.equal(video.cover, 'https://i0.hdslb.com/a.jpg');
  assert.deepEqual(video.tags, ['动画']);
  assert.equal(video.owner.mid, '2');
});

test('message content parsing handles text, image and recall', () => {
  assert.equal(parseMessageContent({ msg_type: 1, content: '{"content":"你好"}' }).text, '你好');
  assert.equal(parseMessageContent({ msg_type: 2, content: '{"url":"//i0.hdslb.com/x.jpg"}' }).text, '[图片]');
  assert.equal(parseMessageContent({ msg_type: 13, content: '{}' }).text, '[撤回]');
});

test('dynamic normalization extracts author, video card and stats', () => {
  const dynamic = normalizeDynamic({
    id_str: '1261291569711939586',
    type: 'DYNAMIC_TYPE_AV',
    modules: {
      module_author: { mid: 2, name: 'UP', face: 'https://i0.hdslb.com/f.jpg', pub_ts: '1792505728' },
      module_dynamic: {
        desc: null,
        major: {
          archive: {
            bvid: 'BV1Ndnw6KEAq',
            title: '视频标题',
            cover: 'http://i0.hdslb.com/c.jpg',
            duration_text: '00:13',
            stat: { play: '1632' },
          },
        },
      },
      module_stat: { like: { count: 268 }, comment: { count: 6 }, forward: { count: 1 } },
    },
  });
  assert.equal(dynamic.id, '1261291569711939586');
  assert.equal(dynamic.author.name, 'UP');
  assert.equal(dynamic.video.bvid, 'BV1Ndnw6KEAq');
  assert.equal(dynamic.video.play, 1632);
  assert.equal(dynamic.stat.like, 268);
  assert.equal(dynamic.url, 'https://t.bilibili.com/1261291569711939586');
});

test('stream selection prefers AVC and respects max height', () => {
  const dash = {
    video: [
      { codecid: 12, height: 1080, bandwidth: 3000, baseUrl: 'hevc' },
      { codecid: 7, height: 1080, bandwidth: 2000, baseUrl: 'avc1080' },
      { codecid: 7, height: 720, bandwidth: 4000, baseUrl: 'avc720' },
      { codecid: 7, height: 2160, bandwidth: 9000, baseUrl: 'avc4k' },
    ],
  };
  assert.equal(selectVideoStream(dash, { maxHeight: 1080 }).baseUrl, 'avc1080');
  assert.equal(selectVideoStream(dash, { maxHeight: 720 }).baseUrl, 'avc720');
  assert.equal(selectVideoStream(dash, { maxHeight: 2160 }).baseUrl, 'avc4k');
});

test('WBI signature and final query share one encoder', () => {
  const mixin = getMixinKey(IMG, SUB);
  const signed = signParams({ q: 'DeepSeek R1', mark: "a!b'c(d)e*f" }, mixin, { wts: 1700000000 });
  const query = buildQuery(signed, { sort: true });
  assert.match(query, /q=DeepSeek%20R1/);
  assert.match(query, /mark=abcdef/);
  assert.doesNotMatch(query, /\+/);
});

test('empty times and decimal pages are handled early', () => {
  assert.throws(() => resolveFrameTimes({ times: [], duration: 100 }), /不能为空/);
  const view = { cid: 1, title: 'v', duration: 10, pages: [
    { page: 1, cid: 1, part: 'p1', duration: 10 },
    { page: 2, cid: 2, part: 'p2', duration: 10 },
    { page: 3, cid: 3, part: 'p3', duration: 10 },
  ] };
  assert.equal(choosePage(view, 2.9).page, 2);
});

test('tool argument validation rejects string booleans and missing required fields', () => {
  const like = toolMap.get('like_video');
  assert.throws(() => validateToolArgs(like, { video: 'BV1xx411c7mD', like: 'false' }), /应为 boolean/);
  assert.throws(() => validateToolArgs(like, {}), /缺少必填参数/);
});

test('OPUS dynamic resolves its own comment subject', async () => {
  const fake = {
    get: async () => ({
      data: {
        item: {
          id_str: '1261344079956934665',
          type: 'DYNAMIC_TYPE_DRAW',
          basic: { comment_type: 11, comment_id_str: '412834027', rid_str: '412834027' },
          modules: {
            module_author: { mid: '12539868', name: 'tester', pub_ts: '1' },
            module_dynamic: { major: { opus: { summary: { text: 'hello' } } } },
          },
        },
      },
    }),
  };
  const resolved = await resolveCommentTarget(fake, { dynamicId: '1261344079956934665' });
  assert.equal(resolved.kind, 'dynamic');
  assert.equal(resolved.oid, '412834027');
  assert.equal(resolved.type, 11);
  assert.equal(resolved.target.comment_oid, '412834027');
  assert.equal(resolved.target.comment_type, 11);
});

test('grid time resolution supports up to 81 explicit times', () => {
  const times = Array.from({ length: 81 }, (_, index) => index);
  const resolved = resolveFrameTimes({ times, duration: 100, maxTimes: 81 });
  assert.equal(resolved.length, 81);
  assert.equal(resolved[80], 80);
  assert.equal(resolveFrameTimes({ times, duration: 100 }).length, 12);
});

test('child comment replies keep state and is_up', () => {
  const reply = normalizeReply(
    {
      rpid_str: '1',
      member: { mid: 100, uname: 'root' },
      content: { message: 'root' },
      state: 0,
      replies: [
        {
          rpid_str: '2',
          member: { mid: 200, uname: 'child' },
          content: { message: 'child' },
          state: 17,
        },
      ],
    },
    { ownerMid: '100' },
  );
  assert.equal(reply.state, 0);
  assert.equal(reply.is_up, true);
  assert.equal(reply.is_top, false);
  assert.equal(reply.replies[0].state, 17);
  assert.equal(reply.replies[0].is_up, false);
  const pinned = normalizeReply(
    { rpid_str: '3', member: { mid: 100, uname: 'root' }, content: { message: 'pinned' }, state: 0 },
    { ownerMid: '100', isTop: true },
  );
  assert.equal(pinned.is_top, true);
});

test('comment pictures are normalized', () => {
  const reply = normalizeReply({
    rpid_str: '9',
    member: { mid: 1, uname: 'u' },
    content: {
      message: 'image',
      pictures: [{ img_src: '//i0.hdslb.com/a.jpg', img_width: 320, img_height: 180, img_size: 1.5 }],
    },
    state: 0,
  });
  assert.equal(reply.pictures[0].url, 'https://i0.hdslb.com/a.jpg');
  assert.equal(reply.pictures[0].width, 320);
  assert.equal(reply.pictures[0].height, 180);
});

test('tool argument validation rejects unknown fields, null and out-of-range values', () => {
  const like = toolMap.get('like_video');
  assert.throws(() => validateToolArgs(like, { video: 'BV1xx411c7mD', lik: true }), /未知参数/);
  assert.throws(() => validateToolArgs(like, { video: 'BV1xx411c7mD', like: null }), /不能为 null/);
  const danmaku = toolMap.get('send_danmaku');
  assert.throws(
    () => validateToolArgs(danmaku, { video: 'BV1xx411c7mD', text: 'hi', color: 0x1000000 }),
    /不能大于/,
  );
  const postDynamic = toolMap.get('post_dynamic');
  assert.throws(
    () => validateToolArgs(postDynamic, { text: 'hello', sync_to_dynamic: true }),
    /未知参数/,
  );
  const comments = toolMap.get('comments');
  assert.throws(
    () => validateToolArgs(comments, { video: 'BV1xx411c7mD', page: 21 }),
    /不能大于 20/,
  );
});

test('video_frames frames mode rejects more than 12 explicit times', async () => {
  await assert.rejects(
    runTool(
      'video_frames',
      { video: 'BV1xx411c7mD', times: Array.from({ length: 13 }, (_, index) => index) },
      {},
    ),
    /frames 模式最多 12 个时间点/,
  );
});

test('video_frames function also enforces the frames times cap', async () => {
  await assert.rejects(
    videoFrames({}, { bvid: 'BV1xx411c7mD', times: Array.from({ length: 13 }, (_, index) => index) }),
    /frames 模式最多 12 个时间点/,
  );
});

test('send_message dry-run validates without requiring CSRF', async () => {
  let csrfCalls = 0;
  const fake = {
    uid: '100',
    requireLogin() {},
    requireCsrf() {
      csrfCalls += 1;
      throw new Error('csrf should not be called during dry-run');
    },
  };
  const result = await sendMessage(fake, { receiverId: '200', text: 'hello' });
  assert.equal(csrfCalls, 0);
  assert.equal(result.dry_run, true);
  assert.equal(result.action, 'send_message');
  assert.equal(result.details.receiver_id, '200');
});

test('send_danmaku validates colour before touching the network', async () => {
  const fake = { requireLogin() {} };
  await assert.rejects(
    sendDanmaku(fake, { bvid: 'BV1xx411c7mD', text: 'hi', color: 0x1000000 }),
    /颜色/,
  );
});

test('nested reply author lookup paginates beyond the first page', async () => {
  const firstPage = Array.from({ length: 49 }, (_, index) => ({
    rpid_str: String(1000 + index),
    member: { uname: `u${index}` },
  }));
  const fake = {
    get: async (_url, params) => {
      if (params.pn === 1) {
        return {
          data: {
            root: { member: { uname: 'root' } },
            replies: firstPage,
            page: { count: 60 },
          },
        };
      }
      return {
        data: {
          root: { member: { uname: 'root' } },
          replies: [{ rpid_str: '9999', member: { uname: 'target' } }],
          page: { count: 60 },
        },
      };
    },
  };
  assert.equal(
    await replyAuthorName(fake, { oid: '1', type: 1, root: '1', parent: '9999' }),
    'target',
  );
  assert.equal(
    await replyAuthorName(fake, { oid: '1', type: 1, root: '1', parent: '1' }),
    'root',
  );
  assert.equal(
    await replyAuthorName(fake, { oid: '1', type: 1, root: '1', parent: 'missing' }),
    '',
  );
});

test('favorite folder edits read a fresh folder snapshot', async () => {
  const calls = [];
  const fake = {
    uid: '42',
    requireLogin() {},
    get: async (url, params, options) => {
      calls.push({ url, params, options });
      return {
        data: {
          list: [{ id: '7', title: 'old', intro: 'old intro', attr: 0, media_count: 2 }],
        },
      };
    },
  };
  const result = await editFavoriteFolder(fake, { folderId: '7', title: 'new' });
  assert.equal(result.dry_run, true);
  assert.equal(result.details.current_title, 'old');
  assert.equal(result.details.next_title, 'new');
  assert.equal(calls.length, 1);
  assert.equal(calls[0].options.cacheTtl, 0);
});

test('image comments are blocked before any API call', async () => {
  const fake = { requireLogin() {} };
  await assert.rejects(
    postComment(fake, {
      bvid: 'BV1img000001',
      message: '喵',
      imagePaths: ['C:/tmp/7.png'],
      confirm: false,
    }),
    (error) => error.code === -400 && /post-image-comment-browser\.js/.test(error.hint || ''),
  );
});

test('search min_play filters low-view results', async () => {
  const fake = {
    getSigned: async () => ({
      data: {
        page: 1,
        numResults: 2,
        result: [
          { bvid: 'BV1a', title: 'zero', play: 0, author: 'a', mid: 1 },
          { bvid: 'BV1b', title: 'popular', play: 5000, author: 'b', mid: 2 },
        ],
      },
    }),
  };
  const result = await search(fake, { keyword: 'x', minPlay: 1000 });
  assert.equal(result.filtered, 1);
  assert.equal(result.items.length, 1);
  assert.equal(result.items[0].play, 5000);
});

test('reply notifications expose comment rpids', async () => {
  const fake = {
    get: async () => ({
      data: {
        cursor: { is_end: true },
        items: [{
          id: '9001',
          user: { mid: 1, nickname: 'x' },
          item: {
            source_id: 265141324256,
            root_id: 265141324000,
            target_id: 0,
            business_id: 17,
            subject_id: 1073543151725051,
            type: 'reply',
            uri: 'https://www.bilibili.com/opus/1073543151725051921#reply265141324256',
          },
        }],
      },
    }),
  };
  const result = await replyNotifications(fake, { page: 1, ps: 1 });
  assert.equal(result.read_side_effect, true);
  assert.match(result.read_note, /已读/);
  assert.equal(result.items[0].source.rpid, '265141324256');
  assert.equal(result.items[0].source.root_rpid, '265141324000');
  assert.equal(result.items[0].source.target_rpid, null);
  assert.equal(result.items[0].source.subject_id, '1073543151725051');
});

test('H5 popular enriches owner/view and advances by a full bucket', async () => {
  const calls = [];
  const fake = {
    get: async (url, params) => {
      calls.push({ url, params });
      return {
        data: {
          0: {
            bvid: 'BV1h5popular1',
            param: '117498947046682',
            title: 'H5 card',
            cover: '//i0.hdslb.com/test.jpg',
            right_desc_1: '三颗门牙X',
            right_desc_2: '30.2万观看 · 2天前',
          },
        },
      };
    },
  };
  const result = await popularList(fake, { feed: 'h5', page: 2, ps: 1, includeTags: false });
  assert.equal(calls[0].params.idx, 10);
  assert.equal(result.next_idx, 20);
  assert.equal(result.page, 2);
  assert.equal(result.items[0].owner.name, '三颗门牙X');
  assert.equal(result.items[0].stat.view, 302000);
});

test('b23 short links resolve to a video reference and refuse foreign redirects', async () => {
  const fetchImpl = async () => ({
    status: 302,
    headers: new Map([['location', 'https://www.bilibili.com/video/BV1xx411c7mD?share=1']]),
  });
  assert.deepEqual(await resolveShortVideoRef('https://b23.tv/abc', { fetchImpl }), {
    bvid: 'BV1xx411c7mD',
    aid: null,
  });
  assert.equal(await resolveShortVideoRef('https://example.com/video', { fetchImpl }), null);
  let calls = 0;
  const evilFetch = async () => {
    calls += 1;
    return {
      status: 302,
      headers: new Map([['location', 'https://evil.example/steal']]),
    };
  };
  assert.equal(await resolveShortVideoRef('https://b23.tv/evil', { fetchImpl: evilFetch }), null);
  assert.equal(calls, 1);
});

test('buffer responses with JSON errors throw instead of returning bytes', async () => {
  const original = globalThis.fetch;
  globalThis.fetch = async () => new Response(JSON.stringify({ code: -352, message: 'risk' }), {
    status: 200,
    headers: { 'content-type': 'application/json' },
  });
  try {
    const client = new BiliClient({ cookieHeader: 'SESSDATA=x; DedeUserID=1; buvid3=b' });
    await assert.rejects(
      client.request('https://api.bilibili.com/x/test', {
        method: 'GET',
        responseType: 'buffer',
        retry: 0,
      }),
      (error) => error.code === -352,
    );
  } finally {
    globalThis.fetch = original;
  }
});

test('favorite_video falls back to folder_id when folder_ids is empty', async () => {
  const fake = {
    uid: '42',
    requireLogin() {},
    get: async (url) => {
      if (url.endsWith('/x/web-interface/view')) {
        return {
          data: {
            bvid: 'BV1fav000001',
            aid: 1,
            cid: 2,
            title: 'test',
            owner: { mid: 9, name: 'UP' },
            pages: [{ page: 1, cid: 2, part: 'p1', duration: 60 }],
          },
        };
      }
      if (url.endsWith('/x/web-interface/archive/relation')) {
        return { data: { favorite: false, like: false, coin: 0 } };
      }
      throw new Error(`unexpected call: ${url}`);
    },
  };
  const result = await favoriteVideo(fake, {
    bvid: 'BV1fav000001',
    folderIds: [],
    folderId: '77',
    confirm: false,
  });
  assert.equal(result.dry_run, true);
  assert.deepEqual(result.details.folder_ids, ['77']);
});

const fakeVideoView = {
  data: {
    bvid: 'BV1xx411c7mD',
    aid: 123,
    cid: 456,
    title: 'test',
    duration: 60,
    owner: { mid: 9, name: 'UP' },
    pages: [{ page: 1, cid: 456, part: 'p1', duration: 60 }],
  },
};

const fakeWbiComments = {
  data: {
    cursor: { is_end: true, all_count: 2, pagination_reply: { next_offset: 'next' } },
    replies: [
      { rpid_str: '1', member: { mid: 9, uname: 'UP' }, content: { message: 'hi' }, state: 0 },
      { rpid_str: 'top', member: { mid: 9, uname: 'UP' }, content: { message: 'pinned again' }, state: 0 },
    ],
    top_replies: [
      { rpid_str: 'top', member: { mid: 9, uname: 'UP' }, content: { message: 'pinned' }, state: 0 },
    ],
  },
};

test('protobuf danmaku segments and metadata decode', () => {
  const varint = (value) => {
    let n = BigInt(value);
    const bytes = [];
    do {
      let byte = Number(n & 0x7fn);
      n >>= 7n;
      if (n > 0n) byte |= 0x80;
      bytes.push(byte);
    } while (n > 0n);
    return Buffer.from(bytes);
  };
  const fieldVarint = (field, value) => Buffer.concat([varint((field << 3) | 0), varint(value)]);
  const fieldBytes = (field, buffer) => Buffer.concat([
    varint((field << 3) | 2),
    varint(buffer.length),
    buffer,
  ]);
  const elem = Buffer.concat([
    fieldVarint(1, 123456789n),
    fieldVarint(2, 15000),
    fieldVarint(3, 1),
    fieldVarint(4, 25),
    fieldVarint(5, 16777215),
    fieldBytes(6, Buffer.from('abc')),
    fieldBytes(7, Buffer.from('hello')),
    fieldVarint(8, 1700000000),
    fieldVarint(9, 5),
    fieldVarint(11, 0),
    fieldBytes(12, Buffer.from('123456789')),
    fieldVarint(13, 1),
  ]);
  const boundary = Buffer.concat([
    fieldVarint(1, 123456790n),
    fieldVarint(2, 59960),
    fieldVarint(3, 1),
    fieldVarint(4, 25),
    fieldVarint(5, 16777215),
    fieldBytes(6, Buffer.from('abc')),
    fieldBytes(7, Buffer.from('boundary')),
    fieldVarint(8, 1700000000),
    fieldVarint(9, 5),
    fieldVarint(11, 0),
  ]);
  const segment = Buffer.concat([fieldBytes(1, elem), fieldBytes(1, boundary)]);
  const items = decodeDanmakuSeg(segment);
  assert.equal(items.length, 2);
  assert.equal(items[0].dmid, '123456789');
  assert.equal(items[0].progress, 15);
  assert.equal(items[0].time_text, '0:15.0');
  assert.equal(items[1].progress, 59.96);
  assert.equal(items[1].time_text, '1:00.0');
  assert.equal(items[0].text, 'hello');
  assert.equal(items[0].color, 16777215);
  assert.equal(items[0].mode, 1);
  assert.equal(items[0].pool, 0);
  assert.equal(items[0].attr, 1);

  const segConfig = Buffer.concat([fieldVarint(1, 360000), fieldVarint(2, 3)]);
  const view = Buffer.concat([
    fieldVarint(1, 0),
    fieldBytes(4, segConfig),
    fieldVarint(8, 42),
  ]);
  assert.deepEqual(decodeDanmakuView(view), {
    state: 0,
    count: 42,
    pageSize: 360000,
    total: 3,
  });
});

test('recall_danmaku uses the current v2 recall endpoint', async () => {
  const calls = [];
  const fake = {
    requireLogin() {},
    requireCsrf() {},
    csrf: 'csrf-token',
    get: async () => ({
      data: { bvid: 'BV1recall001', aid: 1, cid: 2, title: 'test', owner: { mid: 9, name: 'UP' } },
    }),
    postForm: async (url, form) => {
      calls.push({ url, form });
      return { code: 0, message: 'OK' };
    },
  };
  const preview = await recallDanmaku(fake, { bvid: 'BV1recall001', dmid: '9' });
  assert.equal(preview.dry_run, true);
  const result = await recallDanmaku(fake, { bvid: 'BV1recall001', dmid: '9', confirm: true });
  assert.equal(result.ok, true);
  assert.equal(calls[0].url, 'https://api.bilibili.com/x/v2/dm/recall');
  assert.deepEqual(calls[0].form, { dmid: '9', cid: '2', type: 1, csrf: 'csrf-token' });
});

test('delete_favorite_folder falls back to folder_id when folder_ids is empty', async () => {
  const fake = {
    uid: '42',
    requireLogin() {},
    get: async () => ({
      data: { list: [{ id: '7', title: 'folder', media_count: 1, attr: 0 }] },
    }),
  };
  const result = await deleteFavoriteFolder(fake, {
    folderIds: [],
    folderId: '7',
    confirm: false,
  });
  assert.equal(result.dry_run, true);
  assert.deepEqual(result.details.folder_ids, ['7']);
  assert.deepEqual(result.details.folders, [{ id: '7', title: 'folder', count: 1 }]);
});

test('post_dynamic video share sends scene 5 and web_repost_src', async () => {
  const calls = [];
  const fake = {
    uid: '42',
    csrf: 'csrf-token',
    requireLogin() {},
    requireCsrf() {},
    clearCache() {},
    get: async () => ({
      data: { bvid: 'BV1share0001', aid: 123, cid: 456, title: 'video', owner: { mid: 9, name: 'UP' } },
    }),
    postJson: async (url, body, options) => {
      calls.push({ url, body, options });
      return { code: 0, message: 'OK', data: { dyn_id_str: '999', dyn_type: 1 } };
    },
  };
  const result = await postDynamic(fake, {
    video: 'BV1share0001',
    text: 'share text',
    confirm: true,
  });
  assert.equal(result.ok, true);
  assert.equal(result.action, 'share_video_dynamic');
  assert.equal(result.dynamic_id, '999');
  assert.equal(calls[0].body.dyn_req.scene, 5);
  assert.deepEqual(calls[0].body.web_repost_src.revs_id, { dyn_type: 8, rid: 123 });
  assert.equal(calls[0].body.dyn_req.content.contents[0].raw_text, 'share text');
});

test('video comments use the WBI cursor endpoint', async () => {
  const getCalls = [];
  const fake = {
    get: async (url) => {
      getCalls.push(url);
      if (url.endsWith('/x/web-interface/view')) return fakeVideoView;
      throw new Error(`unexpected legacy call: ${url}`);
    },
    getSigned: async (url) => {
      if (url.endsWith('/x/v2/reply/wbi/main')) return fakeWbiComments;
      throw new Error(`unexpected endpoint: ${url}`);
    },
    clearCache() {},
  };
  const result = await listComments(fake, { bvid: 'BV1xx411c7mD', ps: 5 });
  assert.equal(result.source, 'x/v2/reply/wbi/main');
  assert.equal(result.page_size, 20);
  assert.equal(getCalls.some((url) => url.endsWith('/x/v2/reply')), false);
  assert.equal(result.replies.length, 1);
  assert.equal(result.replies[0].is_up, true);
  assert.equal(result.replies[0].is_top, false);
  assert.equal(result.replies.some((reply) => reply.rpid === 'top'), false);
  assert.equal(result.top_replies.length, 1);
  assert.equal(result.top_replies[0].is_top, true);
  assert.equal(result.total, 2);
});
