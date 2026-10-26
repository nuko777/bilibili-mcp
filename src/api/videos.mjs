import { BiliError } from '../core/errors.mjs';
import {
  normalizePage,
  normalizeVideo,
  parseDuration,
  parseVideoRef,
  safeArray,
  stripHtml,
  toHttps,
  truncate,
} from '../core/format.mjs';

const VIEW_ENDPOINT = 'https://api.bilibili.com/x/web-interface/view';
const TAGS_ENDPOINT = 'https://api.bilibili.com/x/tag/archive/tags';
const PLAYER_ENDPOINT = 'https://api.bilibili.com/x/player/wbi/v2';

const viewCache = new Map();

const SHORT_LINK_HOSTS = ['b23.tv', 'bili2233.cn', 'b23.wtf'];
const SHORT_LINK_UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/155.0.0.0 Safari/537.36';

function isShortLinkHost(hostname) {
  const host = String(hostname || '').toLowerCase();
  return SHORT_LINK_HOSTS.some((item) => host === item || host.endsWith(`.${item}`));
}

function isResolveHost(hostname) {
  const host = String(hostname || '').toLowerCase();
  return isShortLinkHost(host) || host === 'bilibili.com' || host.endsWith('.bilibili.com');
}

function tryParseVideoRef(value) {
  try {
    return parseVideoRef(value);
  } catch {
    return null;
  }
}

/**
 * Resolve b23.tv / bili2233.cn short links by following redirects. Every hop
 * must stay on a short-link host or bilibili.com, and the whole resolution
 * shares one deadline so a redirect chain cannot hang for minutes.
 */
export async function resolveShortVideoRef(ref, { fetchImpl = fetch, timeoutMs = 10_000 } = {}) {
  if (typeof ref !== 'string') return null;
  let url;
  try {
    url = new URL(ref.trim());
  } catch {
    return null;
  }
  if (!['http:', 'https:'].includes(url.protocol) || !isShortLinkHost(url.hostname)) return null;
  let current = url.toString();
  const deadline = Date.now() + Math.max(1, Number(timeoutMs) || 10_000);
  const remaining = () => deadline - Date.now();
  const timeoutSignal = () => {
    const left = remaining();
    if (left <= 0) return null;
    return AbortSignal.timeout(left);
  };
  const headers = { 'User-Agent': SHORT_LINK_UA, Referer: 'https://www.bilibili.com/' };
  for (let hop = 0; hop < 4; hop += 1) {
    const signal = timeoutSignal();
    if (!signal) return null;
    let response;
    try {
      response = await fetchImpl(current, {
        method: 'HEAD',
        redirect: 'manual',
        headers,
        signal,
      });
    } catch {
      return null;
    }
    if (response.status >= 300 && response.status < 400) {
      const location = response.headers.get('location');
      if (!location) return null;
      const next = new URL(location, current);
      if (!isResolveHost(next.hostname)) return null;
      current = next.toString();
      const parsed = tryParseVideoRef(current);
      if (parsed) return parsed;
      continue;
    }
    break;
  }
  if (!isResolveHost(new URL(current).hostname)) return null;
  const signal = timeoutSignal();
  if (!signal) return null;
  try {
    const response = await fetchImpl(current, {
      method: 'GET',
      redirect: 'follow',
      headers,
      signal,
    });
    if (!isResolveHost(new URL(response.url).hostname)) return null;
    return tryParseVideoRef(response.url);
  } catch {
    return null;
  }
}

export async function getView(client, ref) {
  // Tool handlers commonly pass `{ bvid: userInput }`, so extract the raw
  // scalar before parsing/resolving; otherwise a b23 short link in `bvid`
  // would be passed to the view endpoint verbatim.
  const rawRef = ref && typeof ref === 'object' ? ref.bvid || ref.aid || ref.url : ref;
  let parsed;
  try {
    parsed = parseVideoRef(rawRef);
  } catch (error) {
    parsed = await resolveShortVideoRef(rawRef);
    if (!parsed) throw error;
  }
  const key = parsed.bvid ? `bvid:${parsed.bvid}` : `aid:${parsed.aid}`;
  const cached = viewCache.get(key);
  if (cached && cached.expiresAt > Date.now()) return cached.value;
  const params = parsed.bvid ? { bvid: parsed.bvid } : { aid: parsed.aid };
  const json = await client.get(VIEW_ENDPOINT, params, { cacheTtl: 5 * 60_000 });
  if (!json.data?.bvid) {
    throw new BiliError('无法获取视频信息（可能已失效或不可见）', {
      code: json.code,
      endpoint: VIEW_ENDPOINT,
      details: json,
    });
  }
  viewCache.set(key, { value: json.data, expiresAt: Date.now() + 5 * 60_000 });
  return json.data;
}

export async function getVideoTags(client, bvid) {
  const json = await client.get(TAGS_ENDPOINT, { bvid }, { cacheTtl: 10 * 60_000, tagRequest: true });
  return safeArray(json.data)
    .map((tag) => ({
      id: tag.tag_id || tag.tag_id_str || null,
      name: tag.tag_name || tag.name || '',
      cover: toHttps(tag.cover || ''),
      count: tag.count || null,
    }))
    .filter((tag) => tag.name);
}

