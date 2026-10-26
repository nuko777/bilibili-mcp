const BVID_RE = /BV[0-9A-Za-z]{10}/;

export function toHttps(url) {
  if (!url) return '';
  if (url.startsWith('//')) return `https:${url}`;
  if (url.startsWith('http://')) return `https://${url.slice(7)}`;
  return url;
}

export function stripHtml(value) {
  return String(value ?? '')
    .replace(/<[^>]*>/g, '')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/\s+/g, ' ')
    .trim();
}

export function truncate(value, length = 400) {
  const text = String(value ?? '');
  return text.length > length ? `${text.slice(0, length)}…` : text;
}

export function parseVideoRef(input) {
  if (input && typeof input === 'object') {
    if (input.bvid) {
      const value = String(input.bvid);
      // Only accept an exact BV id here. A full URL / av id / b23 short link
      // may be placed in the bvid field by tool wrappers, so parse it as a
      // string instead of trusting the field name.
      if (/^BV[0-9A-Za-z]{10}$/.test(value)) {
        return { bvid: value, aid: input.aid ? String(input.aid) : null };
      }
      try {
        return parseVideoRef(value);
      } catch {
        // Fall through to aid/url below.
      }
    }
    if (input.aid) return { bvid: null, aid: String(input.aid) };
    if (input.url) return parseVideoRef(input.url);
    throw new Error('需要提供 bvid、aid 或视频链接');
  }
  if (input === undefined || input === null || input === '') {
    throw new Error('需要提供 bvid、aid 或视频链接');
  }
  const raw = String(input).trim();
  const bvidMatch = raw.match(BVID_RE);
  if (bvidMatch) return { bvid: bvidMatch[0], aid: null };
  const avMatch = raw.match(/(?:^av|[/=]av)(\d+)/i);
  if (avMatch) return { bvid: null, aid: avMatch[1] };
  if (/^\d+$/.test(raw)) return { bvid: null, aid: raw };
  throw new Error(`无法识别的视频标识：${raw}（需要 BV 号、av 号或视频链接）`);
}

export function parseDuration(value) {
  if (typeof value === 'number') return Math.max(0, value);
  const text = String(value ?? '').trim();
  if (!text) return 0;
  if (/^\d+$/.test(text)) return Number(text);
  const parts = text.split(':').map(Number);
  if (parts.some((part) => !Number.isFinite(part))) return 0;
  return parts.reduce((total, part) => total * 60 + part, 0);
}

export function formatDuration(seconds) {
  const value = Number(seconds) || 0;
  const h = Math.floor(value / 3600);
  const m = Math.floor((value % 3600) / 60);
  const s = Math.floor(value % 60);
  if (h > 0) return `${h}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
  return `${m}:${String(s).padStart(2, '0')}`;
}

export function formatDate(timestamp) {
  if (!timestamp) return '';
  const ms = Number(timestamp) * 1000;
  if (!Number.isFinite(ms)) return '';
  const date = new Date(ms);
  const pad = (n) => String(n).padStart(2, '0');
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(
    date.getMinutes(),
  )}`;
}

export function normalizeOwner(owner) {
  if (!owner) return null;
  return {
    mid: owner.mid ? String(owner.mid) : null,
    name: owner.name || owner.uname || '',
    face: toHttps(owner.face || owner.avatar || ''),
  };
}

export function normalizeStat(stat) {
  if (!stat) return null;
  return {
    view: Number(stat.view) || 0,
    danmaku: Number(stat.danmaku) || 0,
    reply: Number(stat.reply) || 0,
    favorite: Number(stat.favorite) || 0,
    coin: Number(stat.coin) || 0,
    share: Number(stat.share) || 0,
    like: Number(stat.like) || 0,
  };
}

