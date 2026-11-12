import { parseCookieHeader, serializeCookies } from './cookies.mjs';
import { BiliClient } from './http.mjs';

const MAX_COOKIE_LENGTH = 8192;
const UNSAFE_COOKIE_VALUE = /["{};,\\\s\x00-\x1f\x7f]/;

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

/**
 * Normalize a cookie map and drop values that would break a Cookie header.
 * Only names and reasons are reported, never values.
 */
export function sanitizeCookieMap(input) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) {
    throw new Error('Cookie 数据必须是对象');
  }
  const cookies = {};
  const skipped = [];
  for (const [name, raw] of Object.entries(input)) {
    const value = raw === undefined || raw === null ? '' : String(raw).trim();
    if (!/^[A-Za-z0-9_]+$/.test(name) || name.length > 64) {
      skipped.push({ name, reason: 'invalid_name' });
      continue;
    }
    if (!value) {
      skipped.push({ name, reason: 'empty_value' });
      continue;
    }
    if (value.length > MAX_COOKIE_LENGTH) {
      skipped.push({ name, reason: 'value_too_long' });
      continue;
    }
    if (UNSAFE_COOKIE_VALUE.test(value)) {
      skipped.push({ name, reason: 'unsafe_value' });
      continue;
    }
    cookies[name] = value;
  }
  return { cookies, skipped };
}

/**
 * Unified stdin parser for scripts/cookie.mjs.
 *
 * Supported inputs:
 * - canonical JSON `{ "cookies": { ... } }` (cookies.json has this shape);
 * - a Cookie header string;
 * - agent-browser `cookies get` line output (one name=value per line).
 */
export function parseCookiePayload(raw) {
  const text = String(raw || '').trim().replace(/^cookie:\s*/i, '');
  if (!text) throw new Error('Cookie 输入为空');
  if (text.startsWith('{')) {
    let parsed;
    try {
      parsed = JSON.parse(text);
    } catch {
      throw new Error('Cookie JSON 格式错误');
    }
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      throw new Error('Cookie JSON 必须是对象');
    }
    if (!parsed.cookies || typeof parsed.cookies !== 'object' || Array.isArray(parsed.cookies)) {
      throw new Error('JSON 必须是 { "cookies": { ... } }；请传 cookies.json，或自己包一层 { cookies: ... }');
    }
    const { cookies, skipped } = sanitizeCookieMap(parsed.cookies);
    return { cookies, skipped, format: 'json' };
  }

  const lines = text.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
  if (lines.length > 1 && lines.every((line) => line.includes('=')) && !text.includes('; ')) {
    const { cookies, skipped } = parseAgentBrowserCookies(text);
    return { cookies, skipped, format: 'lines' };
  }

  const { cookies, skipped } = sanitizeCookieMap(parseCookieHeader(text));
  return { cookies, skipped, format: 'header' };
}

/**
 * Parse the line-oriented output of `agent-browser cookies get` (one
 * `name=value` per line). Values that would poison a Cookie header — quotes,
 * braces, separators or whitespace — are dropped, as is `bmg_af_sc`-style JSON.
 * Only names and reasons are reported, never the values.
 */
export function parseAgentBrowserCookies(raw) {
  const cookies = {};
  const skipped = [];
  String(raw || '').split(/\r?\n/).forEach((line, index) => {
    const text = line.trim();
    if (!text) return;
    const separator = text.indexOf('=');
    if (separator <= 0) {
      skipped.push({ line: index + 1, reason: 'malformed' });
      return;
    }
    const name = text.slice(0, separator).trim();
    const value = text.slice(separator + 1).trim();
    if (!/^[A-Za-z0-9_]+$/.test(name) || name.length > 64) {
      skipped.push({ line: index + 1, name, reason: 'invalid_name' });
      return;
    }
    if (!value) {
      skipped.push({ line: index + 1, name, reason: 'empty_value' });
      return;
    }
    if (value.length > MAX_COOKIE_LENGTH) {
      skipped.push({ line: index + 1, name, reason: 'value_too_long' });
      return;
    }
    if (UNSAFE_COOKIE_VALUE.test(value)) {
      skipped.push({ line: index + 1, name, reason: 'unsafe_value' });
      return;
    }
    cookies[name] = value;
  });
  return { cookies, skipped };
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