export function choosePage(view, pageNumber = 1) {
  const pages = safeArray(view.pages);
  if (!pages.length) {
    return { page: 1, cid: String(view.cid || ''), title: view.title || '', duration: Number(view.duration) || 0 };
  }
  const index = Math.max(1, Math.min(Math.trunc(Number(pageNumber) || 1), pages.length));
  const page = pages[index - 1];
  return {
    page: Number(page.page) || index,
    cid: String(page.cid || ''),
    title: page.part || view.title || '',
    duration: Number(page.duration) || 0,
    all: pages.map((item, i) => normalizePage(item, i + 1)),
  };
}

export async function videoInfo(client, { bvid, aid, page = 1, includeSubtitles = true } = {}) {
  const view = await getView(client, { bvid, aid });
  const selected = choosePage(view, page);
  let tags = [];
  let tagsError = null;
  try {
    tags = await getVideoTags(client, view.bvid);
  } catch (error) {
    tagsError = error.message;
  }
  let subtitleLanguages = [];
  let subtitleError = null;
  if (includeSubtitles) {
    try {
      const player = await client.getSigned(PLAYER_ENDPOINT, { bvid: view.bvid, cid: selected.cid }, { cacheTtl: 60_000 });
      subtitleLanguages = safeArray(player.data?.subtitle?.subtitles).map((item) => ({
        lan: item.lan,
        label: item.lan_doc,
        locked: Boolean(item.is_lock),
        has_url: Boolean(item.subtitle_url),
      }));
    } catch (error) {
      subtitleLanguages = [];
      subtitleError = error.message;
    }
  }
  return {
    bvid: view.bvid,
    aid: String(view.aid),
    cid: selected.cid,
    url: `https://www.bilibili.com/video/${view.bvid}`,
    title: view.title,
    desc: truncate(view.desc || '', 800),
    cover: toHttps(view.pic || ''),
    duration: Number(view.duration) || 0,
    pubdate: view.pubdate || 0,
    ctime: view.ctime || 0,
    owner: view.owner
      ? { mid: String(view.owner.mid), name: view.owner.name, face: toHttps(view.owner.face || '') }
      : null,
    stat: view.stat || null,
    tname: view.tname || '',
    tid: view.tid || null,
    copyright: view.copyright,
    videos: view.videos || 1,
    page: selected.page,
    page_title: selected.title,
    pages: selected.all || [],
    tags,
    tags_error: tagsError || undefined,
    subtitle_languages: subtitleLanguages,
    subtitle_error: subtitleError || undefined,
    dimension: view.dimension || null,
    staff: safeArray(view.staff).map((member) => ({
      mid: String(member.mid || ''),
      name: member.name || '',
      title: member.title || '',
      face: toHttps(member.face || ''),
    })),
  };
}

export async function search(client, { keyword, type = 'video', page = 1, limit = 20, order = 'totalrank', minPlay = 0 } = {}) {
  if (!keyword || !String(keyword).trim()) throw new Error('keyword 不能为空');
  const searchType = type === 'user' ? 'bili_user' : 'video';
  const json = await client.getSigned(
    'https://api.bilibili.com/x/web-interface/wbi/search/type',
    {
      search_type: searchType,
      keyword: String(keyword).trim(),
      page: Math.max(1, Number(page) || 1),
      page_size: Math.max(1, Math.min(Number(limit) || 20, 50)),
      order,
    },
    { cacheTtl: 60_000 },
  );
  const results = safeArray(json.data?.result);
  if (searchType === 'bili_user') {
    return {
      type: 'user',
      keyword,
      page: json.data?.page || page,
      total: json.data?.numResults || 0,
      items: results.slice(0, limit).map((user) => ({
        mid: String(user.mid || ''),
        name: stripHtml(user.uname || ''),
        avatar: toHttps(user.upic || ''),
        sign: truncate(stripHtml(user.usign || ''), 160),
        fans: user.fans || 0,
        videos: user.videos || 0,
        level: user.level || 0,
        url: `https://space.bilibili.com/${user.mid}`,
      })),
    };
  }
  const minPlayCount = Math.max(0, Number(minPlay) || 0);
  const videos = results
    .map((item) => ({
      bvid: item.bvid || '',
      aid: String(item.aid || ''),
      title: stripHtml(item.title || ''),
      url: item.bvid ? `https://www.bilibili.com/video/${item.bvid}` : item.arcurl || '',
      cover: toHttps(item.pic || ''),
      author: stripHtml(item.author || ''),
      mid: String(item.mid || ''),
      play: Number(item.play) || 0,
      danmaku: item.video_review || 0,
      duration: item.duration || '',
      pubdate: item.pubdate || 0,
      tags: String(item.tag || '')
        .split(',')
        .map((tag) => tag.trim())
        .filter(Boolean),
      description: truncate(stripHtml(item.description || ''), 200),
    }))
    .filter((item) => item.play >= minPlayCount);
  return {
    type: 'video',
    keyword,
    page: json.data?.page || page,
    total: json.data?.numResults || 0,
    filtered: videos.length,
    min_play: minPlayCount || undefined,
    hint: minPlayCount && !videos.length
      ? '当前排序下没有达到 min_play 的视频；可改用 order="totalrank" 或降低 min_play。'
      : undefined,
    items: videos.slice(0, limit),
  };
}

