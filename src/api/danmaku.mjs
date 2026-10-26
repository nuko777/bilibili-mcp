import { BiliError } from '../core/errors.mjs';
import { choosePage, getView } from './videos.mjs';

const DM_VIEW_ENDPOINT = 'https://api.bilibili.com/x/v2/dm/web/view';
const DM_SEG_ENDPOINT = 'https://api.bilibili.com/x/v2/dm/wbi/web/seg.so';
const DEFAULT_SEGMENT_MS = 6 * 60 * 1000;
const MAX_SEGMENTS = 100;

function timeText(seconds) {
  const totalTenths = Math.round(Math.max(0, Number(seconds) || 0) * 10);
  const minutes = Math.floor(totalTenths / 600);
  const rest = ((totalTenths % 600) / 10).toFixed(1).padStart(4, '0');
  return `${minutes}:${rest}`;
}

function readVarint(buffer, offset) {
  let value = 0n;
  let shift = 0n;
  let cursor = offset;
  while (cursor < buffer.length) {
    const byte = buffer[cursor];
    cursor += 1;
    value |= BigInt(byte & 0x7f) << shift;
    if ((byte & 0x80) === 0) return { value, offset: cursor };
    shift += 7n;
    if (shift > 70n) throw new Error('弹幕 protobuf varint 过长');
  }
  throw new Error('弹幕 protobuf varint 截断');
}

function walkFields(buffer, visit) {
  let offset = 0;
  while (offset < buffer.length) {
    const key = readVarint(buffer, offset);
    offset = key.offset;
    const field = Number(key.value >> 3n);
    const wire = Number(key.value & 7n);
    if (wire === 0) {
      const item = readVarint(buffer, offset);
      offset = item.offset;
      visit(field, wire, item.value);
    } else if (wire === 2) {
      const length = readVarint(buffer, offset);
      offset = length.offset;
      const end = offset + Number(length.value);
      if (end > buffer.length) throw new Error('弹幕 protobuf 字段越界');
      visit(field, wire, buffer.subarray(offset, end));
      offset = end;
    } else if (wire === 1) {
      if (offset + 8 > buffer.length) throw new Error('弹幕 protobuf fixed64 越界');
      visit(field, wire, buffer.subarray(offset, offset + 8));
      offset += 8;
    } else if (wire === 5) {
      if (offset + 4 > buffer.length) throw new Error('弹幕 protobuf fixed32 越界');
      visit(field, wire, buffer.subarray(offset, offset + 4));
      offset += 4;
    } else {
      throw new Error(`不支持的弹幕 protobuf wire type：${wire}`);
    }
  }
}

function decodeDanmakuElem(buffer) {
  let id = 0n;
  let progressMs = 0;
  let mode = 0;
  let fontsize = 0;
  let color = 0;
  let midHash = '';
  let content = '';
  let ctime = 0;
  let weight = 0;
  let pool = 0;
  let idStr = '';
  let attr = 0;
  walkFields(buffer, (field, wire, value) => {
    if (wire === 0) {
      if (field === 1) id = value;
      else if (field === 2) progressMs = Number(value);
      else if (field === 3) mode = Number(value);
      else if (field === 4) fontsize = Number(value);
      else if (field === 5) color = Number(value);
      else if (field === 8) ctime = Number(value);
      else if (field === 9) weight = Number(value);
      else if (field === 11) pool = Number(value);
      else if (field === 13) attr = Number(value);
    } else if (wire === 2) {
      if (field === 6) midHash = value.toString('utf8');
      else if (field === 7) content = value.toString('utf8');
      else if (field === 12) idStr = value.toString('utf8');
    }
  });
  const progress = Math.max(0, progressMs / 1000);
  const dmid = idStr || id.toString();
  return {
    progress,
    progress_ms: progressMs,
    time_text: timeText(progress),
    mode,
    fontsize,
    color,
    ctime,
    weight,
    pool,
    attr,
    uid_hash: midHash,
    dmid,
    text: content,
  };
}

export function decodeDanmakuSeg(buffer) {
  const items = [];
  walkFields(buffer, (field, wire, value) => {
    if (field === 1 && wire === 2) items.push(decodeDanmakuElem(value));
  });
  return items.filter((item) => item.text);
}

