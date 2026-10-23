import { safeArray, toHttps, truncate } from '../core/format.mjs';
import { BiliError } from '../core/errors.mjs';

function normalizeAuthor(author) {
  if (!author) return null;
  return {
    mid: author.mid ? String(author.mid) : '',
    name: author.name || '',
    face: toHttps(author.face || ''),
    pub_ts: Number(author.pub_ts) || 0,
    pub_time: author.pub_time || '',
    pub_action: author.pub_action || '',
    following: Boolean(author.following),
  };
}

function normalizeStat(stat) {
  if (!stat) return null;
  return {
    forward: stat.forward?.count ?? 0,
    comment: stat.comment?.count ?? 0,
    like: stat.like?.count ?? 0,
  };
}

function normalizeArchive(archive) {
  if (!archive) return null;
  const bvid = archive.bvid || '';
  return {
    bvid,
    aid: archive.aid ? String(archive.aid) : '',
    title: archive.title || '',
    url: archive.jump_url
      ? archive.jump_url.startsWith('//')
        ? `https:${archive.jump_url}`
        : archive.jump_url
      : bvid
        ? `https://www.bilibili.com/video/${bvid}`
        : '',
    cover: toHttps(archive.cover || ''),
    duration_text: archive.duration_text || '',
    desc: truncate(archive.desc || '', 200),
    play: Number(archive.stat?.play) || 0,
    danmaku: Number(archive.stat?.danmaku) || 0,
  };
}

function normalizePics(major) {
  const drawItems = safeArray(major?.draw?.items);
  const opusPics = safeArray(major?.opus?.pics);
  const pics = drawItems.length ? drawItems : opusPics;
  return pics.map((pic) => ({
    url: toHttps(pic.src || pic.url || ''),
    width: pic.width ?? null,
    height: pic.height ?? null,
  }));
}

export function normalizeDynamic(item) {
  if (!item) return null;
  const author = normalizeAuthor(item.modules?.module_author);
  const dynamic = item.modules?.module_dynamic || {};
  const major = dynamic.major || {};
  const archive = normalizeArchive(major.archive);
  const pics = normalizePics(major);
  const text =
    dynamic.desc?.text ||
    major.opus?.summary?.text ||
    major.article?.desc ||
    major.live?.title ||
    archive?.title ||
    '';
  const id = String(item.id_str || '');
  return {
    id,
    type: item.type || '',
    url: id ? `https://t.bilibili.com/${id}` : '',
    author,
    text: truncate(text, 1000),
    pics,
    video: archive,
    article: major.article
      ? {
          title: major.article.title || '',
          url: major.article.jump_url || '',
          cover: toHttps(safeArray(major.article.covers)[0] || ''),
        }
      : null,
    live: major.live
      ? {
          title: major.live.title || '',
          cover: toHttps(major.live.cover || ''),
          url: major.live.jump_url || '',
        }
      : null,
    stat: normalizeStat(item.modules?.module_stat),
    visible: item.visible !== false,
    is_forward: item.type === 'DYNAMIC_TYPE_FORWARD',
    tag: item.modules?.module_tag?.text || '',
    is_top: item.modules?.module_tag?.text === '置顶',
  };
}

export async function getDynamicDetail(client, dynamicId) {
  if (!dynamicId) throw new BiliError('需要动态 ID', { code: -400 });
  const json = await client.get(
    'https://api.bilibili.com/x/polymer/web-dynamic/v1/detail',
    { id: String(dynamicId), features: 'itemOpusStyle' },
    { cacheTtl: 5 * 60_000 },
  );
  const item = json.data?.item;
  if (!item) {
    throw new BiliError('无法获取动态详情（可能已删除或不可见）', {
      code: json.code,
      endpoint: '/x/polymer/web-dynamic/v1/detail',
      details: json,
    });
  }
  return item;
}

const FEED_CACHE_TTL = 2 * 60_000;
const feedCursors = new Map();

function getFeedCursor(type) {
  const cached = feedCursors.get(type);
  if (cached && cached.expiresAt > Date.now()) return cached;
  const fresh = { offsets: [''], expiresAt: Date.now() + FEED_CACHE_TTL };
  feedCursors.set(type, fresh);
  return fresh;
}

async function requestFeed(client, type, offset) {
  return client.get(
    'https://api.bilibili.com/x/polymer/web-dynamic/v1/feed/all',
    { type, offset: offset || '', features: 'itemOpusStyle' },
    { cacheTtl: 15_000 },
  );
}

function formatFeed(json, { type, page = null, offset = '' } = {}) {
  const items = safeArray(json.data?.items);
  return {
    type,
    page,
    offset: offset || '',
    next_offset: json.data?.offset || null,
    has_more: Boolean(json.data?.has_more),
    update_num: json.data?.update_num || 0,
    count: items.length,
    items: items.map(normalizeDynamic),
  };
}

export function resetDynamicFeedCursors() {
  feedCursors.clear();
  spaceFeedCursors.clear();
}