export async function userInfo(client, { mid } = {}) {
  if (!mid) throw new Error('需要提供 mid');
  const json = await client.getSigned(
    'https://api.bilibili.com/x/space/wbi/acc/info',
    { mid },
    { cacheTtl: 5 * 60_000 },
  );
  const data = json.data || {};
  const vmid = String(data.mid || mid);
  const [relation, navnum, upstat] = await Promise.allSettled([
    client.get('https://api.bilibili.com/x/relation/stat', { vmid }, { cacheTtl: 60_000 }),
    client.get('https://api.bilibili.com/x/space/navnum', { mid: vmid }, { cacheTtl: 60_000 }),
    client.get('https://api.bilibili.com/x/space/upstat', { mid: vmid }, { cacheTtl: 60_000 }),
  ]);
  return {
    mid: vmid,
    name: data.name || '',
    face: toHttps(data.face || ''),
    sign: truncate(data.sign || '', 300),
    level: data.level || 0,
    fans: relation.status === 'fulfilled' ? relation.value.data?.follower ?? 0 : 0,
    following: relation.status === 'fulfilled' ? relation.value.data?.following ?? 0 : 0,
    archive_count: navnum.status === 'fulfilled' ? navnum.value.data?.video ?? 0 : 0,
    like_num: upstat.status === 'fulfilled' ? upstat.value.data?.likes ?? 0 : 0,
    url: `https://space.bilibili.com/${vmid}`,
  };
}

export async function userVideos(client, { mid, page = 1, limit = 20, order = 'pubdate' } = {}) {
  if (!mid) throw new Error('需要提供 mid');
  const json = await client.getSigned(
    'https://api.bilibili.com/x/space/wbi/arc/search',
    {
      mid,
      pn: Math.max(1, Number(page) || 1),
      ps: Math.max(1, Math.min(Number(limit) || 20, 50)),
      order,
      index: 0,
    },
    { cacheTtl: 60_000 },
  );
  const list = safeArray(json.data?.list?.vlist);
  return {
    mid: String(mid),
    page: json.data?.page?.pn || page,
    total: json.data?.page?.count || 0,
    items: list.map((item) =>
      normalizeVideo(
        {
          ...item,
          aid: item.aid,
          bvid: item.bvid,
          owner: item.owner || { mid: item.mid, name: item.author, face: item.upic || '' },
          stat: item.stat || {
            view: item.play,
            danmaku: item.video_review,
            reply: item.comment,
            favorite: item.favorites,
          },
          pubdate: item.pubdate || item.created,
          duration: item.duration || parseDuration(item.length),
          desc: item.description,
        },
        'user_videos',
      ),
    ),
  };
}

export async function watchHistory(client, { ps = 20 } = {}) {
  const json = await client.get(
    'https://api.bilibili.com/x/web-interface/history/cursor',
    { ps: Math.max(1, Math.min(Number(ps) || 20, 30)), type: 'archive' },
    { cacheTtl: 30_000 },
  );
  const list = safeArray(json.data?.list);
  return {
    cursor: json.data?.cursor || null,
    items: list.map((item) => {
      const video = item.videos || item;
      return {
        bvid: video.bvid || '',
        aid: String(item.oid || video.aid || ''),
        title: video.title || '',
        url: video.bvid ? `https://www.bilibili.com/video/${video.bvid}` : '',
        cover: toHttps(video.pic || ''),
        author: video.owner?.name || '',
        progress: item.progress || 0,
        duration: video.duration || 0,
        viewed_at: item.view_at || 0,
      };
    }),
  };
}

export async function toviewList(client, { ps = 20 } = {}) {
  const json = await client.get('https://api.bilibili.com/x/v2/history/toview/web', {}, { cacheTtl: 60_000 });
  const list = safeArray(json.data?.list);
  return {
    count: json.data?.count || list.length,
    items: list.slice(0, Math.max(1, Number(ps) || 20)).map((item) => normalizeVideo(item, 'toview')),
  };
}

export async function relatedVideos(client, { bvid, aid, limit = 20 } = {}) {
  const view = await getView(client, { bvid, aid });
  const json = await client.get('https://api.bilibili.com/x/web-interface/archive/related', { bvid: view.bvid }, { cacheTtl: 5 * 60_000 });
  return {
    bvid: view.bvid,
    items: safeArray(json.data).slice(0, Math.max(1, Math.min(Number(limit) || 20, 50))).map((item) => normalizeVideo(item, 'related')),
  };
}
