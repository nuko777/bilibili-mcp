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

export function clearViewCache() {
  viewCache.clear();
}

export async function getView(client, ref) {
  const parsed = parseVideoRef(ref);
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

export async function videoComments(
  client,
  { bvid, aid, page = 1, ps = 20, sort = 'hot' } = {},
) {
  const view = await getView(client, { bvid, aid });
  const json = await client.get(
    'https://api.bilibili.com/x/v2/reply',
    {
      type: 1,
      oid: view.aid,
      pn: Math.max(1, Number(page) || 1),
      ps: Math.max(1, Math.min(Number(ps) || 20, 49)),
      sort: sort === 'time' ? 0 : 2,
      plat: 1,
      web_location: 1315875,
    },
    { cacheTtl: 30_000 },
  );
  const replies = safeArray(json.data?.replies).map((reply) => ({
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
    is_up: Boolean(reply.up_action?.like) || reply.mid === view.owner?.mid,
    pictures: safeArray(reply.content?.pictures).map((pic) => ({
      url: toHttps(pic.img_src || pic.url || ''),
      width: Number(pic.img_width || pic.width) || 0,
      height: Number(pic.img_height || pic.height) || 0,
      size: Number(pic.img_size || pic.size) || 0,
    })).filter((pic) => pic.url),
    mentions: safeArray(reply.content?.members).map((member) => ({
      mid: String(member.mid || ''),
      name: member.uname || '',
      avatar: toHttps(member.avatar || ''),
    })).filter((member) => member.mid),
    replies: safeArray(reply.replies).map((child) => ({
      rpid: String(child.rpid_str || child.rpid || ''),
      user: child.member?.uname || '',
      message: child.content?.message || '',
      like: Number(child.like) || 0,
      ctime: child.ctime || 0,
      state: child.state ?? null,
      is_up: String(child.member?.mid || '') === String(view.owner?.mid || ''),
      pictures: safeArray(child.content?.pictures).map((pic) => ({
        url: toHttps(pic.img_src || pic.url || ''),
        width: Number(pic.img_width || pic.width) || 0,
        height: Number(pic.img_height || pic.height) || 0,
        size: Number(pic.img_size || pic.size) || 0,
      })).filter((pic) => pic.url),
      mentions: safeArray(child.content?.members).map((member) => ({
        mid: String(member.mid || ''),
        name: member.uname || '',
        avatar: toHttps(member.avatar || ''),
      })).filter((member) => member.mid),
    })),
  }));
  return {
    bvid: view.bvid,
    aid: String(view.aid),
    page: json.data?.page?.num || page,
    total: json.data?.page?.count || 0,
    replies,
  };
}

export async function search(client, { keyword, type = 'video', page = 1, limit = 20, order = 'totalrank' } = {}) {
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
  return {
    type: 'video',
    keyword,
    page: json.data?.page || page,
    total: json.data?.numResults || 0,
    items: results.slice(0, limit).map((item) => ({
      bvid: item.bvid || '',
      aid: String(item.aid || ''),
      title: stripHtml(item.title || ''),
      url: item.bvid ? `https://www.bilibili.com/video/${item.bvid}` : item.arcurl || '',
      cover: toHttps(item.pic || ''),
      author: stripHtml(item.author || ''),
      mid: String(item.mid || ''),
      play: item.play || 0,
      danmaku: item.video_review || 0,
      duration: item.duration || '',
      pubdate: item.pubdate || 0,
      tags: String(item.tag || '')
        .split(',')
        .map((tag) => tag.trim())
        .filter(Boolean),
      description: truncate(stripHtml(item.description || ''), 200),
    })),
  };
}

export async function userInfo(client, { mid } = {}) {
  if (!mid) throw new Error('需要提供 mid');
  try {
    const json = await client.get('https://api.bilibili.com/x/web-interface/card', { mid }, { cacheTtl: 5 * 60_000 });
    const card = json.data?.card;
    if (card) {
      let following = json.data?.following || 0;
      let fans = json.data?.follower || json.data?.fans || 0;
      try {
        const relation = await client.get('https://api.bilibili.com/x/relation/stat', { vmid: card.mid || mid }, { cacheTtl: 60_000 });
        following = relation.data?.following ?? following;
        fans = relation.data?.follower ?? fans;
      } catch {
        // Keep the card values when relation stat is unavailable.
      }
      return {
        mid: String(card.mid || mid),
        name: card.name || '',
        face: toHttps(card.face || ''),
        sign: truncate(card.sign || '', 300),
        level: card.level_info?.current_level || 0,
        fans,
        following,
        archive_count: json.data?.archive_count || 0,
        like_num: json.data?.like_num || 0,
        url: `https://space.bilibili.com/${card.mid || mid}`,
      };
    }
  } catch {
    // Fall back to the signed space API below.
  }
  const json = await client.getSigned(
    'https://api.bilibili.com/x/space/wbi/acc/info',
    { mid },
    { cacheTtl: 5 * 60_000 },
  );
  const data = json.data || {};
  return {
    mid: String(data.mid || mid),
    name: data.name || '',
    face: toHttps(data.face || ''),
    sign: truncate(data.sign || '', 300),
    level: data.level || 0,
    fans: data.fans || 0,
    following: data.following || 0,
    archive_count: data.archive_count || 0,
    like_num: data.like_num || 0,
    url: `https://space.bilibili.com/${data.mid || mid}`,
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
