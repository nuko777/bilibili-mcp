#!/usr/bin/env node
import process from 'node:process';
import { resolveBootstrapCookies, paths } from './core/config.mjs';
import { BiliClient } from './core/http.mjs';
import { userFacingError } from './core/errors.mjs';
import { runTool, tools, toolMap } from './tools/index.mjs';

function usage() {
  return `bili - Bilibili MCP 调试 CLI

用法:
  node src/cli.mjs tools
  node src/cli.mjs status
  node src/cli.mjs call <tool> [json-args]
  node src/cli.mjs rank [limit]
  node src/cli.mjs weekly [number] [limit]
  node src/cli.mjs video <bv/av/url>
  node src/cli.mjs transcript <bv/av/url> [lang]
  node src/cli.mjs frames <bv/av/url> [count]
  node src/cli.mjs search <keyword>

选项:
  --confirm        写操作真正执行（默认 dry-run）
  --json           输出原始 JSON（默认已是 JSON）

登录态:
  MCP 不提取登录态。请使用 bilibili-login skill，或设置 BILI_COOKIE，
  或运行 node scripts/save-cookie.mjs 从 stdin 写入 Cookie。

配置文件: ${paths().cookieFile}
`;
}

function parseArgs(argv) {
  const args = [];
  const flags = new Set();
  for (const item of argv) {
    if (item.startsWith('--')) flags.add(item.slice(2));
    else args.push(item);
  }
  return { args, flags };
}

function parseJsonArg(value) {
  if (!value) return {};
  try {
    return JSON.parse(value);
  } catch (error) {
    throw new Error(`JSON 参数解析失败: ${error.message}`);
  }
}

function printResult(result) {
  if (result === undefined || result === null) {
    process.stdout.write('{}\n');
    return;
  }
  if (typeof result === 'string') {
    process.stdout.write(`${result}\n`);
    return;
  }
  const { __images, ...payload } = result;
  process.stdout.write(`${JSON.stringify(payload, null, 2)}\n`);
  if (Array.isArray(__images) && __images.length) {
    process.stderr.write(`[bili] 附带 ${__images.length} 张图片（MCP 会以 image content 返回）\n`);
  }
}

async function main() {
  const { args, flags } = parseArgs(process.argv.slice(2));
  const command = args[0];
  if (!command || command === 'help' || flags.has('help')) {
    process.stderr.write(usage());
    return;
  }
  if (command === 'tools') {
    for (const tool of tools) {
      process.stdout.write(`${tool.name}\t${tool.description.split('\n')[0]}\n`);
    }
    return;
  }
  if (!toolMap.size) throw new Error('工具注册表为空');

  const bootstrap = await resolveBootstrapCookies();
  const client = new BiliClient({ cookieHeader: bootstrap.cookieHeader });
  const ctx = { client };
  process.stderr.write(`[bili] cookie source: ${bootstrap.source}\n`);

  const confirm = flags.has('confirm');
  let name;
  let toolArgs = {};
  switch (command) {
    case 'status':
      name = 'auth_status';
      break;
    case 'rank':
      name = 'rank_list';
      toolArgs = { limit: Number(args[1]) || 20 };
      break;
    case 'weekly':
      name = 'weekly_list';
      toolArgs = { number: args[1] ? Number(args[1]) : undefined, limit: Number(args[2]) || 50 };
      break;
    case 'video':
      name = 'video_info';
      toolArgs = { video: args[1] };
      break;
    case 'transcript':
      name = 'video_transcript';
      toolArgs = { video: args[1], lang: args[2] };
      break;
    case 'frames':
      name = 'video_frames';
      toolArgs = { video: args[1], count: Number(args[2]) || 3 };
      break;
    case 'search':
      name = 'search';
      toolArgs = { keyword: args.slice(1).join(' ') };
      break;
    case 'call':
      name = args[1];
      toolArgs = parseJsonArg(args[2]);
      break;
    default:
      throw new Error(`未知命令：${command}\n\n${usage()}`);
  }
  if (!toolMap.has(name)) throw new Error(`未知工具：${name}`);
  if (confirm) toolArgs.confirm = true;
  if (!toolArgs.video && ['video_info', 'video_transcript', 'video_frames'].includes(name)) {
    throw new Error('需要提供 BV 号、av 号或视频链接');
  }
  const result = await runTool(name, toolArgs, ctx);
  printResult(result);
}

main().catch((error) => {
  process.stderr.write(`${userFacingError(error)}\n`);
  process.exitCode = 1;
});
