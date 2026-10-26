import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

function createClient(env) {
  const child = spawn(process.execPath, [path.resolve('src/server.mjs')], {
    env: { ...process.env, BILI_COOKIE: '', ...env },
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  let buffer = '';
  let nextId = 0;
  const pending = new Map();
  const stderr = [];
  child.stderr.on('data', (chunk) => stderr.push(String(chunk)));
  child.stdout.on('data', (chunk) => {
    buffer += chunk;
    const lines = buffer.split('\n');
    buffer = lines.pop();
    for (const line of lines) {
      if (!line.trim()) continue;
      let message;
      try {
        message = JSON.parse(line);
      } catch {
        continue;
      }
      if (message.id !== undefined && pending.has(message.id)) {
        pending.get(message.id).resolve(message);
        pending.delete(message.id);
      }
    }
  });
  function send(method, params) {
    const id = ++nextId;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        pending.delete(id);
        reject(new Error(`timeout waiting for ${method}; stderr=${stderr.join('')}`));
      }, 10_000);
      pending.set(id, {
        resolve: (message) => {
          clearTimeout(timer);
          resolve(message);
        },
      });
      child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id, method, params })}\n`);
    });
  }
  return { child, send, stderr };
}

test('MCP handshake, tool discovery, tool errors and ping', async (t) => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'bili-mcp-test-'));
  const client = createClient({ BILI_CONFIG_DIR: dir, BILI_CACHE_DIR: path.join(dir, 'cache') });
  t.after(async () => {
    client.child.kill();
    await fs.rm(dir, { recursive: true, force: true });
  });

  const init = await client.send('initialize', {
    protocolVersion: '2025-06-18',
    capabilities: {},
    clientInfo: { name: 'unit-test', version: '0.0.0' },
  });
  assert.equal(init.jsonrpc, '2.0');
  assert.equal(init.result.protocolVersion, '2025-06-18');

  const old = await client.send('initialize', { protocolVersion: '1999-01-01', capabilities: {}, clientInfo: { name: 'old', version: '0' } });
  assert.equal(old.result.protocolVersion, '2025-06-18');
  assert.equal(init.result.serverInfo.name, 'bilibili-mcp');
  assert.equal(init.result.capabilities.tools.listChanged, false);
  assert.ok(init.result.instructions.includes('bilibili-login'));

  const list = await client.send('tools/list', {});
  assert.equal(list.result.tools.length, 43);
  const names = new Set(list.result.tools.map((tool) => tool.name));
  for (const expected of [
    'auth_status',
    'rank_list',
    'weekly_list',
    'video_info',
    'video_transcript',
    'video_frames',
    'comments',
    'like_video',
    'coin_video',
    'favorite_video',
    'post_comment',
    'delete_comment',
    'delete_dynamic',
    'like_comment',
    'top_dynamic',
    'update_profile',
    'post_dynamic',
    'recall_danmaku',
    'notifications',
    'messages',
    'list_followings',
    'list_favorites',
  ]) {
    assert.ok(names.has(expected), `missing tool ${expected}`);
  }
  const frames = list.result.tools.find((tool) => tool.name === 'video_frames');
  assert.equal(frames.inputSchema.required[0], 'video');
  assert.equal(frames.inputSchema.properties.video.type, 'string');
  assert.equal(frames.annotations.readOnlyHint, true);
  const coin = list.result.tools.find((tool) => tool.name === 'coin_video');
  assert.equal(coin.annotations.destructiveHint, true);
  assert.equal(coin.annotations.idempotentHint, false);
  const likeTool = list.result.tools.find((tool) => tool.name === 'like_video');
  assert.equal(likeTool.annotations.destructiveHint, false);
  assert.equal(likeTool.annotations.idempotentHint, true);

  const unknown = await client.send('tools/call', { name: 'nope', arguments: {} });
  assert.equal(unknown.result.isError, true);
  assert.ok(unknown.result.content[0].text.includes('未知工具'));

  const missingArg = await client.send('tools/call', { name: 'video_frames', arguments: {} });
  assert.equal(missingArg.result.isError, true);
  assert.ok(/需要提供|无法识别|缺少必填参数/.test(missingArg.result.content[0].text));

  const badBool = await client.send('tools/call', {
    name: 'like_video',
    arguments: { video: 'BV1xx411c7mD', like: 'false' },
  });
  assert.equal(badBool.result.isError, true);
  assert.match(badBool.result.content[0].text, /应为 boolean/);

  const ping = await client.send('ping', {});
  assert.deepEqual(ping.result, {});

  const resources = await client.send('resources/list', {});
  assert.deepEqual(resources.result, { resources: [] });

  client.child.stdin.end();
  await new Promise((resolve) => client.child.once('close', resolve));
});
