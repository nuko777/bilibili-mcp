#!/usr/bin/env node
/**
 * Unified cookie filter for bilibili-mcp.
 *
 * Reads cookie material from stdin and prints a valid Cookie header by default.
 * Inputs may be:
 *   - agent-browser `cookies get` line output (one name=value per line)
 *   - a Cookie header string
 *   - canonical JSON `{ "cookies": { ... } }` (cookies.json has this shape)
 *
 * Options:
 *   --merge   merge stdin into the existing cookies.json before output
 *   --save    write the result to cookies.json (summary JSON, no cookie values)
 *   --json    print structured output instead of the Cookie header
 *   --verify  verify the final cookie set with nav before output/writing
 *
 * No temporary files are used. The cookie store path is the same one the MCP
 * uses: BILI_CONFIG_DIR or the platform config directory.
 */
import process from 'node:process';
import { paths, readStoredCookies, writeStoredCookies } from '../src/core/config.mjs';
import { parseCookiePayload, sanitizeCookieMap, verifyCookies } from '../src/core/cookie-input.mjs';
import { missingLoginCookies, serializeCookies } from '../src/core/cookies.mjs';
import { BiliClient } from '../src/core/http.mjs';
import { authStatus } from '../src/api/account.mjs';

function readStdin() {
  return new Promise((resolve, reject) => {
    let data = '';
    process.stdin.setEncoding('utf8');
    process.stdin.on('data', (chunk) => {
      data += chunk;
      if (data.length > 1_000_000) {
        reject(new Error('输入过大，拒绝处理'));
        process.stdin.destroy();
      }
    });
    process.stdin.on('end', () => resolve(data));
    process.stdin.on('error', reject);
  });
}

function usage() {
  return `用法:
  agent-browser cookies get | node scripts/cookie.mjs
  cat cookie-header.txt | node scripts/cookie.mjs
  cat cookies.json | node scripts/cookie.mjs
  node scripts/cookie.mjs --refresh-ticket

  node scripts/cookie.mjs --merge --save <<'JSON'
  { "cookies": { "bili_ticket": "...", "bili_ticket_expires": "..." } }
  JSON

选项:
  --refresh-ticket  单独使用：读取本地 cookies.json，调用 auth_status 刷新 bili_ticket 并写回（无需 stdin）
  --merge   合并到现有 cookies.json（否则视为全量）
  --save    写回 cookies.json（输出摘要，不输出 Cookie 值）
  --json    输出结构化 JSON（不保存时包含 cookies 与 cookie_header）
  --verify  写出前用 nav 校验登录态
  --help    显示本说明

输入:
  JSON 只接受 { "cookies": { ... } }；agent-browser 逐行输出和 Cookie 头可直接管道。
`;
}

const argv = process.argv.slice(2);
const flags = new Set(argv.filter((item) => item.startsWith('--')));
const positional = argv.filter((item) => !item.startsWith('--'));
const allowed = new Set(['--refresh-ticket', '--merge', '--save', '--json', '--verify', '--check', '--help']);
const unknown = [...flags].filter((flag) => !allowed.has(flag));

if (flags.has('--help')) {
  process.stderr.write(usage());
  process.exit(0);
}
if (positional.length) {
  process.stderr.write('cookie 失败: 只从 stdin 读取，不接受文件参数。用 cat file | node scripts/cookie.mjs\n');
  process.exit(1);
}
if (unknown.length) {
  process.stderr.write(`cookie 失败: 未知参数 ${unknown.join(', ')}；用 --help 查看用法\n`);
  process.exit(1);
}

const refreshTicket = flags.has('--refresh-ticket');
const merge = flags.has('--merge');
const save = flags.has('--save');
const json = flags.has('--json');
const verify = flags.has('--verify') || flags.has('--check');

if (refreshTicket && (merge || save || json || verify)) {
  console.error('cookie 失败: --refresh-ticket 需单独使用，不能与 --merge/--save/--json/--verify 组合');
  process.exit(1);
}

