import { BiliError } from '../core/errors.mjs';
import { safeArray } from '../core/format.mjs';
import { choosePage, getView } from '../api/videos.mjs';

const PLAYER_ENDPOINT = 'https://api.bilibili.com/x/player/wbi/v2';

const LANGUAGE_PRIORITY = ['zh-Hans', 'zh-CN', 'ai-zh', 'zh-Hant', 'ai-en', 'en-US', 'en'];

export function pickSubtitle(subtitles, requested) {
  const usable = safeArray(subtitles).filter((item) => item && item.subtitle_url);
  if (!usable.length) return null;
  if (requested) {
    const exact = usable.find((item) => item.lan === requested) || usable.find((item) => item.lan?.startsWith(requested));
    if (exact) return exact;
  }
  for (const language of LANGUAGE_PRIORITY) {
    const match = usable.find((item) => item.lan === language);
    if (match) return match;
  }
  const zh = usable.find((item) => String(item.lan || '').includes('zh'));
  return zh || usable[0];
}

function normalizeSubtitleUrl(url) {
  if (!url) return '';
  if (url.startsWith('//')) return `https:${url}`;
  if (url.startsWith('http://')) return `https://${url.slice(7)}`;
  return url;
}

export async function fetchSubtitleJson(url, { timeoutMs = 20_000 } = {}) {
  const response = await fetch(normalizeSubtitleUrl(url), {
    headers: {
      'User-Agent':
        'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/155.0.0.0 Safari/537.36',
      Referer: 'https://www.bilibili.com/',
      Accept: 'application/json, text/plain, */*',
    },
    signal: AbortSignal.timeout(timeoutMs),
  });
  if (!response.ok) {
    throw new BiliError(`字幕下载失败 HTTP ${response.status}`, {
      endpoint: 'subtitle_url',
      hint: '字幕链接可能已过期；重新获取播放器信息即可。',
    });
  }
  return response.json();
}

export async function getTranscript(client, { bvid, aid, page = 1, lang } = {}) {
  const view = await getView(client, { bvid, aid });
  const selected = choosePage(view, page);
  if (!selected.cid) {
    throw new BiliError('视频没有可用的 cid，无法读取字幕', { endpoint: PLAYER_ENDPOINT });
  }
  const player = await client.getSigned(PLAYER_ENDPOINT, { bvid: view.bvid, cid: selected.cid }, { cacheTtl: 60_000 });
  const subtitles = safeArray(player.data?.subtitle?.subtitles);
  const available = subtitles.map((item) => ({
    lan: item.lan,
    label: item.lan_doc,
    locked: Boolean(item.is_lock),
    has_url: Boolean(item.subtitle_url),
  }));
  const selectedSubtitle = pickSubtitle(subtitles, lang);
  if (!selectedSubtitle) {
    return {
      bvid: view.bvid,
      cid: selected.cid,
      page: selected.page,
      available,
      has_subtitle: false,
      text: '',
      segments: [],
      hint: '该视频没有可用字幕（或字幕未解锁）。请改用 video_frames 截取关键帧来理解内容。',
    };
  }

  let payload;
  try {
    payload = await fetchSubtitleJson(selectedSubtitle.subtitle_url);
  } catch (error) {
    return {
      bvid: view.bvid,
      cid: selected.cid,
      page: selected.page,
      lang: selectedSubtitle.lan,
      label: selectedSubtitle.lan_doc,
      available,
      has_subtitle: true,
      text: '',
      segments: [],
      error: error.message,
      hint: '字幕链接可能已过期，请重试；若仍失败，改用 video_frames。',
    };
  }

  const segments = safeArray(payload.body).map((item) => ({
    from: Number(item.from) || 0,
    to: Number(item.to) || 0,
    content: String(item.content || '').trim(),
  }));
  const text = segments
    .map((segment) => segment.content)
    .filter(Boolean)
    .join('\n');
  return {
    bvid: view.bvid,
    cid: selected.cid,
    page: selected.page,
    lang: selectedSubtitle.lan,
    label: selectedSubtitle.lan_doc,
    available,
    has_subtitle: true,
    segments,
    text,
    char_count: text.length,
    source: 'bilibili_subtitle',
  };
}
