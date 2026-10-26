import { safeArray, toHttps } from '../core/format.mjs';

function normalizeUser(user) {
  return {
    mid: user.mid ? String(user.mid) : '',
    name: user.uname || user.name || '',
    face: toHttps(user.face || user.avatar || ''),
    sign: user.sign || user.usign || '',
    level: user.level_info?.current_level ?? user.level ?? null,
    vip: user.vip?.status ?? user.vip_status ?? 0,
  };
}

export async function listFollowings(client, { mid, page = 1, ps = 50, order = 'desc' } = {}) {
  const vmid = String(mid || client.uid);
  if (!vmid) throw new Error('需要 mid 或已登录账号');
  const json = await client.get(
    'https://api.bilibili.com/x/relation/followings',
    {
      vmid,
      pn: Math.max(1, Number(page) || 1),
      ps: Math.max(1, Math.min(Number(ps) || 50, 50)),
      order,
      order_type: 'attention',
    },
    { cacheTtl: 30_000 },
  );
  const list = safeArray(json.data?.list).map((item) => ({
    ...normalizeUser(item),
    mtime: item.mtime || 0,
    attribute: item.attribute ?? null,
    special: item.special ?? 0,
    official_verify: item.official_verify || null,
  }));
  return {
    mid: vmid,
    page: json.data?.page || page,
    total: json.data?.total || list.length,
    items: list,
  };
}

export async function listFollowers(client, { mid, page = 1, ps = 50 } = {}) {
  const vmid = String(mid || client.uid);
  const json = await client.get(
    'https://api.bilibili.com/x/relation/fans',
    { vmid, pn: Math.max(1, Number(page) || 1), ps: Math.max(1, Math.min(Number(ps) || 50, 50)) },
    { cacheTtl: 30_000 },
  );
  return {
    mid: vmid,
    page: json.data?.page || page,
    total: json.data?.total || 0,
    items: safeArray(json.data?.list).map((item) => ({
      ...normalizeUser(item),
      mtime: item.mtime || 0,
    })),
  };
}
