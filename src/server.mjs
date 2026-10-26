#!/usr/bin/env node
import process from 'node:process';
import readline from 'node:readline';
import fs from 'node:fs/promises';
import { paths, resolveBootstrapCookies } from './core/config.mjs';
import { BiliClient } from './core/http.mjs';
import { userFacingError } from './core/errors.mjs';
import { runTool, tools, toolMap } from './tools/index.mjs';
import {
  errorResult,
  jsonrpcError,
  jsonrpcResult,
  publicTool,
  SERVER_NAME,
  SERVER_VERSION,
  writeMessage,
} from './mcp/protocol.mjs';

const SUPPORTED_PROTOCOLS = ['2025-06-18', '2025-03-26', '2024-11-05'];
const READ_TOOLS = tools.filter((tool) => tool.annotations?.readOnlyHint).map((tool) => tool.name);
const WRITE_TOOLS = tools.filter((tool) => !tool.annotations?.readOnlyHint).map((tool) => tool.name);
const INSTRUCTIONS = `B站 MCP（${tools.length} 个工具）。使用前需由外部 agent/用户通过 bilibili-login skill 写入 Cookie；本 server 不提取登录态。
读取类：${READ_TOOLS.join(' / ')}。
写入类：${WRITE_TOOLS.join(' / ')}。
写入类工具默认 dry-run；只有 confirm=true 才会真正执行。投币不可撤销，发布评论/动态/私信是公开行为，执行前先向用户确认内容。
标签补齐是逐条请求，列表默认只补前 20 条；需要更少请求时设置 include_tags=false。`;

let client;
let cookieSource = 'none';
let cookieMtimeMs = 0;

async function cookieFileMtime() {
  const stat = await fs.stat(paths().cookieFile).catch(() => null);
  return stat?.mtimeMs || 0;
}

async function loadContext({ quiet = false } = {}) {
  try {
    const bootstrap = await resolveBootstrapCookies();
    cookieSource = bootstrap.source;
    client = new BiliClient({ cookieHeader: bootstrap.cookieHeader });
  } catch (error) {
    cookieSource = 'error';
    client = new BiliClient({ cookieHeader: '' });
    process.stderr.write(`[${SERVER_NAME}] cookie config error: ${error.message}\n`);
  }
  cookieMtimeMs = await cookieFileMtime();
  if (!quiet) {
    process.stderr.write(`[${SERVER_NAME}] cookies=${cookieSource}; tools=${tools.length}\n`);
  }
}

async function refreshContext() {
  // A full BILI_COOKIE is fixed for the process lifetime. Individual cookie
  // env vars are merged with cookies.json, so file changes must still reload.
  if (process.env.BILI_COOKIE && process.env.BILI_COOKIE.trim()) return;
  const mtime = await cookieFileMtime();
  if (mtime !== cookieMtimeMs) await loadContext({ quiet: true });
}

const ctx = {
  get client() {
    return client;
  },
  tools,
};

function toolPayload(result) {
  if (result === undefined || result === null) return { payload: null, images: [] };
  if (typeof result === 'string') return { payload: result, images: [] };
  const { __images, ...rest } = result;
  return { payload: rest, images: Array.isArray(__images) ? __images : [] };
}

async function handleToolCall(params) {
  const name = params?.name;
  if (!name || !toolMap.has(name)) {
    return errorResult(`未知工具：${name || '(空)'}。可用工具：${tools.map((tool) => tool.name).join(', ')}`);
  }
  try {
    await refreshContext();
    const result = await runTool(name, params?.arguments || {}, ctx);
    const { payload, images } = toolPayload(result);
    const content = [];
    if (typeof payload === 'string' && payload) {
      content.push({ type: 'text', text: payload });
    } else if (payload && Object.keys(payload).length) {
      content.push({ type: 'text', text: JSON.stringify(payload, null, 2) });
    }
    let imageBudget = 12 * 1024 * 1024; // base64 characters, ~9MB binary total
    let omittedImages = 0;
    for (const image of images) {
      if (!image?.data) continue;
      if (image.data.length > imageBudget) {
        omittedImages += 1;
        continue;
      }
      imageBudget -= image.data.length;
      content.push({
        type: 'image',
        data: image.data,
        mimeType: image.mimeType || 'image/jpeg',
      });
    }
    if (omittedImages > 0) {
      content.push({
        type: 'text',
        text: `（已省略 ${omittedImages} 张图片：单次返回图片体积上限约 12MB base64）`,
      });
    }
    if (!content.length) content.push({ type: 'text', text: '{}' });
    return { content };
  } catch (error) {
    return errorResult(userFacingError(error));
  }
}

