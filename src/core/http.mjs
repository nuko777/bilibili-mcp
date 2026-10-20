import { BiliError, assertSuccess, hintForCode, hintForStatus } from './errors.mjs';
import { parseCookieHeader, serializeCookies } from './cookies.mjs';
import { buildQuery, encodeWbiValue, extractWbiKeys, signParams } from './wbi.mjs';

const DEFAULT_UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/155.0.0.0 Safari/537.36';

const HOST_REFERERS = {
  'api.bilibili.com': 'https://www.bilibili.com/',
  'api.vc.bilibili.com': 'https://message.bilibili.com/',
  'api.live.bilibili.com': 'https://live.bilibili.com/',
  'manga.bilibili.com': 'https://manga.bilibili.com/',
  'passport.bilibili.com': 'https://passport.bilibili.com/',
};

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function defaultReferer(url) {
  const host = new URL(url).hostname;
  if (HOST_REFERERS[host]) return HOST_REFERERS[host];
  if (host === 'bilibili.com' || host.endsWith('.bilibili.com')) return 'https://www.bilibili.com/';
  return 'https://www.bilibili.com/';
}

function normalizeParams(params) {
  const result = {};
  for (const [key, value] of Object.entries(params || {})) {
    if (value === undefined || value === null) continue;
    if (Array.isArray(value)) result[key] = value.join(',');
    else result[key] = value;
  }
  return result;
}

export class BiliClient {
  constructor(options = {}) {
    this.cookies = options.cookieHeader
      ? parseCookieHeader(options.cookieHeader)
      : { ...(options.cookies || {}) };
    this.userAgent = options.userAgent || DEFAULT_UA;
    this.minInterval = options.minInterval ?? 250;
    this.tagInterval = options.tagInterval ?? 350;
    this.timeoutMs = options.timeoutMs ?? 25_000;
    this.cache = new Map();
    this.lastRequestAt = 0;
    this.lastTagRequestAt = 0;
    this.wbi = null;
    this.wbiPromise = null;
    this.buvidPromise = null;
    this.debug = Boolean(options.debug);
  }

  get loggedIn() {
    return Boolean(this.cookies.SESSDATA && this.cookies.DedeUserID);
  }

  get uid() {
    return this.cookies.DedeUserID ? String(this.cookies.DedeUserID) : '';
  }

  get csrf() {
    return this.cookies.bili_jct || '';
  }

  requireCsrf() {
    if (!this.csrf) {
      throw new BiliError('缺少 bili_jct（CSRF Token），无法执行写操作', {
        code: -111,
        hint: hintForCode(-111),
      });
    }
    return this.csrf;
  }

  requireLogin() {
    if (!this.loggedIn) {
      throw new BiliError('尚未登录 B 站', {
        code: -101,
        hint: '请先运行 login_from_browser / bili login，或设置 BILI_COOKIE。',
      });
    }
  }

  setCookie(name, value) {
    if (name) this.cookies[name] = value;
  }

  get cookieHeader() {
    return serializeCookies(this.cookies);
  }

  log(...args) {
    if (this.debug) console.error('[bilibili-mcp]', ...args);
  }

  async throttle(minInterval = this.minInterval) {
    const now = Date.now();
    const target = Math.max(now, this.lastRequestAt + minInterval);
    const wait = target - now;
    this.lastRequestAt = target;
    if (wait > 0) await sleep(wait);
  }

  cacheGet(key) {
    const item = this.cache.get(key);
    if (!item) return null;
    if (item.expiresAt < Date.now()) {
      this.cache.delete(key);
      return null;
    }
    return item.value;
  }

  cacheSet(key, value, ttl = 0) {
    if (!ttl) return;
    this.cache.set(key, { value, expiresAt: Date.now() + ttl });
    if (this.cache.size > 200) {
      const oldest = [...this.cache.entries()].sort((a, b) => a[1].expiresAt - b[1].expiresAt)[0];
      if (oldest) this.cache.delete(oldest[0]);
    }
  }

