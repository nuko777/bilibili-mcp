import { safeArray, toHttps } from '../core/format.mjs';

function parseJson(value) {
  if (value && typeof value === 'object') return value;
  try {
    return JSON.parse(value || '{}');
  } catch {
    return {};
  }
}

export function parseMessageContent(msg) {
  const payload = parseJson(msg?.content);
  const type = Number(msg?.msg_type);
  let text = '';
  switch (type) {
    case 1:
      text = payload.content || '';
      break;
    case 2:
      text = '[图片]';
      break;
    case 5:
      text = payload.content || '[系统消息]';
      break;
    case 7:
      text = `[视频] ${payload.title || payload.content || ''}`.trim();
      break;
    case 8:
      text = `[动态] ${payload.title || payload.content || ''}`.trim();
      break;
    case 10:
      text = `[专栏] ${payload.title || payload.content || ''}`.trim();
      break;
    case 12:
      text = `[表情] ${payload.content || ''}`.trim();
      break;
    case 13:
      text = '[撤回]';
      break;
    case 16:
      text = `[分享] ${payload.title || payload.content || ''}`.trim();
      break;
    default:
      text = payload.content || payload.title || payload.msg || '';
      break;
  }
  return {
    type,
    text,
    image_url: type === 2 ? toHttps(payload.url || '') : '',
    payload,
  };
}

export async function listSessions(client, { limit = 20 } = {}) {
  client.requireLogin();
  const json = await client.getSigned(
    'https://api.vc.bilibili.com/session_svr/v1/session_svr/get_sessions',
    {
      session_type: 1,
      group_fold: 1,
      unfollow_fold: 1,
      sort_rule: 2,
      build: 0,
      mobi_app: 'web',
      statistics: JSON.stringify({ appId: 100 }),
    },
    { cacheTtl: 15_000 },
  );
  const sessionList = safeArray(json.data?.session_list).slice(0, Math.max(1, Math.min(Number(limit) || 20, 50)));
  const ids = [...new Set(sessionList.map((session) => String(session.talker_id)).filter(Boolean))].slice(0, 20);
  let cards = {};
  if (ids.length) {
    try {
      const cardJson = await client.get(
        'https://api.bilibili.com/x/polymer/pc-electron/v1/user/cards',
        { uids: ids.join(',') },
        { cacheTtl: 5 * 60_000 },
      );
      cards = cardJson.data || {};
    } catch {
      cards = {};
    }
  }
  return {
    total: json.data?.session_list?.length || sessionList.length,
    items: sessionList.map((session) => {
      const talkerId = String(session.talker_id || '');
      const card = cards[talkerId];
      const last = session.last_msg;
      const parsed = last ? parseMessageContent(last) : null;
      return {
        talker_id: talkerId,
        name: card?.name || session.account_info?.name || session.group_name || '',
        avatar: toHttps(card?.face || session.account_info?.pic_url || session.group_cover || ''),
        session_type: session.session_type,
        unread_count: session.unread_count ?? 0,
        is_follow: session.is_follow ?? 0,
        top_ts: session.top_ts ?? 0,
        session_ts: session.session_ts ?? 0,
        timestamp: last?.timestamp || Math.floor(Number(session.session_ts || 0) / 1_000_000),
        last_message: parsed
          ? {
              type: parsed.type,
              text: parsed.text,
              sender_uid: String(last.sender_uid || ''),
              timestamp: last.timestamp || 0,
            }
          : null,
      };
    }),
  };
}

export async function fetchSessionMessages(client, { talkerId, limit = 30, sessionType = 1 } = {}) {
  client.requireLogin();
  if (!talkerId) throw new Error('需要 talkerId（会话对方的 mid）');
  const json = await client.getSigned(
    'https://api.vc.bilibili.com/svr_sync/v1/svr_sync/fetch_session_msgs',
    {
      talker_id: String(talkerId),
      session_type: sessionType,
      size: Math.max(1, Math.min(Number(limit) || 30, 100)),
      begin_seqno: '',
      end_seqno: '',
      sender_device_id: 1,
      build: 0,
      mobi_app: 'web',
    },
    { cacheTtl: 5_000, retry: 1 },
  );
  const messages = safeArray(json.data?.messages)
    .slice(0, Math.max(1, Math.min(Number(limit) || 30, 100)))
    .map((msg) => {
      const parsed = parseMessageContent(msg);
      return {
        msg_key: String(msg.msg_key_str || msg.msg_key || ''),
        msg_seqno: msg.msg_seqno ?? null,
        sender_uid: String(msg.sender_uid || ''),
        receiver_id: String(msg.receiver_id || ''),
        receiver_type: msg.receiver_type,
        msg_type: parsed.type,
        text: parsed.text,
        image_url: parsed.image_url || '',
        timestamp: msg.timestamp || 0,
        msg_status: msg.msg_status ?? 0,
        msg_source: msg.msg_source ?? null,
      };
    })
    .sort((a, b) => (a.msg_seqno || 0) - (b.msg_seqno || 0) || (a.timestamp || 0) - (b.timestamp || 0));
  return {
    talker_id: String(talkerId),
    session_type: sessionType,
    messages,
  };
}
