#!/usr/bin/env node
import process from 'node:process';
import { resolveBootstrapCookies } from '../src/core/config.mjs';
import { BiliClient } from '../src/core/http.mjs';
import { authStatus } from '../src/api/account.mjs';
import { popularList, preciousList, rankList, weeklyIssues, weeklyList } from '../src/api/rankings.mjs';
import { relatedVideos, search, toviewList, userInfo, userVideos, videoComments, videoInfo, watchHistory } from '../src/api/videos.mjs';
import { getTranscript } from '../src/media/subtitles.mjs';
import { videoFrames } from '../src/media/frames.mjs';
import { listFavoriteFolders, listFavorites } from '../src/api/favorites.mjs';
import { listFollowers, listFollowings } from '../src/api/relations.mjs';
import { likeNotifications, replyNotifications, unreadNotifications } from '../src/api/notifications.mjs';
import { fetchSessionMessages, listSessions } from '../src/api/messages.mjs';
import { dynamicFeed } from '../src/api/dynamics.mjs';

const bvid = process.env.BILI_TEST_BVID || '';
const bootstrap = await resolveBootstrapCookies();
const client = new BiliClient({ cookieHeader: bootstrap.cookieHeader });
const results = [];

async function check(name, fn) {
  const started = Date.now();
  try {
    const detail = await fn();
    results.push({ name, ok: true, ms: Date.now() - started, detail });
    process.stdout.write(`✔ ${name} (${Date.now() - started}ms) ${detail || ''}\n`);
  } catch (error) {
    results.push({ name, ok: false, ms: Date.now() - started, error: error.message, hint: error.hint });
    process.stdout.write(`✘ ${name} (${Date.now() - started}ms) ${error.message}\n`);
  }
}

process.stdout.write(`cookie source: ${bootstrap.source}\n`);
await check('auth_status', async () => {
  const status = await authStatus(client);
  if (!status.is_login) throw new Error('未登录；请先用 bilibili-login skill 写入 Cookie');
  return `${status.uname} (${status.mid}) coins=${status.coins}`;
});
await check('rank_list', async () => {
  const result = await rankList(client, { limit: 3, includeTags: false });
  return `${result.returned}/${result.total}`;
});
await check('popular_list', async () => {
  const result = await popularList(client, { ps: 5, includeTags: false });
  return `${result.returned} items`;
});
await check('weekly_issues', async () => {
  const result = await weeklyIssues(client, { limit: 2 });
  return `latest=${result.items[0]?.number}`;
});
await check('weekly_list', async () => {
  const result = await weeklyList(client, { limit: 3, tagLimit: 1 });
  return `${result.number} ${result.subject} ${result.returned} items`;
});
await check('precious_list', async () => {
  const result = await preciousList(client, { limit: 2, includeTags: false });
  return `${result.returned} items`;
});
await check('video_info', async () => {
  if (!bvid) return 'skipped (set BILI_TEST_BVID)';
  const result = await videoInfo(client, { bvid });
  return `${result.title} tags=${result.tags.length}`;
});
await check('video_transcript', async () => {
  if (!bvid) return 'skipped (set BILI_TEST_BVID)';
  const result = await getTranscript(client, { bvid });
  if (!result.has_subtitle) throw new Error('该测试视频无字幕');
  return `${result.lang} ${result.char_count} chars / ${result.segments.length} segments`;
});
await check('video_transcript_en', async () => {
  if (!bvid) return 'skipped (set BILI_TEST_BVID)';
  const result = await getTranscript(client, { bvid, lang: 'ai-en' });
  if (!result.has_subtitle || result.lang !== 'ai-en') throw new Error(`英文轨未生效：${result.lang}`);
  return `${result.lang} ${result.char_count} chars`;
});
await check('video_frames', async () => {
  if (!bvid) return 'skipped (set BILI_TEST_BVID)';
  const result = await videoFrames(client, { bvid, times: ['10%', '50%'], count: 1, width: 480 });
  if (result.frames.length !== 2) throw new Error(`显式 times 应返回 2 帧，实际 ${result.frames.length}`);
  return `${result.source} ${result.frames.length} frame(s) ${result.frames[0]?.file}`;
});
await check('video_comments', async () => {
  if (!bvid) return 'skipped (set BILI_TEST_BVID)';
  const result = await videoComments(client, { bvid, ps: 3, sort: 'time' });
  return `${result.total} comments`;
});
await check('related_videos', async () => {
  if (!bvid) return 'skipped (set BILI_TEST_BVID)';
  const result = await relatedVideos(client, { bvid, limit: 2 });
  return `${result.items.length} related`;
});
await check('toview', async () => {
  const result = await toviewList(client, { ps: 2 });
  return `${result.items.length}/${result.count}`;
});
await check('search', async () => {
  const result = await search(client, { keyword: 'DeepSeek', limit: 3 });
  return `${result.items.length} results`;
});
await check('search_user', async () => {
  const result = await search(client, { keyword: 'DeepSeek', type: 'user', limit: 2 });
  return `${result.items.length} users`;
});
await check('user_info', async () => {
  const result = await userInfo(client, { mid: client.uid });
  return `${result.name} fans=${result.fans}`;
});
await check('list_followings', async () => {
  const result = await listFollowings(client, { ps: 2 });
  return `total=${result.total}`;
});
await check('list_followers', async () => {
  const result = await listFollowers(client, { ps: 2 });
  return `total=${result.total}`;
});
await check('user_videos', async () => {
  const result = await userVideos(client, { mid: client.uid, limit: 2 });
  return `${result.items.length}/${result.total}`;
});
await check('favorite_folders', async () => {
  const result = await listFavoriteFolders(client);
  return `${result.total} folders`;
});
await check('favorite_items', async () => {
  const folders = await listFavoriteFolders(client);
  if (!folders.items[0]) throw new Error('没有收藏夹');
  const result = await listFavorites(client, { folderId: folders.items[0].id, ps: 2 });
  return `${folders.items[0].title} total=${result.total}`;
});
await check('notifications', async () => {
  const unread = await unreadNotifications(client);
  await replyNotifications(client, { ps: 1 });
  return `replies=${unread.replies} ats=${unread.ats}`;
});
await check('notifications_like', async () => {
  const result = await likeNotifications(client, { ps: 1 });
  return `${result.total.items.length} recent like groups`;
});
await check('messages', async () => {
  const sessions = await listSessions(client, { limit: 3 });
  if (sessions.items[0]?.talker_id) {
    const thread = await fetchSessionMessages(client, { talkerId: sessions.items[0].talker_id, limit: 3 });
    return `${sessions.items.length} sessions, ${thread.messages.length} messages`;
  }
  return `${sessions.items.length} sessions`;
});
await check('dynamic_feed', async () => {
  const result = await dynamicFeed(client, { page: 1 });
  return `${result.items.length} items, next_offset=${result.next_offset}`;
});
await check('history', async () => {
  const result = await watchHistory(client, { ps: 2 });
  return `${result.items.length} items`;
});

const failed = results.filter((result) => !result.ok);
process.stdout.write(`\n${results.length - failed.length}/${results.length} checks passed\n`);
if (failed.length) {
  process.stdout.write(`${JSON.stringify(failed, null, 2)}\n`);
  process.exitCode = 1;
}
