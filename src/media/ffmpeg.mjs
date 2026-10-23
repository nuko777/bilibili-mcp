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

export async function grabFrame({ url, time, output, width = 960, height = null, timeoutMs = 45_000, referer = 'https://www.bilibili.com/' }) {
  const ffmpeg = await requireFfmpeg();
  await ensureDir(path.dirname(output));
  const scaleFilter = height
    ? `scale=-2:${Math.max(360, Math.min(Number(height) || 720, 2160))}`
    : `scale=${Math.max(320, Math.min(Number(width) || 960, 1920))}:-2`;
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
    scaleFilter,
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
    scaleFilter,
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

export async function findFont() {
  const candidates = [
    process.env.BILI_FONT,
    process.platform === 'win32' ? 'C:/Windows/Fonts/arialbd.ttf' : null,
    process.platform === 'win32' ? 'C:/Windows/Fonts/arial.ttf' : null,
    process.platform === 'win32' ? 'C:/Windows/Fonts/segoeuib.ttf' : null,
    '/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf',
    '/usr/share/fonts/truetype/liberation2/LiberationSans-Bold.ttf',
  ].filter(Boolean);
  for (const candidate of candidates) {
    try {
      await fs.access(candidate);
      return candidate;
    } catch {
      // try next
    }
  }
  return null;
}

function escapeFilterPath(value) {
  return String(value).replace(/\\/g, '/').replace(/:/g, '\\:').replace(/'/g, "\\'");
}

export async function composeGrid({
  files,
  output,
  columns = 3,
  rows = 3,
  labels = true,
  labelStart = 1,
  fontSize = 60,
  timeoutMs = 90_000,
}) {
  const ffmpeg = await requireFfmpeg();
  if (!files.length) throw new Error('没有可拼接的帧');
  if (files.length > columns * rows) {
    throw new Error(`网格最多 ${columns * rows} 帧，实际 ${files.length} 帧`);
  }
  await ensureDir(path.dirname(output));
  const layout = [];
  for (let index = 0; index < files.length; index += 1) {
    const row = Math.floor(index / columns);
    const col = index % columns;
    const x = col === 0 ? '0' : Array(col).fill('w0').join('+');
    const y = row === 0 ? '0' : Array(row).fill('h0').join('+');
    layout.push(`${x}_${y}`);
  }
  const font = labels ? await findFont() : null;
  if (files.length === 1) {
    if (font) {
      const fontPath = escapeFilterPath(font);
      const labelSize = Math.max(20, Math.min(Number(fontSize) || 60, 120));
      await runProcess(
        ffmpeg,
        [
          '-hide_banner', '-loglevel', 'error', '-i', files[0],
          '-vf', `drawtext=fontfile='${fontPath}':text='${labelStart}':fontcolor=white:fontsize=${labelSize}:x=24:y=24:box=1:boxcolor=black@0.35:boxborderw=8`,
          '-frames:v', '1', '-q:v', '4', '-y', output,
        ],
        { timeoutMs },
      );
    } else {
      await fs.copyFile(files[0], output);
    }
    const singleStat = await fs.stat(output).catch(() => null);
    if (!singleStat || singleStat.size < 1000) throw new Error('网格图片生成失败');
    return { file: output, size: singleStat.size, labels: Boolean(font) };
  }
  const inputs = files.flatMap((file) => ['-i', file]);
  let filter;
  if (font) {
    const fontPath = escapeFilterPath(font);
    const labelSize = Math.max(20, Math.min(Number(fontSize) || 60, 120));
    const parts = files.map((_, index) =>
      `[${index}:v]drawtext=fontfile='${fontPath}':text='${labelStart + index}':fontcolor=white:fontsize=${labelSize}:x=24:y=24:box=1:boxcolor=black@0.35:boxborderw=8[v${index}]`,
    );
    const labelsFilter = files.map((_, index) => `[v${index}]`).join('');
    filter = `${parts.join(';')};${labelsFilter}xstack=inputs=${files.length}:layout=${layout.join('|')}:fill=black`;
  } else {
    const inputLabels = files.map((_, index) => `[${index}:v]`).join('');
    filter = `${inputLabels}xstack=inputs=${files.length}:layout=${layout.join('|')}:fill=black`;
  }
  await runProcess(
    ffmpeg,
    [
      '-hide_banner',
      '-loglevel',
      'error',
      ...inputs,
      '-filter_complex',
      filter,
      '-frames:v',
      '1',
      '-q:v',
      '4',
      '-y',
      output,
    ],
    { timeoutMs },
  );
  const stat = await fs.stat(output).catch(() => null);
  if (!stat || stat.size < 1000) throw new Error('网格图片生成失败');
  return { file: output, size: stat.size, labels: Boolean(font) };
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
