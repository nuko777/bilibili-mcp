import { BiliError } from '../core/errors.mjs';
import { safeArray } from '../core/format.mjs';

export async function nav(client) {
  const json = await client.get('https://api.bilibili.com/x/web-interface/nav', {}, { allowCodes: [0, -101], cacheTtl: 0 });
  return json;
}

export async function authStatus(client) {
  const navJson = await nav(client);
  const data = navJson.data || {};
  const isLogin = navJson.code === 0 && Boolean(data.isLogin);
  let unread = null;
  let privateUnread = null;
  if (isLogin) {
    try {
      const msg = await client.get(
        'https://api.vc.bilibili.com/x/im/web/msgfeed/unread',
        { build: 0, mobi_app: 'web' },
        { cacheTtl: 0 },
      );
      unread = msg.data || null;
    } catch {
      unread = null;
    }
    try {
      const privateMsg = await client.get(
        'https://api.vc.bilibili.com/session_svr/v1/session_svr/single_unread',
        { unread_type: 0, show_unfollow_list: 1, show_dustbin: 1, build: 0, mobi_app: 'web' },
        { cacheTtl: 0 },
      );
      privateUnread = privateMsg.data || null;
    } catch {
      privateUnread = null;
    }
  }
  return {
    is_login: isLogin,
    uname: data.uname || '',
    mid: data.mid ? String(data.mid) : '',
    face: data.face || '',
    coins: data.money ?? null,
    level: data.level_info?.current_level ?? null,
    current_exp: data.level_info?.current_exp ?? null,
    vip_status: data.vipStatus ?? 0,
    email_verified: Boolean(data.email_verified),
    mobile_verified: Boolean(data.mobile_verified),
    unread,
    private_unread: privateUnread,
    hint: isLogin
      ? undefined
      : 'MCP 不提取登录态。请使用 bilibili-login skill 从浏览器获取 Cookie，写入配置或 BILI_COOKIE 后重试。',
  };
}

export async function accountInfo(client) {
  client.requireLogin();
  const json = await client.get('https://api.bilibili.com/x/member/web/account', {}, { cacheTtl: 5 * 60_000 });
  const data = json.data || {};
  return {
    mid: data.mid ? String(data.mid) : '',
    uname: data.uname || '',
    userid: data.userid || '',
    sign: data.sign || '',
    birthday: data.birthday || '',
    sex: data.sex || '',
    rank: data.rank || '',
  };
}

export async function coinBalance(client) {
  const json = await nav(client);
  if (!json.data?.isLogin) {
    throw new BiliError('登录态无效，无法读取硬币余额', { code: -101 });
  }
  return {
    coins: json.data.money ?? null,
    bcoin_balance: json.data.wallet?.bcoin_balance ?? null,
    coupon_balance: json.data.wallet?.coupon_balance ?? null,
  };
}

export function compactUnread(unread) {
  if (!unread) return null;
  return {
    replies: unread.reply ?? unread.recv_reply ?? 0,
    ats: unread.at ?? 0,
    likes: unread.like ?? unread.recv_like ?? 0,
    coins: unread.coin ?? 0,
    favorites: unread.favorite ?? 0,
    danmaku: unread.danmu ?? 0,
    system: unread.sys_msg ?? 0,
    up: unread.up ?? 0,
  };
}

export function compactPrivateUnread(data) {
  if (!data) return null;
  return {
    follow_unread: data.follow_unread ?? 0,
    unfollow_unread: data.unfollow_unread ?? 0,
    unfollow_push_msg: data.unfollow_push_msg ?? 0,
    dustbin_unread: data.dustbin_unread ?? 0,
    custom_unread: data.custom_unread ?? 0,
  };
}

export function notificationItems(raw) {
  return safeArray(raw?.items);
}
