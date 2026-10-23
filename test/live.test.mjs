import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { resolveBootstrapCookies } from '../src/core/config.mjs';
import { BiliClient } from '../src/core/http.mjs';
import { authStatus } from '../src/api/account.mjs';
import { popularList, rankList, weeklyIssues, weeklyList } from '../src/api/rankings.mjs';
import {
  search,
  userInfo,
  videoInfo,
  watchHistory,
} from '../src/api/videos.mjs';
import { getTranscript } from '../src/media/subtitles.mjs';
import { videoFrames } from '../src/media/frames.mjs';
import { listComments } from '../src/api/comments.mjs';
import { listFavoriteFolders, listFavorites } from '../src/api/favorites.mjs';
import { listFollowings } from '../src/api/relations.mjs';
import {
  atNotifications,
  replyNotifications,
  unreadNotifications,
} from '../src/api/notifications.mjs';
import { fetchSessionMessages, listSessions } from '../src/api/messages.mjs';
import { dynamicFeed } from '../src/api/dynamics.mjs';
import { likeVideo } from '../src/api/actions.mjs';
import { findFfmpeg } from '../src/media/ffmpeg.mjs';

const live = Boolean(process.env.BILI_LIVE_TEST);
const write = Boolean(process.env.BILI_LIVE_WRITE);
const bvid = process.env.BILI_TEST_BVID || '';

async function client() {
  const bootstrap = await resolveBootstrapCookies();
  return new BiliClient({ cookieHeader: bootstrap.cookieHeader });
}

test('live: login and account', { skip: !live }, async () => {
  const c = await client();
  const status = await authStatus(c);
  assert.equal(status.is_login, true, 'BILI_COOKIE / cookies.json must contain a valid login');
  assert.ok(status.mid);
});

test('live: rankings, popular, weekly', { skip: !live }, async () => {
  const c = await client();
  const rank = await rankList(c, { limit: 3, includeTags: false });
  assert.equal(rank.returned, 3);
  assert.equal(rank.items.length, 3);
  assert.ok(rank.items[0].bvid);
  assert.ok(rank.items[0].url.startsWith('https://www.bilibili.com/video/'));
  const popular = await popularList(c, { ps: 5, includeTags: false });
  assert.ok(popular.items.length > 0);
  const issues = await weeklyIssues(c, { limit: 2 });
  assert.ok(issues.items.length > 0);
  const weekly = await weeklyList(c, { number: issues.items[0].number, limit: 3, includeTags: true, tagLimit: 1 });
  assert.equal(weekly.number, issues.items[0].number);
  assert.ok(weekly.items.length > 0);
  assert.ok(weekly.subject);
});

test('live: video info, tags, subtitle and comments', { skip: !live || !bvid }, async () => {
  const c = await client();
  const info = await videoInfo(c, { bvid });
  assert.equal(info.bvid, bvid);
  assert.ok(info.title);
  assert.ok(info.tags.length > 0);
  const transcript = await getTranscript(c, { bvid });
  assert.equal(transcript.has_subtitle, true, 'test video should have an AI subtitle');
  assert.ok(transcript.text.length > 20);
  assert.ok(transcript.segments.length > 0);
  const comments = await listComments(c, { bvid, ps: 3 });
  assert.ok(comments.total > 0);
});

test('live: frame extraction', { skip: !live || !bvid || !findFfmpeg() }, async () => {
  const c = await client();
  const result = await videoFrames(c, { bvid, count: 1, width: 480 });
  assert.ok(result.frames.length >= 1);
  const stat = await fs.stat(result.frames[0].file);
  assert.ok(stat.size > 1000);
  assert.ok(path.isAbsolute(result.frames[0].file));
});

test('live: search and user', { skip: !live }, async () => {
  const c = await client();
  const result = await search(c, { keyword: 'DeepSeek', limit: 3 });
  assert.ok(result.items.length > 0);
  const user = await userInfo(c, { mid: c.uid });
  assert.ok(user.name);
});

test('live: relations, favorites, notifications, messages, dynamics, history', { skip: !live }, async () => {
  const c = await client();
  const followings = await listFollowings(c, { ps: 2 });
  assert.ok(followings.total > 0);
  const folders = await listFavoriteFolders(c);
  assert.ok(folders.items.length > 0);
  const favorites = await listFavorites(c, { folderId: folders.items[0].id, ps: 2 });
  assert.ok(Array.isArray(favorites.items));
  const unread = await unreadNotifications(c);
  assert.ok(typeof unread.replies === 'number');
  await replyNotifications(c, { ps: 1 });
  await atNotifications(c, { ps: 1 });
  const sessions = await listSessions(c, { limit: 2 });
  assert.ok(Array.isArray(sessions.items));
  if (sessions.items[0]?.talker_id) {
    const thread = await fetchSessionMessages(c, { talkerId: sessions.items[0].talker_id, limit: 3 });
    assert.ok(Array.isArray(thread.messages));
  }
  const feed = await dynamicFeed(c, { page: 1 });
  assert.ok(feed.items.length > 0);
  assert.ok(feed.next_offset);
  const feedPage2 = await dynamicFeed(c, { page: 2 });
  assert.ok(feedPage2.items.length > 0);
  assert.notEqual(feed.items[0]?.id, feedPage2.items[0]?.id);
  const feedViaOffset = await dynamicFeed(c, { offset: feed.next_offset });
  assert.equal(feedViaOffset.items[0]?.id, feedPage2.items[0]?.id);
  await watchHistory(c, { ps: 2 });
});

test('live: reversible like/unlike', { skip: !live || !write || !bvid }, async () => {
  const c = await client();
  const liked = await likeVideo(c, { bvid, like: true, confirm: true });
  assert.equal(liked.ok, true);
  const unliked = await likeVideo(c, { bvid, like: false, confirm: true });
  assert.equal(unliked.ok, true);
});
