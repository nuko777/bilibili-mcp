import fs from 'node:fs/promises';
import { paths, writeStoredCookies } from './config.mjs';
import { missingLoginCookies, parseCookieHeader, serializeCookies } from './cookies.mjs';
import { BiliClient } from './http.mjs';

const MAX_COOKIE_LENGTH = 8192;

export function normalizeCookieMap(input) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) {
    throw new Error('Cookie 输入必须是对象或 Cookie 请求头字符串');
  }
  const cookies = {};
  for (const [name, value] of Object.entries(input)) {
    if (!/^[A-Za-z0-9_]+$/.test(name) || name.length > 64) continue;
    if (value === undefined || value === null) continue;
    const text = String(value);
    if (!text || text.length > MAX_COOKIE_LENGTH) continue;
    cookies[name] = text;
  }
  return cookies;
}

export function parseCookieInput(raw) {
  const trimmed = String(raw || '').trim();
  if (!trimmed) throw new Error('Cookie 输入为空');
  if (trimmed.startsWith('{')) {
    let parsed;
    try {
      parsed = JSON.parse(trimmed);
    } catch {
      throw new Error('Cookie JSON 格式错误');
    }
    if (parsed && typeof parsed === 'object' && parsed.cookies) return normalizeCookieMap(parsed.cookies);
    return normalizeCookieMap(parsed);
  }
  return normalizeCookieMap(parseCookieHeader(trimmed));
}

export async function readCookieFile(filePath) {
  const raw = await fs.readFile(filePath, 'utf8');
  return parseCookieInput(raw);
}

export async function verifyCookies(cookies) {
  const client = new BiliClient({ cookieHeader: serializeCookies(cookies) });
  const nav = await client.get('https://api.bilibili.com/x/web-interface/nav', {}, { allowCodes: [0, -101] });
  const isLogin = nav.code === 0 && Boolean(nav.data?.isLogin);
  return {
    ok: isLogin,
    is_login: isLogin,
    uname: nav.data?.uname || '',
    mid: nav.data?.mid ? String(nav.data.mid) : '',
    coins: nav.data?.money ?? null,
    level: nav.data?.level_info?.current_level ?? null,
  };
}

/**
 * Save cookies only after an optional verification succeeds. On failure the
 * existing cookie file is left untouched.
 */
export async function saveCookies(cookies, { verify = false, source = 'external' } = {}) {
  const normalized = normalizeCookieMap(cookies);
  if (!normalized.SESSDATA) {
    throw new Error('缺少 SESSDATA；请提供完整的 B 站 Cookie');
  }
  const missing = missingLoginCookies(normalized);
  let verification = null;
  if (verify) {
    verification = await verifyCookies(normalized);
    if (!verification.ok) {
      throw new Error('Cookie 验证失败：nav 未返回登录态');
    }
  }
  await writeStoredCookies(normalized, source);
  return {
    ok: true,
    path: paths().cookieFile,
    cookie_names: Object.keys(normalized).sort(),
    missing_recommended: missing,
    verify: verification || undefined,
    hint:
      missing.length
        ? '缺少部分推荐 Cookie；只读功能可能可用，写操作（点赞/投币/评论等）需要 bili_jct 与 DedeUserID。'
        : '登录态已写入，可调用 auth_status 校验。',
  };
}
