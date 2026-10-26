const BILIBILI_DOMAIN = 'bilibili.com';

export function isBilibiliDomain(domain) {
  if (!domain) return false;
  const normalized = String(domain).replace(/^\./, '').toLowerCase();
  return normalized === BILIBILI_DOMAIN || normalized.endsWith(`.${BILIBILI_DOMAIN}`);
}

export function parseCookieHeader(header) {
  const cookies = {};
  if (!header || typeof header !== 'string') return cookies;
  for (const part of header.split(';')) {
    const index = part.indexOf('=');
    if (index <= 0) continue;
    const name = part.slice(0, index).trim();
    const value = part.slice(index + 1).trim();
    if (!name) continue;
    cookies[name] = value;
  }
  return cookies;
}

export function serializeCookies(cookies) {
  return Object.entries(cookies || {})
    .filter(([name, value]) => name && value !== undefined && value !== null)
    .map(([name, value]) => `${name}=${value}`)
    .join('; ');
}

/**
 * Convert Chrome CDP cookie objects into a simple name -> value map.
 * Prefers the registrable `.bilibili.com` cookie when the same name appears
 * for several subdomains, and ignores expired cookies.
 */
export function normalizeCookieObjects(cookieObjects, { now = Date.now() } = {}) {
  const chosen = new Map();
  for (const cookie of cookieObjects || []) {
    if (!cookie || !cookie.name || !isBilibiliDomain(cookie.domain)) continue;
    const expires = Number(cookie.expires);
    if (Number.isFinite(expires) && expires > 0 && expires * 1000 < now) continue;
    const score = cookie.domain === `.${BILIBILI_DOMAIN}` ? 2 : cookie.domain === BILIBILI_DOMAIN ? 1 : 0;
    const previous = chosen.get(cookie.name);
    if (!previous) {
      chosen.set(cookie.name, { value: cookie.value, score, domain: cookie.domain });
      continue;
    }
    if (score > previous.score) {
      chosen.set(cookie.name, { value: cookie.value, score, domain: cookie.domain });
    }
  }
  return Object.fromEntries([...chosen.entries()].map(([name, item]) => [name, item.value]));
}

export const LOGIN_COOKIE_NAMES = ['SESSDATA', 'bili_jct', 'DedeUserID', 'DedeUserID__ckMd5', 'buvid3', 'buvid4'];

export function missingLoginCookies(cookies) {
  return LOGIN_COOKIE_NAMES.filter((name) => !cookies || !cookies[name]);
}
