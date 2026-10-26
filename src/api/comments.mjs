import { BiliError } from '../core/errors.mjs';
import { safeArray, toHttps } from '../core/format.mjs';
import { getDynamicDetail, normalizeDynamic } from './dynamics.mjs';
import { getView } from './videos.mjs';

const COMMENT_PAGE_SIZE = 20;
const MAX_COMMENT_PAGE = 20;
const COMMENT_CACHE_TTL = 2 * 60_000;
const commentCursors = new Map();

function normalizePictures(content) {
  return safeArray(content?.pictures).map((pic) => ({
    url: toHttps(pic.img_src || pic.url || ''),
    width: Number(pic.img_width || pic.width) || 0,
    height: Number(pic.img_height || pic.height) || 0,
    size: Number(pic.img_size || pic.size) || 0,
  })).filter((pic) => pic.url);
}

function normalizeMember(member) {
  if (!member) return null;
  return {
    mid: String(member.mid || ''),
    name: member.uname || '',
    avatar: toHttps(member.avatar || ''),
  };
}

export function normalizeReply(reply, { ownerMid = '', isTop = false } = {}) {
  if (!reply) return null;
  const childReplies = safeArray(reply.replies).map((child) => ({
    rpid: String(child.rpid_str || child.rpid || ''),
    user: child.member?.uname || '',
    mid: String(child.member?.mid || ''),
    message: child.content?.message || '',
    like: Number(child.like) || 0,
    ctime: child.ctime || 0,
    state: child.state ?? null,
    is_up: Boolean(ownerMid && String(child.member?.mid || '') === String(ownerMid)),
    pictures: normalizePictures(child.content),
    mentions: safeArray(child.content?.members).map(normalizeMember).filter(Boolean),
  }));
  return {
    rpid: String(reply.rpid_str || reply.rpid || ''),
    user: {
      mid: String(reply.member?.mid || ''),
      name: reply.member?.uname || '',
      avatar: toHttps(reply.member?.avatar || ''),
    },
    message: reply.content?.message || '',
    like: Number(reply.like) || 0,
    reply_count: Number(reply.rcount) || 0,
    ctime: reply.ctime || 0,
    state: reply.state ?? null,
    is_up: Boolean(ownerMid && String(reply.member?.mid || '') === String(ownerMid)),
    is_top: Boolean(isTop),
    pictures: normalizePictures(reply.content),
    mentions: safeArray(reply.content?.members).map(normalizeMember).filter(Boolean),
    replies: childReplies,
  };
}

export async function resolveCommentTarget(client, { bvid, aid, dynamicId } = {}) {
  if ((bvid || aid) && dynamicId) {
    throw new BiliError('video 与 dynamic_id 只能提供其中一个', { code: -400 });
  }
  if (!bvid && !aid && !dynamicId) {
    throw new BiliError('需要提供 video 或 dynamic_id', { code: -400 });
  }

  if (dynamicId) {
    const item = await getDynamicDetail(client, dynamicId);
    const basic = item.basic || {};
    const type = Number(basic.comment_type);
    const oid = String(basic.comment_id_str || basic.rid_str || '');
    if (!oid || !Number.isInteger(type)) {
      throw new BiliError('该动态没有可用的评论主体', {
        code: -400,
        hint: '动态详情缺少 basic.comment_id_str / basic.comment_type。',
      });
    }
    const dynamic = normalizeDynamic(item);
    return {
      kind: 'dynamic',
      oid,
      type,
      target: {
        dynamic_id: String(dynamicId),
        comment_oid: oid,
        comment_type: type,
        url: dynamic?.url || `https://t.bilibili.com/${dynamicId}`,
        text: dynamic?.text?.slice(0, 120) || '',
        author: dynamic?.author?.name || '',
      },
      item,
    };
  }

  const view = await getView(client, { bvid, aid });
  return {
    kind: 'video',
    oid: String(view.aid),
    type: 1,
    target: {
      bvid: view.bvid,
      aid: String(view.aid),
      title: view.title,
      owner: view.owner?.name || '',
      url: `https://www.bilibili.com/video/${view.bvid}`,
    },
    view,
  };
}

function ownerMidOf(resolved) {
  return resolved.kind === 'video'
    ? resolved.view?.owner?.mid
    : resolved.item?.modules?.module_author?.mid;
}

function cursorKey({ oid, type, mode }) {
  return `${type}:${oid}:${mode}`;
}

function getCommentCursor(key) {
  const cached = commentCursors.get(key);
  if (cached && cached.expiresAt > Date.now()) return cached;
  const fresh = { offsets: [''], expiresAt: Date.now() + COMMENT_CACHE_TTL };
  commentCursors.set(key, fresh);
  return fresh;
}

async function requestWbiComments(client, { oid, type, mode, offset }) {
  return client.getSigned(
    'https://api.bilibili.com/x/v2/reply/wbi/main',
    {
      oid,
      type,
      mode,
      pagination_str: JSON.stringify({ offset: offset || '' }),
      plat: 1,
      seek_rpid: '',
      web_location: 1315875,
    },
    { cacheTtl: 20_000 },
  );
}