try {
  if (refreshTicket) {
    const stored = await readStoredCookies();
    if (!stored.cookies || !Object.keys(stored.cookies).length) {
      throw new Error('本地 cookies.json 不存在或为空；先做一次全量导入');
    }
    if (!stored.cookies.SESSDATA || !stored.cookies.DedeUserID) {
      throw new Error('本地 cookies.json 未登录；先运行 bilibili-login');
    }
    const client = new BiliClient({ cookieHeader: serializeCookies(stored.cookies) });
    const status = await authStatus(client, { forceTicketRefresh: true });
    if (!status.is_login) {
      throw new Error('auth_status 返回未登录；请重新登录后再试');
    }
    if (!status.cookie_update) {
      throw new Error(status.cookie_update_error || 'auth_status 未刷新 bili_ticket');
    }
    const refreshedCookies = {
      bili_ticket: client.cookies.bili_ticket,
      bili_ticket_expires: client.cookies.bili_ticket_expires,
    };
    if (!refreshedCookies.bili_ticket || !refreshedCookies.bili_ticket_expires) {
      throw new Error('auth_status 未返回新的 bili_ticket');
    }
    const sanitized = sanitizeCookieMap({ ...stored.cookies, ...refreshedCookies });
    const missing = missingLoginCookies(sanitized.cookies);
    const saved = await writeStoredCookies(sanitized.cookies, 'cookie-cli');
    process.stdout.write(`${JSON.stringify({
      ok: true,
      mode: 'refresh-ticket',
      path: paths().cookieFile,
      changed: Object.keys(refreshedCookies).sort(),
      total: Object.keys(sanitized.cookies).length,
      is_login: status.is_login,
      uname: status.uname,
      mid: status.mid,
      coins: status.coins,
      level: status.level,
      unread: status.unread,
      private_unread: status.private_unread,
      expires_at: status.cookie_update.expires_at,
      skipped: sanitized.skipped,
      missing_recommended: missing,
      savedAt: saved.savedAt,
      source: saved.source,
    }, null, 2)}\n`);
  } else {
    const raw = await readStdin();
    const parsed = parseCookiePayload(raw);
    const inputCookies = parsed.cookies;
    const changed = Object.keys(inputCookies).sort();
    if (!changed.length) throw new Error('没有解析到可用 Cookie');

    let cookies = inputCookies;
    let skipped = parsed.skipped;
    if (merge) {
      const stored = await readStoredCookies();
      if (!stored.cookies || !Object.keys(stored.cookies).length) {
        throw new Error('本地 cookies.json 不存在或为空；先做一次全量导入');
      }
      const sanitized = sanitizeCookieMap({ ...stored.cookies, ...inputCookies });
      cookies = sanitized.cookies;
      skipped = [...skipped, ...sanitized.skipped];
    }

    if (!Object.keys(cookies).length) throw new Error('合并后没有可用 Cookie');
    if (save && !cookies.SESSDATA) {
      throw new Error('缺少 SESSDATA，拒绝覆盖本地登录 Cookie');
    }

    let verification = null;
    if (verify) {
      verification = await verifyCookies(cookies);
      if (!verification.ok) throw new Error('Cookie 验证失败：nav 未返回登录态');
    }

    const missing = missingLoginCookies(cookies);
    let saved = null;
    if (save) saved = await writeStoredCookies(cookies, 'cookie-cli');

    const header = serializeCookies(cookies);
    if (save) {
      process.stdout.write(`${JSON.stringify({
        ok: true,
        mode: merge ? 'merge' : 'replace',
        path: paths().cookieFile,
        changed,
        total: Object.keys(cookies).length,
        skipped,
        missing_recommended: missing,
        verification: verification || undefined,
        savedAt: saved.savedAt,
        source: saved.source,
      }, null, 2)}\n`);
    } else if (json) {
      process.stdout.write(`${JSON.stringify({
        cookies,
        cookie_header: header,
        skipped,
        count: Object.keys(cookies).length,
        format: parsed.format,
        verification: verification || undefined,
      }, null, 2)}\n`);
    } else {
      process.stdout.write(`${header}\n`);
      if (skipped.length) {
        const names = skipped.map((item) => `${item.name || '?'}(${item.reason})`).join(', ');
        process.stderr.write(`skipped: ${names}\n`);
      }
      if (verification) {
        process.stderr.write(`verify: is_login=${verification.is_login} uname=${verification.uname}\n`);
      }
    }
  }
} catch (error) {
  process.stderr.write(`cookie 失败: ${error.message}\n`);
  process.exitCode = 1;
}
