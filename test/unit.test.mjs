import test from 'node:test';
import assert from 'node:assert/strict';
import { buildQuery, extractWbiKeys, getMixinKey, signParams } from '../src/core/wbi.mjs';
import { normalizeCookieObjects, parseCookieHeader, serializeCookies, missingLoginCookies } from '../src/core/cookies.mjs';
import { normalizeDynamic } from '../src/api/dynamics.mjs';
import { parseMessageContent } from '../src/api/messages.mjs';
import { normalizeVideo, parseVideoRef, resolveFrameTimes, formatDuration } from '../src/core/format.mjs';
import { selectVideoStream } from '../src/media/playurl.mjs';
import { choosePage } from '../src/api/videos.mjs';
import { toolMap, validateToolArgs } from '../src/tools/index.mjs';
import { normalizeReply, resolveCommentTarget } from '../src/api/comments.mjs';

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
  assert.equal(reply.replies[0].state, 17);
  assert.equal(reply.replies[0].is_up, false);
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