function formatWbiComments(json, { resolved, page, offset, mode, ownerMid = '' }) {
  const data = json.data || {};
  const cursor = data.cursor || {};
  const replies = safeArray(data.replies);
  const topReplies = safeArray(data.top_replies);
  const top = topReplies
    .map((reply) => normalizeReply(reply, { ownerMid, isTop: true }))
    .filter(Boolean);
  const seen = new Set(top.map((reply) => String(reply.rpid || '')).filter(Boolean));
  const normal = [];
  for (const reply of replies) {
    const item = normalizeReply(reply, { ownerMid });
    if (!item) continue;
    const rpid = String(item.rpid || '');
    if (rpid && seen.has(rpid)) continue;
    if (rpid) seen.add(rpid);
    normal.push(item);
  }
  return {
    target: resolved.target,
    comment_oid: resolved.oid,
    comment_type: resolved.type,
    source: 'x/v2/reply/wbi/main',
    mode,
    page,
    offset: offset || '',
    next_offset: cursor.pagination_reply?.next_offset || null,
    has_more: !cursor.is_end,
    total: cursor.all_count ?? cursor.count ?? replies.length + topReplies.length,
    page_size: COMMENT_PAGE_SIZE,
    top_replies: top,
    replies: normal,
  };
}

async function listWbiComments(
  client,
  resolved,
  { page = 1, sort = 'hot', offset, ownerMid = ownerMidOf(resolved) } = {},
) {
  const mode = sort === 'time' ? 2 : 3;
  const requestedPage = Math.max(1, Math.min(MAX_COMMENT_PAGE, Math.trunc(Number(page) || 1)));
  const key = cursorKey({ oid: resolved.oid, type: resolved.type, mode });
  const cursor = getCommentCursor(key);

  if (offset !== undefined && offset !== null && String(offset).trim() !== '') {
    const json = await requestWbiComments(client, {
      oid: resolved.oid,
      type: resolved.type,
      mode,
      offset: String(offset),
    });
    return formatWbiComments(json, {
      resolved,
      page: requestedPage,
      offset: String(offset),
      mode,
      ownerMid,
    });
  }

  while (cursor.offsets.length < requestedPage) {
    const current = cursor.offsets[cursor.offsets.length - 1];
    const json = await requestWbiComments(client, {
      oid: resolved.oid,
      type: resolved.type,
      mode,
      offset: current,
    });
    const next = json.data?.cursor?.pagination_reply?.next_offset;
    if (!next) break;
    cursor.offsets.push(next);
  }

  const targetOffset = cursor.offsets[requestedPage - 1];
  if (targetOffset === undefined) {
    return {
      target: resolved.target,
      comment_oid: resolved.oid,
      comment_type: resolved.type,
      source: 'x/v2/reply/wbi/main',
      mode,
      page: requestedPage,
      offset: '',
      next_offset: null,
      has_more: false,
      total: 0,
      page_size: COMMENT_PAGE_SIZE,
      top_replies: [],
      replies: [],
      hint: '已到评论区末尾，没有更多可翻页内容。',
    };
  }

  const json = await requestWbiComments(client, {
    oid: resolved.oid,
    type: resolved.type,
    mode,
    offset: targetOffset,
  });
  const next = json.data?.cursor?.pagination_reply?.next_offset;
  if (next && cursor.offsets[requestedPage] === undefined) cursor.offsets[requestedPage] = next;
  return formatWbiComments(json, {
    resolved,
    page: requestedPage,
    offset: targetOffset,
    mode,
    ownerMid,
  });
}

/**
 * Unified comment reader for videos and dynamics.
 * Both use the WBI cursor endpoint. Nested threads still use the dedicated
 * /x/v2/reply/reply endpoint.
 */
async function listCommentThread(client, resolved, { root, page = 1, ps = 20 } = {}) {
  const ownerMid = ownerMidOf(resolved);
  const json = await client.get(
    'https://api.bilibili.com/x/v2/reply/reply',
    {
      oid: resolved.oid,
      type: resolved.type,
      root: String(root),
      pn: Math.max(1, Number(page) || 1),
      ps: Math.max(1, Math.min(Number(ps) || 20, 49)),
    },
    { cacheTtl: 0 },
  );
  return {
    target: resolved.target,
    comment_oid: resolved.oid,
    comment_type: resolved.type,
    root: normalizeReply(json.data?.root, { ownerMid }),
    page: json.data?.page?.num || page,
    total: json.data?.page?.count ?? safeArray(json.data?.replies).length,
    replies: safeArray(json.data?.replies)
      .map((reply) => normalizeReply(reply, { ownerMid }))
      .filter(Boolean),
  };
}

export async function listComments(
  client,
  { bvid, aid, dynamicId, page = 1, ps = 20, sort = 'hot', offset, root } = {},
) {
  const resolved = await resolveCommentTarget(client, { bvid, aid, dynamicId });
  if (root) return listCommentThread(client, resolved, { root, page, ps });
  const result = await listWbiComments(client, resolved, {
    page,
    sort,
    offset,
    ownerMid: ownerMidOf(resolved),
  });
  if (resolved.kind === 'video') {
    return {
      ...result,
      bvid: resolved.view.bvid,
      aid: String(resolved.view.aid),
    };
  }
  return result;
}