  buildHeaders(url, extra = {}) {
    const referer = extra.referer || defaultReferer(url);
    const headers = {
      'User-Agent': this.userAgent,
      Referer: referer,
      Accept: 'application/json, text/plain, */*',
      'Accept-Language': 'zh-CN,zh;q=0.9,en;q=0.8',
      'X-Bili-Locale-Json': JSON.stringify({
        c_locale: { language: 'zh', script: 'Hans' },
        always_translate: false,
      }),
      ...extra.headers,
    };
    const cookie = extra.cookieHeader ?? this.cookieHeader;
    if (cookie) headers.Cookie = cookie;
    return headers;
  }

  async ensureBuvid() {
    if (this.cookies.buvid3) return;
    if (this.buvidPromise) return this.buvidPromise;
    this.buvidPromise = (async () => {
      try {
        const json = await this.request('https://api.bilibili.com/x/frontend/finger/spi', {
          method: 'GET',
          retry: 1,
          allowCodes: [0, -101],
          cookieHeader: '',
          skipBuvid: true,
        });
        const b3 = json?.data?.b_3;
        const b4 = json?.data?.b_4;
        if (b3) this.cookies.buvid3 = b3;
        if (b4) this.cookies.buvid4 = b4;
      } catch (error) {
        this.log('buvid 获取失败（可忽略）', error.message);
      }
    })();
    try {
      await this.buvidPromise;
    } finally {
      this.buvidPromise = null;
    }
  }

  async getWbiMixin(force = false) {
    if (!force && this.wbi && this.wbi.expiresAt > Date.now()) return this.wbi.mixinKey;
    if (this.wbiPromise) return this.wbiPromise;
    this.wbiPromise = (async () => {
      const json = await this.request('https://api.bilibili.com/x/web-interface/nav', {
        method: 'GET',
        allowCodes: [0, -101],
        cacheTtl: 0,
      });
      const keys = extractWbiKeys(json);
      this.wbi = { ...keys, expiresAt: Date.now() + 10 * 60_000 };
      return keys.mixinKey;
    })();
    try {
      return await this.wbiPromise;
    } finally {
      this.wbiPromise = null;
    }
  }

  async sign(params) {
    const mixinKey = await this.getWbiMixin();
    return signParams(normalizeParams(params), mixinKey);
  }

