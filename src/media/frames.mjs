import path from 'node:path';
import fs from 'node:fs/promises';
import { ensureDir, paths } from '../core/config.mjs';
import { resolveFrameTimes, safeArray } from '../core/format.mjs';
import { choosePage, getView } from '../api/videos.mjs';
import { getPlayInfo, getFrameSource } from './playurl.mjs';
import { cropSprite, DEFAULT_UA, findFfmpeg, grabFrame } from './ffmpeg.mjs';

function safeName(value) {
  return String(value || '').replace(/[^0-9A-Za-z_-]/g, '_');
}

async function download(url, file) {
  const response = await fetch(url, {
    headers: { 'User-Agent': DEFAULT_UA, Referer: 'https://www.bilibili.com/' },
    signal: AbortSignal.timeout(30_000),
  });
  if (!response.ok) throw new Error(`缩略图下载失败 HTTP ${response.status}`);
  const buffer = Buffer.from(await response.arrayBuffer());
  if (buffer.length < 1000) throw new Error('缩略图内容为空');
  if (buffer.length > 20 * 1024 * 1024) throw new Error('缩略图超过 20MB，拒绝写入');
  await fs.writeFile(file, buffer);
  return file;
}

async function videoshotFrames(client, { bvid, cid, frameTimes, outDir, width }) {
  const json = await client.get(
    'https://api.bilibili.com/x/player/videoshot',
    { bvid, cid, index: 1 },
    { cacheTtl: 5 * 60_000 },
  );
  const data = json.data;
  const images = safeArray(data?.image);
  if (!images.length) throw new Error('videoshot 没有返回缩略图');
  const spriteUrl = images[0].startsWith('//') ? `https:${images[0]}` : images[0];
  const spriteFile = path.join(outDir, 'videoshot-sprite.jpg');
  await download(spriteUrl, spriteFile);
  const xLen = Number(data.img_x_len) || 10;
  const yLen = Number(data.img_y_len) || 10;
  const cellWidth = Number(data.img_x_size) || 480;
  const cellHeight = Number(data.img_y_size) || 270;
  const indexList = safeArray(data.index).map((value) => Number(value)).filter((value) => Number.isFinite(value));
  const totalCells = Math.min(xLen * yLen, indexList.length || xLen * yLen);
  if (!findFfmpeg()) return { spriteFile, frames: [], spriteOnly: true };
  const frames = [];
  for (let i = 0; i < frameTimes.length; i += 1) {
    const time = frameTimes[i];
    let cell = indexList.length
      ? indexList.reduce((best, value, index) => (Math.abs(value - time) < Math.abs(indexList[best] - time) ? index : best), 0)
      : Math.min(i, totalCells - 1);
    if (cell >= totalCells) cell = totalCells - 1;
    const x = (cell % xLen) * cellWidth;
    const y = Math.floor(cell / xLen) * cellHeight;
    const output = path.join(outDir, `${String(i + 1).padStart(2, '0')}_${time.toFixed(1)}s.jpg`);
    const result = await cropSprite({
      sprite: spriteFile,
      output,
      x,
      y,
      width: cellWidth,
      height: cellHeight,
      scaleWidth: Math.max(320, Math.min(Number(width) || 960, 1920)),
    });
    frames.push({
      time,
      index_time: indexList[cell] ?? null,
      file: result.file,
      size: result.size,
      source: 'videoshot',
      cell: { x, y, width: cellWidth, height: cellHeight },
    });
  }
  return { spriteFile, frames };
}