async function handleRequest(message) {
  const { id, method, params } = message;
  if (message.jsonrpc !== '2.0' || typeof method !== 'string') {
    return jsonrpcError(id, -32600, 'Invalid Request');
  }

  if (method === 'initialize') {
    const requested = params?.protocolVersion;
    return jsonrpcResult(id, {
      protocolVersion: SUPPORTED_PROTOCOLS.includes(requested) ? requested : '2025-06-18',
      capabilities: { tools: { listChanged: false }, resources: {} },
      serverInfo: { name: SERVER_NAME, version: SERVER_VERSION },
      instructions: INSTRUCTIONS,
    });
  }

  if (method === 'ping') return jsonrpcResult(id, {});
  if (method === 'tools/list') return jsonrpcResult(id, { tools: tools.map(publicTool) });
  if (method === 'tools/call') return jsonrpcResult(id, await handleToolCall(params));
  if (method === 'resources/list') return jsonrpcResult(id, { resources: [] });
  if (method === 'resources/templates/list') return jsonrpcResult(id, { resourceTemplates: [] });
  if (method === 'prompts/list') return jsonrpcResult(id, { prompts: [] });
  if (method === 'logging/setLevel') return jsonrpcResult(id, {});
  if (method === 'completion/complete') return jsonrpcResult(id, { completion: { values: [] } });

  return jsonrpcError(id, -32601, `Method not found: ${method}`);
}

async function main() {
  await loadContext();

  const rl = readline.createInterface({ input: process.stdin, crlfDelay: Infinity });

  const handleLine = async (line) => {
    const trimmed = line.trim();
    if (!trimmed) return;
    let message;
    try {
      message = JSON.parse(trimmed);
    } catch {
      writeMessage(process.stdout, jsonrpcError(null, -32700, 'Parse error'));
      return;
    }

    if (Array.isArray(message)) {
      if (!message.length) {
        writeMessage(process.stdout, jsonrpcError(null, -32600, 'Invalid Request: empty batch'));
        return;
      }
      const responses = [];
      for (const item of message) {
        if (!item || typeof item !== 'object' || Array.isArray(item)) {
          responses.push(jsonrpcError(null, -32600, 'Invalid Request'));
          continue;
        }
        if (item.id === undefined) continue; // notification
        if (item.id === null) {
          responses.push(jsonrpcError(null, -32600, 'Invalid Request: id must not be null'));
          continue;
        }
        try {
          responses.push(await handleRequest(item));
        } catch (error) {
          responses.push(jsonrpcError(item.id, -32603, `Internal error: ${error.message}`));
        }
      }
      if (responses.length) writeMessage(process.stdout, responses);
      return;
    }

    if (!message || typeof message !== 'object') {
      writeMessage(process.stdout, jsonrpcError(null, -32600, 'Invalid Request'));
      return;
    }
    if (message.id === undefined) return; // notification
    if (message.id === null) {
      writeMessage(process.stdout, jsonrpcError(null, -32600, 'Invalid Request: id must not be null'));
      return;
    }
    try {
      writeMessage(process.stdout, await handleRequest(message));
    } catch (error) {
      writeMessage(process.stdout, jsonrpcError(message.id, -32603, `Internal error: ${error.message}`));
    }
  };

  rl.on('line', (line) => {
    handleLine(line).catch((error) => {
      process.stderr.write(`[${SERVER_NAME}] line error: ${error.message}\n`);
    });
  });

  const shutdown = async () => {
    rl.close();
    process.exit(0);
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
  rl.on('close', () => process.exit(0));
}

main().catch((error) => {
  process.stderr.write(`[${SERVER_NAME}] fatal: ${error.stack || error.message}\n`);
  process.exit(1);
});