export function normalizeVideo(item, source = 'unknown') {
  if (!item) return null;
  const bvid = item.bvid || item.bv_id || null;
  const aid = item.aid || item.id || null;
  const owner = normalizeOwner(item.owner || item.upper || item.author);
  const rcmdReason = item.rcmd_reason;
  return {
    source,
    bvid: bvid ? String(bvid) : null,
    aid: aid ? String(aid) : null,
    title: stripHtml(item.title),
    url: bvid ? `https://www.bilibili.com/video/${bvid}` : aid ? `https://www.bilibili.com/video/av${aid}` : '',
    cover: toHttps(item.pic || item.cover || ''),
    duration: Number(item.duration) || 0,
    duration_text: formatDuration(item.duration),
    pubdate: item.pubdate || item.ctime || 0,
    pubdate_text: formatDate(item.pubdate || item.ctime),
    owner,
    stat: normalizeStat(item.stat),
    tname: item.tname || '',
    tid: item.tid || null,
    rid: item.rid || null,
    desc: truncate(stripHtml(item.desc || item.description || ''), 300),
    rcmd_reason: typeof rcmdReason === 'string' ? rcmdReason : rcmdReason?.content || '',
    short_link: item.short_link_v2 || item.short_link || '',
    tags: Array.isArray(item.tags) ? item.tags.map((tag) => tag.tag_name || tag.name).filter(Boolean) : [],
  };
}

export function normalizePage(page, index = 1) {
  return {
    page: Number(page.page) || index,
    cid: String(page.cid || ''),
    title: page.part || page.title || '',
    duration: Number(page.duration) || 0,
    duration_text: formatDuration(page.duration),
  };
}

export function parseTimeExpression(expression, duration) {
  if (typeof expression === 'number') {
    return Math.max(0, Math.min(expression, duration || expression));
  }
  const raw = String(expression).trim();
  if (raw.endsWith('%')) {
    const percent = Number(raw.slice(0, -1));
    if (!Number.isFinite(percent)) throw new Error(`无法解析时间百分比：${raw}`);
    return Math.max(0, Math.min((percent / 100) * (duration || 0), duration || Number.MAX_SAFE_INTEGER));
  }
  if (raw.includes(':')) {
    const parts = raw.split(':').map(Number);
    if (parts.some((part) => !Number.isFinite(part))) throw new Error(`无法解析时间：${raw}`);
    return parts.reduce((total, part) => total * 60 + part, 0);
  }
  const seconds = Number(raw);
  if (!Number.isFinite(seconds)) throw new Error(`无法解析时间：${raw}`);
  return Math.max(0, duration ? Math.min(seconds, duration) : seconds);
}

export function resolveFrameTimes({ times, count = 3, duration = 0, maxTimes = 12 } = {}) {
  const cap = Math.max(1, Math.min(Number(maxTimes) || 12, 100));
  const safeCount = Math.max(1, Math.min(Number(count) || 3, cap));
  const explicit = times !== undefined && times !== null && times !== '';
  let expressions = times;
  if (typeof expressions === 'string' && expressions.includes(',')) {
    expressions = expressions.split(',').map((part) => part.trim()).filter(Boolean);
  }
  if (!explicit) {
    const percents = [15, 50, 85, 30, 70, 5, 95, 40, 60];
    expressions = percents.slice(0, safeCount).map((percent) => `${percent}%`);
  }
  if (!Array.isArray(expressions)) expressions = [expressions];
  if (explicit && !expressions.length) throw new Error('times 不能为空数组');
  const limit = explicit ? Math.min(expressions.length, cap) : safeCount;
  const resolved = expressions.slice(0, limit).map((expression) => parseTimeExpression(expression, duration));
  return [...new Set(resolved.map((value) => Math.round(value * 1000) / 1000))].sort((a, b) => a - b);
}

export function chunk(array, size) {
  const result = [];
  for (let index = 0; index < array.length; index += size) result.push(array.slice(index, index + size));
  return result;
}

export function safeArray(value) {
  return Array.isArray(value) ? value : [];
}
