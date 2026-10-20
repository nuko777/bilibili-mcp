#!/usr/bin/env node
/**
 * Import cookies from a local file produced by agent-browser, a browser
 * extension, or a manual export. The agent only passes the file path; it does
 * not need to read or echo the cookie material.
 *
 * Usage:
 *   node scripts/import-cookie-file.mjs ./cookies.json --verify
 *   node scripts/import-cookie-file.mjs ./cookie-header.txt
 */
import process from 'node:process';
import { readCookieFile, saveCookies } from '../src/core/cookie-input.mjs';

const args = process.argv.slice(2).filter((item) => !item.startsWith('--'));
const flags = new Set(process.argv.slice(2).filter((item) => item.startsWith('--')));
const filePath = args[0];

if (!filePath) {
  process.stderr.write('用法: node scripts/import-cookie-file.mjs <cookies.json|cookie-header.txt> [--verify]\n');
  process.exit(1);
}

try {
  const cookies = await readCookieFile(filePath);
  const summary = await saveCookies(cookies, {
    verify: flags.has('--verify') || flags.has('--check'),
    source: 'agent-browser-file',
  });
  process.stdout.write(`${JSON.stringify(summary, null, 2)}\n`);
} catch (error) {
  process.stderr.write(`import-cookie 失败: ${error.message}\n`);
  process.exitCode = 1;
}
