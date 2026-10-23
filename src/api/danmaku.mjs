import { BiliError } from '../core/errors.mjs';
import { getView } from './videos.mjs';

const DANMAKU_XML_ENDPOINT = 'https://api.bilibili.com/x/v1/dm/list.so';

function decodeXml(value) {
  return String(value)
    .replace(/&#x([0-9a-f]+);/gi, (_, hex) => String.fromCodePoint(parseInt(hex, 16)))
    .replace(/&#(\d+);/g, (_, num) => String.fromCodePoint(Number(num)))
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&amp;/g, '&');
}

function timeText(seconds) {
  const total = Math.max(0, Number(seconds) || 0);
  const minutes = Math.floor(total / 60);
  const rest = (total % 60).toFixed(1).padStart(4, '0');
  return `${minutes}:${rest}`;
}

export function parseDanmakuXml(xml) {
  const items = [];
  const re = /<d\s+p="([^"]*)"[^>]*>([\s\S]*?)<\/d>/g;
  let match;
  while ((match = re.exec(xml))) {
    const fields = match[1].split(',');
    const progress = Number(fields[0]) || 0;
    items.push({
      progress,
      time_text: timeText(progress),
      mode: Number(fields[1]) || 0,
      fontsize: Number(fields[2]) || 0,
      color: Number(fields[3]) || 0,
      ctime: Number(fields[4]) || 0,
      pool: Number(fields[5]) || 0,
      uid_hash: fields[6] || '',
      dmid: fields[7] || '',
      text: decodeXml(match[2]).trim(),
    });
  }
  return items.filter((item) => item.text);
}

export async function listDanmaku(client, { bvid, aid, limit = 100, keyword } = {}) {
  const view = await getView(client, { bvid, aid });
  const cid = view.cid;
  if (!cid) throw new BiliError('无法解析视频 cid', { code: -400 });
  const xml = await client.getText(
    DANMAKU_XML_ENDPOINT,
    { oid: String(cid) },
    { cacheTtl: 30_000, retry: 1 },
  );
  if (!xml.includes('<d')) {
    throw new BiliError('弹幕接口返回格式异常', {
      code: -400,
      endpoint: '/x/v1/dm/list.so',
      details: xml.slice(0, 300),
    });
  }
  const all = parseDanmakuXml(xml);
  const filtered = keyword
    ? all.filter((item) => item.text.includes(String(keyword)))
    : all;
  const safeLimit = Math.max(1, Math.min(Number(limit) || 100, 5000));
  return {
    bvid: view.bvid,
    aid: String(view.aid),
    cid: String(cid),
    title: view.title,
    total: filtered.length,
    returned: Math.min(filtered.length, safeLimit),
    keyword: keyword ? String(keyword) : undefined,
    items: filtered.slice(0, safeLimit),
  };
}
