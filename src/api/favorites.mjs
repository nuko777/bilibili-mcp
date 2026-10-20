import { safeArray, toHttps } from '../core/format.mjs';

function normalizeFolder(folder) {
  return {
    id: String(folder.id || ''),
    fid: folder.fid ? String(folder.fid) : null,
    title: folder.title || '',
    count: folder.media_count ?? folder.count ?? 0,
    privacy: folder.attr ?? folder.privacy ?? 0,
    cover: toHttps(folder.cover || ''),
    intro: folder.intro || '',
    ctime: folder.ctime || 0,
    mtime: folder.mtime || 0,
  };
}

export async function listFavoriteFolders(client, { mid } = {}) {
  const upMid = String(mid || client.uid);
  if (!upMid) throw new Error('需要 mid 或已登录账号');
  const json = await client.get(
    'https://api.bilibili.com/x/v3/fav/folder/created/list-all',
    { up_mid: upMid, type: 2, rid: 0 },
    { cacheTtl: 60_000 },
  );
  return {
    mid: upMid,
    total: safeArray(json.data?.list).length,
    items: safeArray(json.data?.list).map(normalizeFolder),
  };
}

function normalizeMedia(media) {
  const bvid = media.bvid || media.bv_id || '';
  return {
    id: String(media.id || ''),
    bvid: String(bvid),
    title: media.title || '',
    url: bvid ? `https://www.bilibili.com/video/${bvid}` : '',
    cover: toHttps(media.cover || media.pic || ''),
    duration: media.duration || 0,
    intro: (media.intro || media.desc || '').slice(0, 300),
    type: media.type,
    upper: media.upper
      ? { mid: String(media.upper.mid || ''), name: media.upper.name || '', face: toHttps(media.upper.face || '') }
      : null,
    cnt_info: media.cnt_info || null,
    fav_time: media.fav_time || media.ctime || 0,
    fav_time_text: media.fav_time_text || '',
    attr: media.attr ?? null,
  };
}

export async function listFavorites(client, { folderId, page = 1, ps = 20, keyword = '', order = 'mtime' } = {}) {
  if (!folderId) return listFavoriteFolders(client);
  const json = await client.get(
    'https://api.bilibili.com/x/v3/fav/resource/list',
    {
      media_id: String(folderId),
      pn: Math.max(1, Number(page) || 1),
      ps: Math.max(1, Math.min(Number(ps) || 20, 40)),
      keyword,
      order,
      type: 0,
      tid: 0,
      platform: 'web',
    },
    { cacheTtl: 30_000 },
  );
  const info = json.data?.info;
  return {
    folder: info ? normalizeFolder(info) : { id: String(folderId) },
    page: json.data?.page || page,
    total: info?.media_count ?? safeArray(json.data?.medias).length,
    has_more: Boolean(json.data?.has_more),
    items: safeArray(json.data?.medias).map(normalizeMedia),
  };
}

export async function favoriteResourceIds(client, { folderId } = {}) {
  if (!folderId) throw new Error('需要 folderId（收藏夹 media_id）');
  const json = await client.get(
    'https://api.bilibili.com/x/v3/fav/resource/ids',
    { media_id: String(folderId), platform: 'web' },
    { cacheTtl: 5 * 60_000 },
  );
  return safeArray(json.data).map((item) => ({
    id: String(item.id || ''),
    type: item.type,
    bvid: item.bvid || item.bv_id || '',
  }));
}