export function decodeDanmakuView(buffer) {
  let state = 0;
  let count = 0n;
  let pageSize = 0;
  let total = 0;
  walkFields(buffer, (field, wire, value) => {
    if (wire === 0) {
      if (field === 1) state = Number(value);
      else if (field === 8) count = value;
    } else if (wire === 2 && field === 4) {
      walkFields(value, (nestedField, nestedWire, nestedValue) => {
        if (nestedWire !== 0) return;
        if (nestedField === 1) pageSize = Number(nestedValue);
        else if (nestedField === 2) total = Number(nestedValue);
      });
    }
  });
  return { state, count: Number(count), pageSize, total };
}

async function fetchDanmakuView(client, { cid, aid, duration }) {
  const buffer = await client.getSigned(
    DM_VIEW_ENDPOINT,
    {
      type: 1,
      oid: String(cid),
      pid: String(aid),
      duration: Math.max(0, Math.round(Number(duration) || 0)),
      without_subtitle: true,
      web_location: 1315873,
    },
    { responseType: 'buffer', cacheTtl: 0 },
  );
  return decodeDanmakuView(buffer);
}

async function fetchDanmakuSegment(client, { cid, aid, index, pageSize }) {
  const size = Number(pageSize) > 0 ? Number(pageSize) : DEFAULT_SEGMENT_MS;
  const ps = (index - 1) * size;
  const pe = index * size;
  const buffer = await client.getSigned(
    DM_SEG_ENDPOINT,
    {
      type: 1,
      oid: String(cid),
      pid: String(aid),
      segment_index: index,
      pull_mode: 1,
      ps,
      pe,
      web_location: 1315873,
    },
    { responseType: 'buffer', cacheTtl: 0 },
  );
  return decodeDanmakuSeg(buffer);
}

export async function listDanmaku(client, { bvid, aid, limit = 100, keyword } = {}) {
  const view = await getView(client, { bvid, aid });
  const selected = choosePage(view, 1);
  const cid = selected.cid;
  if (!cid) throw new BiliError('无法解析视频 cid', { code: -400 });
  const safeLimit = Math.max(1, Math.min(Number(limit) || 100, 5000));
  const duration = Number(selected.duration) || Number(view.duration) || 0;
  const errors = [];
  let meta = { state: 0, count: 0, pageSize: DEFAULT_SEGMENT_MS, total: 0 };
  try {
    meta = await fetchDanmakuView(client, { cid, aid: view.aid, duration });
  } catch (error) {
    errors.push(`弹幕元数据: ${error.message}`);
  }
  const pageSize = meta.pageSize > 0 ? meta.pageSize : DEFAULT_SEGMENT_MS;
  const inferredSegments = duration > 0 ? Math.ceil((duration * 1000) / pageSize) : 1;
  const segmentCount = Math.max(
    1,
    Math.min(meta.total > 0 ? meta.total : inferredSegments, MAX_SEGMENTS),
  );
  const all = [];
  let segmentsFetched = 0;
  for (let index = 1; index <= segmentCount; index += 1) {
    try {
      const items = await fetchDanmakuSegment(client, {
        cid,
        aid: view.aid,
        index,
        pageSize,
      });
      all.push(...items);
      segmentsFetched += 1;
    } catch (error) {
      // Empty 6-minute segments return HTTP 404; they are not an error.
      if (error.status !== 404) errors.push(`segment ${index}: ${error.message}`);
    }
    if (!keyword && all.length >= safeLimit) break;
  }
  if (!all.length && errors.length) {
    throw new BiliError(`弹幕接口不可用：${errors.join('；')}`, {
      endpoint: DM_SEG_ENDPOINT,
      hint: 'B站弹幕接口可能调整，请稍后重试。',
    });
  }
  const filtered = keyword ? all.filter((item) => item.text.includes(String(keyword))) : all;
  return {
    bvid: view.bvid,
    aid: String(view.aid),
    cid: String(cid),
    title: view.title,
    source: 'x/v2/dm/wbi/web/seg.so',
    segment_count: segmentCount,
    segments_fetched: segmentsFetched,
    total: keyword ? filtered.length : Math.max(meta.count || 0, all.length),
    total_estimated: meta.count ? undefined : true,
    returned: Math.min(filtered.length, safeLimit),
    keyword: keyword ? String(keyword) : undefined,
    truncated: meta.total > MAX_SEGMENTS || inferredSegments > MAX_SEGMENTS ? true : undefined,
    errors: errors.length ? errors : undefined,
    items: filtered.slice(0, safeLimit),
  };
}
