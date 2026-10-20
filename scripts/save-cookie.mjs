#!/usr/bin/env node
/**
 * Save Bilibili login cookies from stdin. The MCP server never extracts login
 * state; this helper is intentionally outside the MCP process.
 *
 * Preferred local flow (no cookie in shell history):
 *   node scripts/save-cookie.mjs --verify
 *   <paste Cookie header, then Ctrl-D / Ctrl-Z>
 *
 * The command line contains no cookie. Use a local terminal, not an agent
 * transcript, when pasting the value.
 */
import process from 'node:process';
import { parseCookieInput, saveCookies } from '../src/core/cookie-input.mjs';

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

const args = new Set(process.argv.slice(2));
const verify = args.has('--verify') || args.has('--check');

try {
  const raw = await readStdin();
  const cookies = parseCookieInput(raw);
  const summary = await saveCookies(cookies, { verify, source: 'external-stdin' });
  process.stdout.write(`${JSON.stringify(summary, null, 2)}\n`);
} catch (error) {
  process.stderr.write(`save-cookie 失败: ${error.message}\n`);
  process.exitCode = 1;
}
