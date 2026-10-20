import { BiliError } from '../core/errors.mjs';
import { safeArray } from '../core/format.mjs';

const PLAYURL_ENDPOINT = 'https://api.bilibili.com/x/player/wbi/playurl';

const CODEC_NAMES = {
  7: 'avc',
  12: 'hevc',
  13: 'av1',
};

export function selectVideoStream(dash, { maxHeight = 1080, preferCodec = 'avc' } = {}) {
  const videos = safeArray(dash?.video);
  if (!videos.length) return null;
  const codecOrder = { avc: 0, hevc: 1, av1: 2 };
  const preferred = codecOrder[preferCodec] ?? 0;
  const max = Number(maxHeight) || 1080;
  const eligible = videos.filter((item) => Number(item.height) <= max);
  const pool = eligible.length ? eligible : videos;
  const sorted = [...pool].sort((a, b) => {
    const aCodec = codecOrder[CODEC_NAMES[a.codecid]] ?? 9;
    const bCodec = codecOrder[CODEC_NAMES[b.codecid]] ?? 9;
    const aPreferred = Math.abs(aCodec - preferred);
    const bPreferred = Math.abs(bCodec - preferred);
    if (aPreferred !== bPreferred) return aPreferred - bPreferred;
    if (Number(b.height) !== Number(a.height)) return Number(b.height) - Number(a.height);
    return Number(b.bandwidth) - Number(a.bandwidth);
  });
  return sorted[0] || null;
}

export function selectAudioStream(dash) {
  const audios = safeArray(dash?.audio);
  if (!audios.length) return null;
  return [...audios].sort((a, b) => Number(b.bandwidth) - Number(a.bandwidth))[0];
}

export function describeStream(stream) {
  if (!stream) return null;
  return {
    codec: CODEC_NAMES[stream.codecid] || String(stream.codecid || ''),
    codecs: stream.codecs || '',
    width: stream.width,
    height: stream.height,
    quality: stream.id || stream.quality,
    bandwidth: stream.bandwidth,
    mime_type: stream.mimeType || stream.mime_type || '',
  };
}

export async function getPlayInfo(client, { bvid, cid, qn = 80, fourk = false } = {}) {
  if (!bvid || !cid) throw new Error('需要 bvid 和 cid');
  const json = await client.getSigned(
    PLAYURL_ENDPOINT,
    { bvid, cid, qn, fnval: 4048, fnver: 0, fourk: fourk ? 1 : 0 },
    { cacheTtl: 60_000 },
  );
  const data = json.data || {};
  if (!data.dash && !data.durl) {
    throw new BiliError('该视频没有可用的播放流（可能需要大会员、付费或已下架）', {
      code: json.code,
      endpoint: PLAYURL_ENDPOINT,
      details: json,
    });
  }
  return data;
}

export function getFrameSource(data, { maxHeight = 1080, preferCodec = 'avc' } = {}) {
  const dash = data?.dash;
  const video = selectVideoStream(dash, { maxHeight, preferCodec });
  if (video?.baseUrl || video?.base_url) {
    return {
      kind: 'dash',
      url: video.baseUrl || video.base_url,
      backupUrls: safeArray(video.backupUrl || video.backup_url).filter(Boolean),
      stream: describeStream(video),
      audio: describeStream(selectAudioStream(dash)),
      duration: data?.timelength ? Number(data.timelength) / 1000 : 0,
    };
  }
  const durl = safeArray(data?.durl);
  if (durl[0]?.url) {
    return {
      kind: 'durl',
      url: durl[0].url,
      backupUrls: safeArray(durl[0].backup_url).filter(Boolean),
      stream: { quality: 0, format: 'durl', height: null },
      audio: null,
      duration: Number(durl[0].length) / 1000 || 0,
    };
  }
  throw new BiliError('未找到可用的视频流地址', { endpoint: PLAYURL_ENDPOINT });
}
