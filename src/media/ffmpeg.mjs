import { spawn, spawnSync } from 'node:child_process';
import path from 'node:path';
import fs from 'node:fs/promises';
import { ensureDir } from '../core/config.mjs';

const DEFAULT_UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/155.0.0.0 Safari/537.36';

function which(binary) {
  try {
    const command = process.platform === 'win32' ? 'where' : 'which';
    const result = spawnSync(command, [binary], { encoding: 'utf8', windowsHide: true });
    if (result.status !== 0) return null;
    return (
      result.stdout
        .split(/\r?\n/)
        .map((line) => line.trim())
        .filter(Boolean)[0] || null
    );
  } catch {
    return null;
  }
}

export function findFfmpeg() {
  if (process.env.BILI_FFMPEG) return process.env.BILI_FFMPEG;
  const fromPath = which('ffmpeg');
  if (fromPath) return fromPath;
  const candidates =
    process.platform === 'win32'
      ? [
          'C:/ffmpeg/bin/ffmpeg.exe',
          'C:/Program Files/ffmpeg/bin/ffmpeg.exe',
        ]
      : ['/usr/bin/ffmpeg', '/usr/local/bin/ffmpeg', '/opt/homebrew/bin/ffmpeg'];
  for (const candidate of candidates) {
    try {
      const stat = spawnSync(candidate, ['-version'], { windowsHide: true, encoding: 'utf8' });
      if (stat.status === 0) return candidate;
    } catch {
      // try next
    }
  }
  return null;
}

export function findFfprobe() {
  if (process.env.BILI_FFPROBE) return process.env.BILI_FFPROBE;
  const fromPath = which('ffprobe');
  if (fromPath) return fromPath;
  const ffmpeg = findFfmpeg();
  if (ffmpeg) {
    const probe = path.join(path.dirname(ffmpeg), process.platform === 'win32' ? 'ffprobe.exe' : 'ffprobe');
    try {
      const result = spawnSync(probe, ['-version'], { windowsHide: true, encoding: 'utf8' });
      if (result.status === 0) return probe;
    } catch {
      // ignore
    }
  }
  return null;
}

export async function requireFfmpeg() {
  const binary = findFfmpeg();
  if (!binary) {
    throw new Error(
      '未找到 ffmpeg，无法截取视频关键帧。请安装 ffmpeg 并加入 PATH，或设置 BILI_FFMPEG 指向可执行文件。',
    );
  }
  return binary;
}

export function runProcess(command, args, { timeoutMs = 60_000, cwd } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { windowsHide: true, cwd });
    let stdout = '';
    let stderr = '';
    let settled = false;
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      child.kill('SIGKILL');
      reject(new Error(`命令超时（${timeoutMs}ms）：${path.basename(command)}`));
    }, timeoutMs);

    child.stdout.on('data', (chunk) => {
      stdout += chunk;
      if (stdout.length > 200_000) stdout = stdout.slice(-100_000);
    });
    child.stderr.on('data', (chunk) => {
      stderr += chunk;
      if (stderr.length > 200_000) stderr = stderr.slice(-100_000);
    });
    child.on('error', (error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      reject(error);
    });
    child.on('close', (code) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (code === 0) resolve({ code, stdout, stderr });
      else reject(new Error(`ffmpeg 退出码 ${code}: ${stderr.trim().slice(-600) || '无错误输出'}`));
    });
  });
}

export async function grabFrame({ url, time, output, width = 960, timeoutMs = 45_000, referer = 'https://www.bilibili.com/' }) {
  const ffmpeg = await requireFfmpeg();
  await ensureDir(path.dirname(output));
  const args = [
    '-hide_banner',
    '-loglevel',
    'error',
    '-rw_timeout',
    '20000000',
    '-ss',
    String(Math.max(0, Number(time) || 0)),
    '-i',
    url,
    '-frames:v',
    '1',
    '-vf',
    `scale=${Math.max(320, Math.min(Number(width) || 960, 1920))}:-2`,
    '-q:v',
    '3',
    '-y',
    output,
  ];
  const headers = `Referer: ${referer}\r\nUser-Agent: ${DEFAULT_UA}\r\n`;
  const withHeaders = [
    '-hide_banner',
    '-loglevel',
    'error',
    '-rw_timeout',
    '20000000',
    '-user_agent',
    DEFAULT_UA,
    '-headers',
    headers,
    '-ss',
    String(Math.max(0, Number(time) || 0)),
    '-i',
    url,
    '-frames:v',
    '1',
    '-vf',
    `scale=${Math.max(320, Math.min(Number(width) || 960, 1920))}:-2`,
    '-q:v',
    '3',
    '-y',
    output,
  ];
  const started = Date.now();
  try {
    await runProcess(ffmpeg, withHeaders, { timeoutMs });
  } catch (firstError) {
    // Retry without custom headers only if the first attempt failed quickly;
    // otherwise a second full timeout can blow the caller's deadline.
    if (Date.now() - started > 5000) throw firstError;
    const remaining = Math.max(3000, timeoutMs - (Date.now() - started));
    try {
      await runProcess(ffmpeg, args, { timeoutMs: remaining });
    } catch {
      throw firstError;
    }
  }
  const stat = await fs.stat(output).catch(() => null);
  if (!stat || stat.size < 1000) {
    throw new Error('ffmpeg 未生成有效的图片文件');
  }
  return { file: output, size: stat.size };
}

export async function cropSprite({
  sprite,
  output,
  x,
  y,
  width,
  height,
  scaleWidth = 960,
  timeoutMs = 30_000,
}) {
  const ffmpeg = await requireFfmpeg();
  await ensureDir(path.dirname(output));
  const filter = `crop=${width}:${height}:${x}:${y},scale=${scaleWidth}:-2`;
  await runProcess(
    ffmpeg,
    ['-hide_banner', '-loglevel', 'error', '-i', sprite, '-frames:v', '1', '-vf', filter, '-q:v', '3', '-y', output],
    { timeoutMs },
  );
  const stat = await fs.stat(output).catch(() => null);
  if (!stat || stat.size < 500) throw new Error('雪碧图裁切失败');
  return { file: output, size: stat.size };
}

export { DEFAULT_UA };
