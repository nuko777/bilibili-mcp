import { normalizeVideo, safeArray, truncate } from '../core/format.mjs';
import { BiliError } from '../core/errors.mjs';

const RANK_ENDPOINT = 'https://api.bilibili.com/x/web-interface/ranking/v2';
const POPULAR_ENDPOINT = 'https://api.bilibili.com/x/web-interface/popular';
const H5_POPULAR_ENDPOINT = 'https://app.bilibili.com/x/v2/show/popular/index';
const WEEKLY_LIST_ENDPOINT = 'https://api.bilibili.com/x/web-interface/popular/series/list';
const WEEKLY_ONE_ENDPOINT = 'https://api.bilibili.com/x/web-interface/popular/series/one';

const tagCache = new Map();

async function fetchTag(client, bvid) {
  const cached = tagCache.get(bvid);
  if (cached && cached.expiresAt > Date.now()) return { tags: cached.tags, ok: cached.ok !== false };
  try {
    const json = await client.get(
      'https://api.bilibili.com/x/tag/archive/tags',
      { bvid },
      { tagRequest: true, cacheTtl: 10 * 60_000, retry: 1 },
    );
    const tags = safeArray(json.data)
      .map((tag) => tag.tag_name || tag.name)
      .filter(Boolean);
    tagCache.set(bvid, { tags, ok: true, expiresAt: Date.now() + 10 * 60_000 });
    return { tags, ok: true };
  } catch {
    tagCache.set(bvid, { tags: [], ok: false, expiresAt: Date.now() + 60_000 });
    return { tags: [], ok: false };
  }
}

async function mapWithConcurrency(items, concurrency, mapper) {
  const results = new Array(items.length);
  let cursor = 0;
  const workers = Array.from({ length: Math.min(concurrency, items.length) }, async () => {
    while (cursor < items.length) {
      const index = cursor;
      cursor += 1;
      results[index] = await mapper(items[index], index);
    }
  });
  await Promise.all(workers);
  return results;
}

export async function attachTags(client, videos, { tagLimit = 20, concurrency = 2 } = {}) {
  if (!videos.length) return { videos, tags_complete: true };
  const limit = Math.max(0, Math.min(Number(tagLimit) || 0, videos.length));
  if (!limit) return { videos, tags_complete: false };
  const targets = videos.slice(0, limit);
  const results = await mapWithConcurrency(targets, concurrency, (video) => fetchTag(client, video.bvid));
  targets.forEach((video, index) => {
    video.tags = results[index]?.tags || [];
  });
  return { videos, tags_complete: limit >= videos.length && results.every((item) => item.ok) };
}

export async function rankList(client, { rid = 0, type = 'all', limit = 20, includeTags = true, tagLimit = 20 } = {}) {
  const safeLimit = Math.max(1, Math.min(Number(limit) || 20, 100));
  const json = await client.get(RANK_ENDPOINT, { rid, type }, { cacheTtl: 60_000 });
  const all = safeArray(json.data?.list);
  const videos = all.slice(0, safeLimit).map((item) => normalizeVideo(item, 'ranking'));
  let tagsComplete = true;
  if (includeTags) {
    const result = await attachTags(client, videos, { tagLimit: Math.min(tagLimit, videos.length) });
    tagsComplete = result.tags_complete;
  }
  return {
    source: 'ranking',
    rid,
    type,
    note: json.data?.note || '',
    total: all.length,
    returned: videos.length,
    tags_complete: includeTags ? tagsComplete : false,
    tags_included: Boolean(includeTags),
    items: videos,
  };
}

function parseH5ViewCount(text) {
  const match = String(text || '').match(/([\d.]+)\s*([万亿]?)\s*(?:观看|播放)/);
  if (!match) return null;
  const value = Number(match[1]);
  if (!Number.isFinite(value)) return null;
  const unit = match[2] === '亿' ? 100_000_000 : match[2] === '万' ? 10_000 : 1;
  return Math.round(value * unit);
}

function normalizeH5Popular(card) {
  const ownerName = card.owner?.name || card.upper?.name || card.right_desc_1 || '';
  const view = parseH5ViewCount(card.right_desc_2);
  const video = normalizeVideo(
    {
      bvid: card.bvid,
      aid: card.param || card.id,
      title: card.title,
      pic: card.cover,
      duration: card.duration,
      owner: card.owner || card.upper || (ownerName ? { name: ownerName } : undefined),
      stat: card.stat || (view !== null ? { view } : undefined),
      desc: card.desc,
      pubdate: card.pubdate,
      tname: card.tname,
      tid: card.tid,
    },
    'popular_h5',
  );
  // H5 cards only expose the view count in right_desc_2; don't pretend the
  // unavailable metrics are real zeros.
  if (video && !card.stat) video.stat = view !== null ? { view } : null;
  return video;
}