  async request(url, options = {}) {
    const {
      method = 'GET',
      params = {},
      form,
      json,
      body: rawBody,
      signed = false,
      retry = method === 'GET' || method === 'HEAD' ? 2 : 0,
      allowCodes = [],
      cacheTtl = 0,
      tagRequest = false,
      headers: extraHeaders,
      timeoutMs = this.timeoutMs,
      cookieHeader,
      referer,
    } = options;

    if (!options.skipBuvid) await this.ensureBuvid();

    const target = new URL(url);
    const existingParams = Object.fromEntries(target.searchParams.entries());
    let requestParams = normalizeParams({ ...existingParams, ...params });
    if (signed) {
      requestParams = await this.sign(requestParams);
      // Use the same encoder that was used for w_rid; URLSearchParams would
      // turn %20 into + and re-encode the characters stripped by WBI.
      // Keep w_rid last, matching the canonical WBI query layout.
      const { w_rid: wRid, ...signedBase } = requestParams;
      target.search = `${buildQuery(signedBase, { sort: true })}&w_rid=${encodeWbiValue(wRid)}`;
    } else {
      for (const [key, value] of Object.entries(requestParams)) {
        target.searchParams.set(key, value);
      }
    }

    const cacheKey = `${method} ${target.pathname}?${[...target.searchParams.entries()]
      .filter(([key]) => key !== 'w_rid' && key !== 'wts')
      .sort()
      .map(([key, value]) => `${key}=${value}`)
      .join('&')}`;
    if (method === 'GET' && cacheTtl) {
      const cached = this.cacheGet(cacheKey);
      if (cached) return cached;
    }

    const headers = this.buildHeaders(target.toString(), { headers: extraHeaders, cookieHeader, referer });
    if (method !== 'GET' && method !== 'HEAD') headers.Origin = new URL(referer || defaultReferer(target.toString())).origin;
    let payload;
    if (form !== undefined) {
      payload = new URLSearchParams(normalizeParams(form)).toString();
      headers['Content-Type'] = 'application/x-www-form-urlencoded; charset=UTF-8';
    } else if (json !== undefined) {
      payload = JSON.stringify(json);
      headers['Content-Type'] = 'application/json; charset=UTF-8';
    } else if (rawBody !== undefined) {
      payload = rawBody;
    }

    let lastError;
    for (let attempt = 0; attempt <= retry; attempt += 1) {
      if (tagRequest) {
        const now = Date.now();
        const targetTime = Math.max(now, this.lastTagRequestAt + this.tagInterval);
        this.lastTagRequestAt = targetTime;
        if (targetTime > now) await sleep(targetTime - now);
      }
      await this.throttle();
      let response;
      try {
        response = await fetch(target, {
          method,
          headers,
          body: method === 'GET' || method === 'HEAD' ? undefined : payload,
          redirect: 'follow',
          signal: AbortSignal.timeout(timeoutMs),
        });
      } catch (error) {
        lastError = new BiliError(`网络请求失败: ${error.message}`, {
          endpoint: target.pathname,
          hint: '检查网络连接或代理；B 站接口可能暂时不可用。',
        });
        if (attempt < retry) {
          await sleep(400 * 2 ** attempt);
          continue;
        }
        throw lastError;
      }

      const text = await response.text();
      let parsed;
      let parseError = false;
      try {
        parsed = text ? JSON.parse(text) : {};
      } catch {
        parsed = null;
        parseError = true;
      }

      if (!response.ok) {
        const allowed =
          parsed &&
          typeof parsed === 'object' &&
          parsed.code !== undefined &&
          allowCodes.map(String).includes(String(parsed.code));
        if (allowed) return parsed;
        lastError = new BiliError(`B 站返回 HTTP ${response.status}`, {
          status: response.status,
          endpoint: target.pathname,
          hint: hintForStatus(response.status),
          details: parsed || text.slice(0, 300),
        });
        if (response.status >= 500 && attempt < retry) {
          await sleep(600 * 2 ** attempt);
          continue;
        }
        throw lastError;
      }

      if (parseError) {
        throw new BiliError(`B 站返回了非 JSON 响应（HTTP ${response.status}）`, {
          status: response.status,
          endpoint: target.pathname,
          hint: '接口可能已变更或被风控；可稍后重试。',
          details: text.slice(0, 300),
        });
      }

      if (parsed && typeof parsed === 'object' && parsed.code !== undefined) {
        assertSuccess(parsed, target.pathname, { allowCodes });
      }

      if (method === 'GET' && cacheTtl) this.cacheSet(cacheKey, parsed, cacheTtl);
      return parsed;
    }
    throw lastError || new BiliError('请求失败', { endpoint: target.pathname });
  }

  async get(url, params = {}, options = {}) {
    return this.request(url, { ...options, method: 'GET', params });
  }

  /**
   * GET with WBI signature; retries once with a fresh mixin key on signature/risk errors.
   */
  async getSigned(url, params = {}, options = {}) {
    try {
      return await this.request(url, { ...options, method: 'GET', params, signed: true });
    } catch (error) {
      if (error instanceof BiliError && [-352, -403, -412].includes(Number(error.code))) {
        await this.getWbiMixin(true).catch(() => {});
        return this.request(url, { ...options, method: 'GET', params, signed: true, retry: 0 });
      }
      throw error;
    }
  }

  async postForm(url, form, options = {}) {
    return this.request(url, { ...options, method: 'POST', form });
  }

  async postJson(url, json, options = {}) {
    return this.request(url, { ...options, method: 'POST', json });
  }

  async postSignedForm(url, form, { query = {}, ...options } = {}) {
    return this.request(url, {
      ...options,
      method: 'POST',
      params: query,
      signed: true,
      form,
    });
  }
}

export async function createClient({ cookieHeader, ...options } = {}) {
  const client = new BiliClient({ cookieHeader, ...options });
  return client;
}
