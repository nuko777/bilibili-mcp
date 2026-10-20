import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs/promises';

const APP_DIR = 'bilibili-mcp';

export function defaultConfigDir() {
  if (process.env.BILI_CONFIG_DIR) {
    return path.resolve(process.env.BILI_CONFIG_DIR);
  }
  if (process.platform === 'win32') {
    return path.join(process.env.APPDATA || path.join(os.homedir(), 'AppData', 'Roaming'), APP_DIR);
  }
  return path.join(os.homedir(), '.config', APP_DIR);
}

export function defaultCacheDir() {
  if (process.env.BILI_CACHE_DIR) {
    return path.resolve(process.env.BILI_CACHE_DIR);
  }
  if (process.platform === 'win32') {
    return path.join(process.env.LOCALAPPDATA || path.join(os.homedir(), 'AppData', 'Local'), APP_DIR, 'cache');
  }
  return path.join(os.homedir(), '.cache', APP_DIR);
}

export function paths() {
  const configDir = defaultConfigDir();
  return {
    configDir,
    cookieFile: path.join(configDir, 'cookies.json'),
    cacheDir: defaultCacheDir(),
    framesDir: path.join(defaultCacheDir(), 'frames'),
  };
}

export async function ensureDir(dir) {
  await fs.mkdir(dir, { recursive: true });
}

export async function readStoredCookies() {
  const { cookieFile } = paths();
  let raw;
  try {
    raw = await fs.readFile(cookieFile, 'utf8');
  } catch (error) {
    if (error.code === 'ENOENT') return { cookies: {}, savedAt: null, source: 'none' };
    throw new Error(`无法读取 Cookie 文件：${cookieFile}`);
  }

  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch {
    // Do not include the parser message: Node can echo a fragment of the file,
    // which would put cookie material into logs.
    throw new Error(`Cookie 文件 JSON 格式错误：${cookieFile}`);
  }

  if (parsed && typeof parsed === 'object' && parsed.cookies && typeof parsed.cookies === 'object') {
    return {
      cookies: parsed.cookies,
      savedAt: parsed.savedAt || null,
      source: parsed.source || 'file',
    };
  }
  if (parsed && typeof parsed === 'object') {
    return { cookies: parsed, savedAt: null, source: 'file-legacy' };
  }
  throw new Error(`Cookie 文件内容不合法：${cookieFile}`);
}

export async function writeStoredCookies(cookies, source = 'external') {
  const { configDir, cookieFile } = paths();
  await ensureDir(configDir);
  const payload = {
    version: 1,
    savedAt: new Date().toISOString(),
    source,
    cookies: Object.fromEntries(Object.entries(cookies).sort(([a], [b]) => a.localeCompare(b))),
  };
  const tmp = `${cookieFile}.${process.pid}.tmp`;
  try {
    await fs.writeFile(tmp, `${JSON.stringify(payload, null, 2)}\n`, { mode: 0o600 });
    await fs.rename(tmp, cookieFile);
  } finally {
    await fs.unlink(tmp).catch(() => {});
  }
  try {
    await fs.chmod(cookieFile, 0o600);
  } catch {
    // Windows does not always honor POSIX modes; the file still lives under the user profile.
  }
  return payload;
}

export async function clearStoredCookies() {
  const { cookieFile } = paths();
  try {
    await fs.unlink(cookieFile);
    return true;
  } catch (error) {
    if (error.code === 'ENOENT') return false;
    throw error;
  }
}

export function envCookieParts() {
  const names = {
    SESSDATA: 'BILI_SESSDATA',
    bili_jct: 'BILI_JCT',
    DedeUserID: 'BILI_DEDEUSERID',
    buvid3: 'BILI_BUVID3',
    buvid4: 'BILI_BUVID4',
  };
  const parts = {};
  for (const [name, envName] of Object.entries(names)) {
    const value = process.env[envName];
    if (value && value.trim()) parts[name] = value.trim();
  }
  return parts;
}

export function envCookieHeader() {
  if (process.env.BILI_COOKIE && process.env.BILI_COOKIE.trim()) {
    return process.env.BILI_COOKIE.trim();
  }
  return Object.entries(envCookieParts())
    .map(([name, value]) => `${name}=${value}`)
    .join('; ');
}

export async function resolveBootstrapCookies() {
  const fullEnv = process.env.BILI_COOKIE && process.env.BILI_COOKIE.trim();
  if (fullEnv) {
    return { cookieHeader: fullEnv, source: 'env', savedAt: null };
  }

  const envParts = envCookieParts();
  const stored = await readStoredCookies();
  const merged = { ...(stored.cookies || {}), ...envParts };
  const entries = Object.entries(merged);
  if (!entries.length) {
    return { cookieHeader: '', source: 'none', savedAt: null };
  }
  return {
    cookieHeader: entries.map(([key, value]) => `${key}=${value}`).join('; '),
    source: Object.keys(envParts).length ? (stored.cookies && Object.keys(stored.cookies).length ? 'env+file' : 'env') : stored.source,
    savedAt: stored.savedAt,
  };
}