export async function videoFrames(
  client,
  { bvid, aid, times, count = 3, width = 960, page = 1, maxHeight = 1080, fallback = true } = {},
) {
  const view = await getView(client, { bvid, aid });
  const selected = choosePage(view, page);
  const duration = selected.duration || Number(view.duration) || 0;
  const frameTimes = resolveFrameTimes({ times, count, duration });
  const deadline = Date.now() + 120_000;
  const bvidSafe = safeName(view.bvid);
  const outDir = path.join(paths().framesDir, `${bvidSafe}-${safeName(selected.cid)}`);
  await ensureDir(outDir);

  const errors = [];
  let playData = null;
  try {
    playData = await getPlayInfo(client, { bvid: view.bvid, cid: selected.cid, qn: 80, fourk: false });
  } catch (error) {
    errors.push(`playurl: ${error.message}`);
  }

  const frames = [];
  let source = null;
  if (playData) {
    try {
      source = getFrameSource(playData, { maxHeight, preferCodec: 'avc' });
    } catch (error) {
      errors.push(`stream: ${error.message}`);
    }
  }

  if (source) {
    for (let i = 0; i < frameTimes.length; i += 1) {
      if (Date.now() >= deadline) {
        errors.push('整体抽帧超时（120s）');
        break;
      }
      const time = frameTimes[i];
      const output = path.join(outDir, `${String(i + 1).padStart(2, '0')}_${time.toFixed(1)}s.jpg`);
      try {
        const remaining = Math.max(5000, Math.min(30_000, deadline - Date.now()));
        const result = await grabFrame({ url: source.url, time, output, width, timeoutMs: remaining });
        frames.push({ time, file: result.file, size: result.size, source: 'dash' });
      } catch (error) {
        errors.push(`frame@${time}s: ${error.message}`);
      }
    }
  }

  if (frames.length) {
    return {
      bvid: view.bvid,
      cid: selected.cid,
      title: view.title,
      page: selected.page,
      duration,
      times: frameTimes,
      source: 'dash',
      stream: source?.stream || null,
      frames,
      errors: errors.length ? errors : undefined,
      ffmpeg: findFfmpeg(),
    };
  }

  if (!fallback) {
    throw new Error(`关键帧截取失败：${errors.join(' | ')}`);
  }

  try {
    const fallbackResult = await videoshotFrames(client, {
      bvid: view.bvid,
      cid: selected.cid,
      frameTimes,
      outDir,
      width,
    });
    return {
      bvid: view.bvid,
      cid: selected.cid,
      title: view.title,
      page: selected.page,
      duration,
      times: frameTimes,
      source: 'videoshot',
      sprite: fallbackResult.spriteFile,
      frames: fallbackResult.frames,
      sprite_only: Boolean(fallbackResult.spriteOnly),
      errors: errors.length ? errors : undefined,
      hint: fallbackResult.spriteOnly
        ? '未找到 ffmpeg，无法裁切雪碧图；已返回整张缩略图雪碧图。安装 ffmpeg 后可返回单帧图片。'
        : 'DASH 抽帧失败，已回退到 B 站视频缩略图雪碧图（分辨率较低）。',
    };
  } catch (fallbackError) {
    throw new Error(
      `关键帧截取失败。DASH 错误：${errors.join(' | ')}；雪碧图错误：${fallbackError.message}`,
    );
  }
}

export async function imageFile(file, { maxBytes = 4 * 1024 * 1024 } = {}) {
  const data = await fs.readFile(file);
  if (data.length > maxBytes) throw new Error('图片超过返回上限');
  const ext = path.extname(file).toLowerCase();
  return {
    type: 'image',
    data: data.toString('base64'),
    mimeType: ext === '.png' ? 'image/png' : 'image/jpeg',
    name: path.basename(file),
  };
}

export async function framesAsImages(frames, { limit = 4 } = {}) {
  const selected = frames.slice(0, Math.max(1, Math.min(Number(limit) || 4, 6)));
  const images = [];
  let total = 0;
  for (const frame of selected) {
    try {
      const data = await fs.readFile(frame.file);
      if (data.length > 4 * 1024 * 1024) continue;
      if (total + data.length > 9 * 1024 * 1024) break;
      total += data.length;
      images.push({
        type: 'image',
        data: data.toString('base64'),
        mimeType: 'image/jpeg',
        name: path.basename(frame.file),
        time: frame.time,
      });
    } catch {
      // Skip unreadable frames; text metadata still contains the path.
    }
  }
  return images;
}
