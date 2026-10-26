import { safeArray, toHttps } from '../core/format.mjs';

const NOTIFICATION_READ_NOTE =
  '读取回复/@/赞通知会更新消息中心已读状态；当前接口没有“只读不标已读”开关。';

function normalizeUser(user) {
  return {
    mid: user?.mid ? String(user.mid) : '',
    name: user?.nickname || user?.uname || user?.name || '',
    avatar: toHttps(user?.avatar || user?.face || ''),
    follow: Boolean(user?.follow),
    fans: user?.fans ?? null,
  };
}

function normalizeSource(source) {
  return {
    type: source?.type || '',
    business: source?.business || '',
    business_id: source?.business_id_str ?? (source?.business_id !== undefined ? String(source.business_id) : null),
    rpid: source?.source_id ? String(source.source_id) : null,
    root_rpid: source?.root_id ? String(source.root_id) : null,
    target_rpid: source?.target_id ? String(source.target_id) : null,
    title: source?.title || '',
    desc: source?.desc || '',
    uri: source?.uri || source?.native_uri || '',
    image: toHttps(source?.image || ''),
    subject_id: source?.subject_id ? String(source.subject_id) : null,
  };
}

function normalizeReplyItem(item) {
  const source = item?.item || {};
  const content =
    source.source_content ||
    source.root_reply_content ||
    source.target_reply_content ||
    source.at_content ||
    source.message ||
    source.desc ||
    '';
  return {
    id: String(item?.id_str || item?.id || ''),
    user: normalizeUser(item?.user),
    content,
    source: normalizeSource(source),
    root_content: source.root_reply_content || '',
    target_content: source.target_reply_content || '',
    at_details: safeArray(source.at_details).map((detail) => ({
      mid: detail.mid ? String(detail.mid) : '',
      nickname: detail.nickname || '',
    })),
    reply_time: item?.reply_time || source.reply_time || 0,
    counts: item?.counts ?? 0,
    is_multi: Boolean(item?.is_multi),
  };
}

function normalizeLikeItem(item) {
  const source = item?.item || {};
  return {
    id: String(item?.id_str || item?.id || ''),
    users: safeArray(item?.users).map(normalizeUser),
    source: normalizeSource(source),
    total: item?.total ?? safeArray(item?.users).length,
    time: item?.like_time || item?.time || 0,
  };
}

async function fetchFeed(client, endpoint, { page = 1, ps = 20 } = {}) {
  const json = await client.get(
    endpoint,
    { pn: Math.max(1, Number(page) || 1), ps: Math.max(1, Math.min(Number(ps) || 20, 20)), platform: 'web', build: 0, mobi_app: 'web' },
    { cacheTtl: 30_000 },
  );
  return json;
}

export async function unreadNotifications(client) {
  const json = await client.get(
    'https://api.vc.bilibili.com/x/im/web/msgfeed/unread',
    { build: 0, mobi_app: 'web' },
    { cacheTtl: 0 },
  );
  const data = json.data || {};
  return {
    replies: data.reply ?? data.recv_reply ?? 0,
    ats: data.at ?? 0,
    likes: data.like ?? data.recv_like ?? 0,
    coins: data.coin ?? 0,
    favorites: data.favorite ?? 0,
    danmaku: data.danmu ?? 0,
    system: data.sys_msg ?? 0,
    up: data.up ?? 0,
    raw: data,
    read_side_effect: false,
    read_note: '未读数查询不会标记通知已读。',
  };
}

export async function replyNotifications(client, { page = 1, ps = 20 } = {}) {
  const json = await fetchFeed(client, 'https://api.bilibili.com/x/msgfeed/reply', { page, ps });
  return {
    cursor: json.data?.cursor || null,
    last_view_at: json.data?.last_view_at || 0,
    read_side_effect: true,
    read_note: NOTIFICATION_READ_NOTE,
    items: safeArray(json.data?.items).map(normalizeReplyItem),
  };
}

export async function atNotifications(client, { page = 1, ps = 20 } = {}) {
  const json = await fetchFeed(client, 'https://api.bilibili.com/x/msgfeed/at', { page, ps });
  return {
    cursor: json.data?.cursor || null,
    last_view_at: json.data?.last_view_at || 0,
    read_side_effect: true,
    read_note: NOTIFICATION_READ_NOTE,
    items: safeArray(json.data?.items).map(normalizeReplyItem),
  };
}

export async function likeNotifications(client, { page = 1, ps = 20 } = {}) {
  const json = await fetchFeed(client, 'https://api.bilibili.com/x/msgfeed/like', { page, ps });
  return {
    latest: {
      cursor: json.data?.latest?.cursor || null,
      items: safeArray(json.data?.latest?.items).map(normalizeLikeItem),
    },
    total: {
      cursor: json.data?.total?.cursor || null,
      items: safeArray(json.data?.total?.items).map(normalizeLikeItem),
    },
    read_side_effect: true,
    read_note: NOTIFICATION_READ_NOTE,
  };
}