export async function dynamicFeed(client, { page = 1, offset, type = 'all' } = {}) {
  const feedType = type || 'all';
  const explicitOffset = offset !== undefined && offset !== null && String(offset).trim() !== '';
  if (explicitOffset) {
    const json = await requestFeed(client, feedType, String(offset));
    return formatFeed(json, { type: feedType, offset: String(offset) });
  }

  const requestedPage = Math.max(1, Math.min(Math.trunc(Number(page) || 1), 20));
  const cursor = getFeedCursor(feedType);

  // Walk cursors lazily; page 1 is one request, page N adds at most N-1 requests
  // and caches the offsets so subsequent pages are cheap.
  while (cursor.offsets.length <= requestedPage - 1) {
    const currentOffset = cursor.offsets[cursor.offsets.length - 1];
    const json = await requestFeed(client, feedType, currentOffset);
    const next = json.data?.offset;
    if (!next) break;
    cursor.offsets.push(next);
  }

  const targetOffset = cursor.offsets[requestedPage - 1];
  if (targetOffset === undefined) {
    return {
      type: feedType,
      page: requestedPage,
      offset: '',
      next_offset: null,
      has_more: false,
      count: 0,
      items: [],
      hint: '已到动态流末尾，没有更多可翻页内容。',
    };
  }

  const json = await requestFeed(client, feedType, targetOffset);
  const next = json.data?.offset;
  if (next && cursor.offsets[requestedPage] === undefined) {
    cursor.offsets[requestedPage] = next;
  }
  return formatFeed(json, { type: feedType, page: requestedPage, offset: targetOffset });
}

const spaceFeedCursors = new Map();

async function requestSpaceFeed(client, hostMid, offset) {
  return client.getSigned(
    'https://api.bilibili.com/x/polymer/web-dynamic/v1/feed/space',
    {
      host_mid: String(hostMid),
      offset: offset || '',
      timezone_offset: -480,
      platform: 'web',
      features: 'itemOpusStyle,listOnlyfans,opusBigCover,onlyfansVote,forwardListHidden,decorationCard,commentsNewVersion,onlyfansAssetsV2,ugcDelete,onlyfansQaCard,avatarAutoTheme,sunflowerStyle,cardsEnhance,eva3CardOpus,eva3CardVideo,eva3CardComment,eva3CardUser',
    },
    { cacheTtl: 15_000 },
  );
}

function formatSpaceFeed(json, { hostMid, page = null, offset = '' } = {}) {
  const items = safeArray(json.data?.items);
  return {
    host_mid: String(hostMid),
    page,
    offset: offset || '',
    next_offset: json.data?.offset || null,
    has_more: Boolean(json.data?.has_more),
    update_num: Number(json.data?.update_num) || 0,
    count: items.length,
    items: items.map(normalizeDynamic),
  };
}

export async function dynamicDetail(client, { dynamicId } = {}) {
  if (!dynamicId) throw new BiliError('需要动态 ID', { code: -400 });
  const item = await getDynamicDetail(client, dynamicId);
  const dynamic = normalizeDynamic(item);
  if (!dynamic) throw new BiliError('动态不存在或不可见', { code: -404 });
  return dynamic;
}

export async function userDynamics(client, { mid, page = 1, offset } = {}) {
  const hostMid = mid ? String(mid) : client.uid;
  if (!hostMid) throw new BiliError('需要提供 mid，或先登录以读取自己的动态', { code: -400 });
  const explicitOffset = offset !== undefined && offset !== null && String(offset).trim() !== '';
  if (explicitOffset) {
    const json = await requestSpaceFeed(client, hostMid, String(offset));
    return formatSpaceFeed(json, { hostMid, offset: String(offset) });
  }

  const requestedPage = Math.max(1, Math.min(Math.trunc(Number(page) || 1), 20));
  const cursorKey = `space:${hostMid}`;
  let cursor = spaceFeedCursors.get(cursorKey);
  if (!cursor || cursor.expiresAt <= Date.now()) {
    cursor = { offsets: [''], expiresAt: Date.now() + FEED_CACHE_TTL };
    spaceFeedCursors.set(cursorKey, cursor);
  }
  while (cursor.offsets.length <= requestedPage - 1) {
    const currentOffset = cursor.offsets[cursor.offsets.length - 1];
    const json = await requestSpaceFeed(client, hostMid, currentOffset);
    const next = json.data?.offset;
    if (!next) break;
    cursor.offsets.push(next);
  }
  const targetOffset = cursor.offsets[requestedPage - 1];
  if (targetOffset === undefined) {
    return {
      host_mid: hostMid,
      page: requestedPage,
      offset: '',
      next_offset: null,
      has_more: false,
      count: 0,
      items: [],
      hint: '已到该用户动态末尾，没有更多可翻页内容。',
    };
  }
  const json = await requestSpaceFeed(client, hostMid, targetOffset);
  const next = json.data?.offset;
  if (next && cursor.offsets[requestedPage] === undefined) cursor.offsets[requestedPage] = next;
  return formatSpaceFeed(json, { hostMid, page: requestedPage, offset: targetOffset });
}