async function h5PopularList(client, { idx = 0, ps = 20, limit, includeTags = true, tagLimit = 20 } = {}) {
  const safeIdx = Math.max(0, Math.trunc(Number(idx) || 0));
  const safePs = Math.max(1, Math.min(Number(ps) || 20, 20));
  const json = await client.get(
    H5_POPULAR_ENDPOINT,
    { mobi_app: 'h5', idx: safeIdx, entrance_id: 0 },
    { cacheTtl: 60_000 },
  );
  const cards = Object.entries(json.data || {})
    .sort(([a], [b]) => Number(a) - Number(b))
    .map(([, card]) => card)
    .filter((card) => card && card.bvid);
  let videos = cards.map(normalizeH5Popular).filter(Boolean).slice(0, safePs);
  if (limit) videos = videos.slice(0, Math.max(1, Number(limit)));
  let tagsComplete = true;
  if (includeTags) {
    const result = await attachTags(client, videos, { tagLimit: Math.min(tagLimit, videos.length) });
    tagsComplete = result.tags_complete;
  }
  return {
    source: 'popular',
    feed: 'h5',
    personalized: false,
    idx: safeIdx,
    // The H5 endpoint repeats the same 10-card bucket for idx=1..10;
    // increment by a whole bucket to avoid duplicate pages.
    next_idx: safeIdx + 10,
    page: Math.floor(safeIdx / 10) + 1,
    ps: safePs,
    no_more: cards.length < 10,
    returned: videos.length,
    tags_complete: includeTags ? tagsComplete : false,
    tags_included: Boolean(includeTags),
    items: videos,
  };
}

export async function popularList(
  client,
  { page = 1, ps = 20, limit, includeTags = true, tagLimit = 20, personalized = false, idx, feed = 'web' } = {},
) {
  const safePage = Math.max(1, Math.trunc(Number(page) || 1));
  const safePs = Math.max(1, Math.min(Number(ps) || 20, 20));
  if (feed === 'h5' && !personalized) {
    return h5PopularList(client, {
      idx: idx === undefined || idx === null ? (safePage - 1) * 10 : idx,
      ps: safePs,
      limit,
      includeTags,
      tagLimit,
    });
  }
  const json = await client.get(POPULAR_ENDPOINT, { pn: safePage, ps: safePs }, { cacheTtl: 60_000 });
  let videos = safeArray(json.data?.list).map((item) => normalizeVideo(item, 'popular'));
  if (limit) videos = videos.slice(0, Math.max(1, Number(limit)));
  let tagsComplete = true;
  if (includeTags) {
    const result = await attachTags(client, videos, { tagLimit: Math.min(tagLimit, videos.length) });
    tagsComplete = result.tags_complete;
  }
  return {
    source: 'popular',
    feed: 'web',
    personalized: Boolean(personalized),
    page: safePage,
    ps: safePs,
    no_more: Boolean(json.data?.no_more),
    returned: videos.length,
    tags_complete: includeTags ? tagsComplete : false,
    tags_included: Boolean(includeTags),
    items: videos,
  };
}

export async function weeklyIssues(client, { limit = 12 } = {}) {
  const json = await client.getSigned(WEEKLY_LIST_ENDPOINT, {}, { cacheTtl: 5 * 60_000 });
  const issues = safeArray(json.data?.list).slice(0, Math.max(1, Math.min(Number(limit) || 12, 50)));
  return {
    source: 'weekly_issues',
    returned: issues.length,
    items: issues.map((issue) => ({
      number: issue.number,
      subject: issue.subject || '',
      name: issue.name || '',
      status: issue.status,
      url: `https://www.bilibili.com/v/popular/weekly?num=${issue.number}`,
    })),
  };
}

export async function weeklyList(
  client,
  { number, limit = 50, includeTags = true, tagLimit = 20 } = {},
) {
  let issueNumber = Number(number);
  if (!Number.isFinite(issueNumber) || issueNumber <= 0) {
    const issues = await weeklyIssues(client, { limit: 1 });
    issueNumber = issues.items[0]?.number;
    if (!issueNumber) throw new BiliError('无法获取每周必看期数', { endpoint: WEEKLY_LIST_ENDPOINT });
  }
  const json = await client.getSigned(WEEKLY_ONE_ENDPOINT, { number: issueNumber }, { cacheTtl: 5 * 60_000 });
  let issue = null;
  try {
    const issues = await weeklyIssues(client, { limit: 50 });
    issue = issues.items.find((item) => Number(item.number) === Number(issueNumber)) || null;
  } catch {
    issue = null;
  }
  const all = safeArray(json.data?.list);
  const videos = all.slice(0, Math.max(1, Math.min(Number(limit) || 50, 100))).map((item) => normalizeVideo(item, 'weekly'));
  let tagsComplete = true;
  if (includeTags) {
    const result = await attachTags(client, videos, { tagLimit: Math.min(tagLimit, videos.length) });
    tagsComplete = result.tags_complete;
  }
  return {
    source: 'weekly',
    number: issueNumber,
    subject: truncate(json.data?.subject || issue?.subject || '', 200),
    name: issue?.name || '',
    label: json.data?.label || '',
    share_url: json.data?.share_url || '',
    returned: videos.length,
    tags_complete: includeTags ? tagsComplete : false,
    tags_included: Boolean(includeTags),
    items: videos,
  };
}

export async function preciousList(client, { limit = 20, includeTags = true, tagLimit = 20 } = {}) {
  const json = await client.get('https://api.bilibili.com/x/web-interface/popular/precious', {}, { cacheTtl: 5 * 60_000 });
  const all = safeArray(json.data?.list);
  const videos = all.slice(0, Math.max(1, Math.min(Number(limit) || 20, 100))).map((item) => normalizeVideo(item, 'precious'));
  let tagsComplete = true;
  if (includeTags) {
    const result = await attachTags(client, videos, { tagLimit: Math.min(tagLimit, videos.length) });
    tagsComplete = result.tags_complete;
  }
  return {
    source: 'precious',
    returned: videos.length,
    tags_complete: includeTags ? tagsComplete : false,
    tags_included: Boolean(includeTags),
    items: videos,
  };
}
