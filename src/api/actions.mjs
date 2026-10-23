import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { BiliError } from '../core/errors.mjs';
import { getView, userInfo } from './videos.mjs';
import { resolveCommentTarget } from './comments.mjs';

function preview(action, target, details = {}, hint = '未执行任何写操作。将 confirm 设为 true 后才会真正执行。') {
  return {
    ok: true,
    dry_run: true,
    action,
    target,
    details,
    hint,
  };
}

async function videoTarget(client, { bvid, aid }) {
  const view = await getView(client, { bvid, aid });
  return {
    bvid: view.bvid,
    aid: String(view.aid),
    title: view.title,
    owner: view.owner?.name || '',
    url: `https://www.bilibili.com/video/${view.bvid}`,
  };
}

export async function likeVideo(client, { bvid, aid, like = true, confirm = false } = {}) {
  client.requireLogin();
  const target = await videoTarget(client, { bvid, aid });
  let current = null;
  try {
    const state = await client.get('https://api.bilibili.com/x/web-interface/archive/has/like', { aid: target.aid });
    current = Number(state.data) === 1;
  } catch {
    current = null;
  }
  const desired = Boolean(like);
  const details = { current_liked: current, desired_liked: desired };
  if (!confirm) return preview(desired ? 'like' : 'unlike', target, details);
  client.requireCsrf();
  const result = await client.postForm(
    'https://api.bilibili.com/x/web-interface/archive/like',
    { aid: target.aid, like: desired ? 1 : 2, csrf: client.csrf },
    { retry: 0, allowCodes: [65004, 65006] },
  );
  const already = [65004, 65006].includes(Number(result.code));
  return {
    ok: result.code === 0 || already,
    already,
    action: desired ? 'like' : 'unlike',
    target,
    result: { code: result.code, message: result.message },
    note: already
      ? 'B 站返回 65004/65006，表示目标状态已经生效（重复点赞/取消）。'
      : undefined,
  };
}

export async function coinVideo(client, { bvid, aid, multiply = 1, selectLike = false, confirm = false } = {}) {
  client.requireLogin();
  const target = await videoTarget(client, { bvid, aid });
  const count = Number(multiply);
  if (!Number.isInteger(count) || count < 1 || count > 2) {
    throw new BiliError('投币数量必须是 1 或 2', { code: -400, hint: 'multiply ∈ [1, 2]' });
  }
  let current = 0;
  try {
    const state = await client.get('https://api.bilibili.com/x/web-interface/archive/coins', { bvid: target.bvid });
    current = Number(state.data?.multiply) || 0;
  } catch {
    current = 0;
  }
  if (current + count > 2) {
    throw new BiliError(`该视频已投 ${current} 枚硬币，最多再投 ${Math.max(0, 2 - current)} 枚`, {
      code: -400,
      hint: 'B 站单个稿件最多投 2 枚硬币；不执行本次操作。',
    });
  }
  const details = {
    current_coins: current,
    will_add: count,
    select_like: Boolean(selectLike),
    warning: '投币会消耗账号硬币，且无法撤销。',
  };
  if (!confirm) return preview('coin', target, details, '投币不可撤销。确认余额与数量后，再设 confirm=true。');
  client.requireCsrf();
  const result = await client.postForm(
    'https://api.bilibili.com/x/web-interface/coin/add',
    { aid: target.aid, multiply: count, select_like: selectLike ? 1 : 0, csrf: client.csrf },
    { retry: 0 },
  );
  let balance = null;
  try {
    const nav = await client.get('https://api.bilibili.com/x/web-interface/nav', {}, { allowCodes: [0, -101] });
    balance = nav.data?.money ?? null;
  } catch {
    // ignore
  }
  return {
    ok: result.code === 0,
    action: 'coin',
    target,
    result: result.data || { code: result.code, message: result.message },
    coin_balance: balance,
  };
}

export async function favoriteVideo(
  client,
  { bvid, aid, folderId, favorite = true, confirm = false } = {},
) {
  client.requireLogin();
  const target = await videoTarget(client, { bvid, aid });
  if (!folderId) {
    const folders = await client.get('https://api.bilibili.com/x/v3/fav/folder/created/list-all', {
      up_mid: client.uid,
      type: 2,
      rid: 0,
    });
    const list = (folders.data?.list || []).map((folder) => ({
      id: String(folder.id),
      title: folder.title,
      count: folder.media_count,
    }));
    if (!confirm) {
      return {
        ok: true,
        dry_run: true,
        action: favorite ? 'favorite' : 'unfavorite',
        target,
        folders: list,
        hint: list.length
          ? '收藏需要选择 folder_id；把下面任一收藏夹的 id 作为 folder_id 传入。'
          : '当前账号没有可用收藏夹，请先在 B 站网页创建收藏夹。',
      };
    }
    throw new BiliError('收藏需要提供 folderId', {
      code: -400,
      hint: `可用收藏夹：${list.map((folder) => `${folder.title}(${folder.id})`).join('、') || '无'}`,
    });
  }
  let currentFavoured = null;
  try {
    const state = await client.get('https://api.bilibili.com/x/v2/fav/video/favoured', { aid: target.aid });
    currentFavoured = Boolean(state.data?.favoured);
  } catch {
    currentFavoured = null;
  }
  const details = {
    folder_id: String(folderId),
    current_favoured: currentFavoured,
    desired: favorite ? 'add' : 'remove',
  };
  if (!confirm) return preview(favorite ? 'favorite' : 'unfavorite', target, details);
  client.requireCsrf();
  const form = {
    rid: target.aid,
    type: 2,
    csrf: client.csrf,
    platform: 'web',
  };
  if (favorite) form.add_media_ids = String(folderId);
  else form.del_media_ids = String(folderId);
  const result = await client.postForm('https://api.bilibili.com/x/v3/fav/resource/deal', form, { retry: 0 });
  return {
    ok: result.code === 0,
    action: favorite ? 'favorite' : 'unfavorite',
    target,
    folder_id: String(folderId),
    result: result.data || { code: result.code, message: result.message },
  };
}

const MAX_IMAGE_BYTES = 10 * 1024 * 1024;
const MAX_TOTAL_IMAGE_BYTES = 25 * 1024 * 1024;

async function assertImageBatch(paths) {
  let total = 0;
  for (const filePath of paths) {
    const stat = await fs.stat(filePath).catch(() => null);
    if (!stat?.isFile()) throw new BiliError(`图片不存在或不是文件：${filePath}`, { code: -400 });
    if (stat.size > MAX_IMAGE_BYTES) {
      throw new BiliError(`单张图片过大（${(stat.size / 1024 / 1024).toFixed(1)}MB），上限 10MB`, { code: -400 });
    }
    total += stat.size;
  }
  if (total > MAX_TOTAL_IMAGE_BYTES) {
    throw new BiliError(`图片总量过大（${(total / 1024 / 1024).toFixed(1)}MB），单次上限 25MB`, { code: -400 });
  }
}

async function replyAuthorName(client, { oid, type, root, parent }) {
  const json = await client.get(
    'https://api.bilibili.com/x/v2/reply/reply',
    { oid, type, root: String(root), pn: 1, ps: 49 },
    { allowCodes: [0, -400], cacheTtl: 0 },
  );
  const rootReply = json.data?.root;
  if (String(parent) === String(root)) return rootReply?.member?.uname || '';
  const node = (json.data?.replies || []).find(
    (item) => String(item.rpid_str || item.rpid) === String(parent),
  );
  return node?.member?.uname || rootReply?.member?.uname || '';
}

export async function postComment(
  client,
  { bvid, aid, message, root, parent, dynamicId, imagePaths = [], mentionUserIds = [], confirm = false } = {},
) {
  client.requireLogin();
  const text = String(message ?? '').trim();
  if (!text) throw new BiliError('评论内容不能为空', { code: -400 });
  if (text.length > 1000) throw new BiliError('评论内容过长（最多 1000 字）', { code: -400 });
  const paths = Array.isArray(imagePaths) ? imagePaths.filter(Boolean) : imagePaths ? [imagePaths] : [];
  if (paths.length > 9) throw new BiliError('评论图片最多 9 张', { code: -400 });
  const mentionIds = [...new Set((Array.isArray(mentionUserIds) ? mentionUserIds : mentionUserIds ? [mentionUserIds] : []).map(String).filter(Boolean))];
  if (mentionIds.length > 10) throw new BiliError('单次最多 @ 10 个用户', { code: -400 });
  if (parent && !root) {
    throw new BiliError('提供 parent 时必须同时提供 root', { code: -400, hint: '回复二级评论需要根评论 rpid。' });
  }

  const resolved = await resolveCommentTarget(client, { bvid, aid, dynamicId });
  const target = resolved.target;
  const oid = resolved.oid;
  const type = resolved.type;
  const details = {
    oid,
    type,
    comment_oid: oid,
    comment_type: type,
    message: text,
    reply_to: root ? String(parent || root) : undefined,
    mention_user_ids: mentionIds.length ? mentionIds : undefined,
    root: root ? String(root) : undefined,
    parent: parent ? String(parent) : undefined,
    images: paths,
    warning: '评论会公开发布，且会以当前账号身份出现。',
  };
  if (!confirm) return preview('comment', target, details, '评论是公开内容。确认文案后再设 confirm=true。');
  client.requireCsrf();
  await assertImageBatch(paths);
  const mentions = [];
  for (const mid of mentionIds) {
    const user = await userInfo(client, { mid });
    mentions.push({ mid: String(user.mid || mid), name: user.name });
  }
  const atNameToMid = {};
  const mentionPrefix = mentions
    .filter((mention) => mention.name)
    .map((mention) => `@${mention.name} `)
    .join('');
  for (const mention of mentions) {
    const numericMid = Number(mention.mid);
    atNameToMid[mention.name] = Number.isSafeInteger(numericMid) ? numericMid : mention.mid;
  }
  let replyTo = null;
  let finalMessage = `${mentionPrefix}${text}`;
  if (root) {
    replyTo = await replyAuthorName(client, {
      oid,
      type,
      root,
      parent: parent || root,
    });
    if (!replyTo) {
      throw new BiliError('无法解析被回复评论的作者', {
        code: -400,
        hint: '父评论可能已删除；请检查 root/parent。',
      });
    }
    const replyPrefix = `回复 @${replyTo} : `;
    finalMessage = text.startsWith('回复 @') ? text : `${replyPrefix}${mentionPrefix}${text}`;
  }
  const pictures = [];
  for (const filePath of paths) pictures.push(await uploadDynamicImage(client, filePath));
  const form = {
    oid,
    type,
    message: finalMessage,
    csrf: client.csrf,
    plat: 1,
    gaia_source: 'main_web',
    statistics: JSON.stringify({ appId: 100, platform: 5 }),
    at_name_to_mid: JSON.stringify(atNameToMid),
  };
  if (pictures.length) form.pictures = JSON.stringify(pictures);
  if (root) form.root = String(root);
  if (parent) form.parent = String(parent);
  const result = await client.postForm('https://api.bilibili.com/x/v2/reply/add', form, { retry: 0 });
  const rpid = result.data?.rpid_str || result.data?.rpid || null;
  let state = null;
  let visible = null;
  if (rpid) {
    const threadRoot = root ? String(root) : String(rpid);
    for (let attempt = 0; attempt < 3; attempt += 1) {
      try {
        const info = await client.get(
          'https://api.bilibili.com/x/v2/reply/reply',
          { oid, type, root: threadRoot, pn: 1, ps: 20 },
          { allowCodes: [0, -400], cacheTtl: 0 },
        );
        const node =
          threadRoot === String(rpid)
            ? info.data?.root
            : (info.data?.replies || []).find((item) => String(item.rpid_str || item.rpid) === String(rpid));
        state = node?.state ?? info.data?.root?.state ?? null;
        visible = state === 0;
      } catch {
        state = null;
        visible = null;
      }
      if (state !== null) break;
      if (attempt < 2) await new Promise((resolve) => setTimeout(resolve, 600));
    }
  }
  return {
    ok: result.code === 0,
    action: 'comment',
    target,
    rpid: rpid ? String(rpid) : null,
    comment_oid: oid,
    comment_type: type,
    message: finalMessage,
    reply_to: replyTo || undefined,
    mentions: mentions.length ? mentions : undefined,
    pictures: pictures.length ? pictures : undefined,
    state,
    visible,
    visibility_unknown: state === null,
    result: { code: result.code, message: result.message },
    note:
      state === null
        ? '评论已提交，但暂时无法确认公开状态（visibility_unknown=true）；请稍后复查评论列表。'
        : state !== 0
          ? `评论已提交，但当前未出现在公开列表（state=${state}；state=17 通常为审核中/仅自己可见）。`
          : undefined,
  };
}

async function uploadDynamicImage(client, filePath) {
  const ext = path.extname(filePath).toLowerCase();
  if (!['.jpg', '.jpeg', '.png', '.gif'].includes(ext)) {
    throw new BiliError(`不支持的图片格式：${ext || '(无扩展名)'}`, {
      code: -400,
      hint: '动态图片仅支持 jpg / jpeg / png / gif。',
    });
  }
  const stat = await fs.stat(filePath).catch(() => null);
  if (!stat?.isFile()) throw new BiliError(`图片不存在或不是文件：${filePath}`, { code: -400 });
  if (stat.size > 10 * 1024 * 1024) {
    throw new BiliError(`图片过大（${(stat.size / 1024 / 1024).toFixed(1)}MB），上限 10MB`, { code: -400 });
  }
  const data = await fs.readFile(filePath);
  const isPng = data.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]));
  const isJpeg = data[0] === 0xff && data[1] === 0xd8 && data[2] === 0xff;
  const isGif = data.subarray(0, 6).toString('ascii') === 'GIF87a' || data.subarray(0, 6).toString('ascii') === 'GIF89a';
  if ((ext === '.png' && !isPng) || (['.jpg', '.jpeg'].includes(ext) && !isJpeg) || (ext === '.gif' && !isGif)) {
    throw new BiliError('图片内容与扩展名不匹配', { code: -400, hint: '请提供真实的 PNG/JPEG/GIF 文件。' });
  }
  const mime = ext === '.png' ? 'image/png' : ext === '.gif' ? 'image/gif' : 'image/jpeg';
  const safeName =
    path.basename(filePath).replace(/[^\w.\-]+/g, '_').replace(/["\r\n]/g, '_').slice(-120) || 'image';
  // Build multipart manually. Node's FormData/undici uses chunked encoding here, which
  // Bilibili's upload CSRF parser rejects with -111; an explicit Content-Length works.
  const boundary = `----WebKitFormBoundary${crypto.randomBytes(8).toString('hex')}`;
  const parts = [];
  const push = (value) => parts.push(Buffer.from(value));
  push(
    `--${boundary}\r\nContent-Disposition: form-data; name="file_up"; filename="${safeName}"\r\nContent-Type: ${mime}\r\n\r\n`,
  );
  parts.push(data);
  push('\r\n');
  for (const [name, value] of [
    ['biz', 'new_dyn'],
    ['category', 'daily'],
    ['csrf', client.csrf],
  ]) {
    push(`--${boundary}\r\nContent-Disposition: form-data; name="${name}"\r\n\r\n${value}\r\n`);
  }
  push(`--${boundary}--\r\n`);
  const body = Buffer.concat(parts);
  const result = await client.request('https://api.bilibili.com/x/dynamic/feed/draw/upload_bfs', {
    method: 'POST',
    body,
    headers: {
      'Content-Type': `multipart/form-data; boundary=${boundary}`,
      'Content-Length': String(body.length),
    },
    referer: 'https://t.bilibili.com/',
    retry: 0,
  });
  const image = result.data;
  if (!image?.image_url) throw new BiliError('动态图片上传失败', { endpoint: 'upload_bfs', details: result });
  return {
    img_src: image.image_url,
    img_width: image.image_width,
    img_height: image.image_height,
    img_size: image.img_size,
  };
}

export async function postDynamic(client, { text, imagePaths = [], confirm = false } = {}) {
  client.requireLogin();
  const content = String(text ?? '').trim();
  const paths = Array.isArray(imagePaths) ? imagePaths.filter(Boolean) : imagePaths ? [imagePaths] : [];
  if (!content && !paths.length) throw new BiliError('动态内容不能为空（文本或图片至少一项）', { code: -400 });
  if (content.length > 2000) throw new BiliError('动态文本过长（最多 2000 字）', { code: -400 });
  if (paths.length > 9) throw new BiliError('动态图片最多 9 张', { code: -400 });
  const details = {
    text: content,
    images: paths,
    scene: paths.length ? 2 : 1,
    warning: '动态会公开发布，且会以当前账号身份出现。',
  };
  if (!confirm) return preview('publish_dynamic', { uid: client.uid }, details, '动态是公开内容。确认文案后再设 confirm=true。');
  client.requireCsrf();
  await assertImageBatch(paths);

  const pics = [];
  for (const filePath of paths) {
    pics.push(await uploadDynamicImage(client, filePath));
  }
  const uploadId = `${client.uid}_${Math.floor(Date.now() / 1000)}_${crypto.randomInt(1000, 9999)}`;
  const dynReq = {
    content: {
      contents: content ? [{ raw_text: content, type: 1, biz_id: '' }] : [],
    },
    meta: { app_meta: { from: 'create.dynamic.web', mobi_app: 'web' } },
    scene: paths.length ? 2 : 1,
    upload_id: uploadId,
  };
  if (pics.length) dynReq.pics = pics;

  const result = await client.postJson(
    `https://api.bilibili.com/x/dynamic/feed/create/dyn?csrf=${encodeURIComponent(client.csrf)}`,
    { dyn_req: dynReq },
    { retry: 0 },
  );
  const dynamicId = result.data?.dyn_id_str || result.data?.dyn_id || result.data?.dynamic_id_str || null;
  return {
    ok: result.code === 0,
    action: 'publish_dynamic',
    dynamic_id: dynamicId ? String(dynamicId) : null,
    url: dynamicId ? `https://t.bilibili.com/${dynamicId}` : 'https://t.bilibili.com/',
    result: { code: result.code, message: result.message },
  };
}

export async function followUser(client, { mid, follow = true, confirm = false } = {}) {
  client.requireLogin();
  if (!mid) throw new BiliError('需要提供 mid', { code: -400 });
  if (String(mid) === client.uid) throw new BiliError('不能关注自己', { code: -400 });
  let attribute = null;
  try {
    const relation = await client.get('https://api.bilibili.com/x/relation', { fid: mid });
    attribute = relation.data?.attribute ?? null;
  } catch {
    attribute = null;
  }
  const details = {
    mid: String(mid),
    current_attribute: attribute,
    current_following: attribute === 2 || attribute === 6,
    desired_following: Boolean(follow),
  };
  if (!confirm) return preview(follow ? 'follow' : 'unfollow', { mid: String(mid) }, details);
  client.requireCsrf();
  const result = await client.postForm(
    'https://api.bilibili.com/x/relation/modify',
    { fid: String(mid), act: follow ? 1 : 2, re_src: 11, csrf: client.csrf },
    { retry: 0 },
  );
  return {
    ok: result.code === 0,
    action: follow ? 'follow' : 'unfollow',
    mid: String(mid),
    result: { code: result.code, message: result.message },
  };
}

export async function sendMessage(client, { receiverId, text, confirm = false } = {}) {
  client.requireLogin();
  client.requireCsrf();
  if (!receiverId) throw new BiliError('需要提供 receiverId', { code: -400 });
  const content = String(text ?? '').trim();
  if (!content) throw new BiliError('私信内容不能为空', { code: -400 });
  if (Buffer.byteLength(content, 'utf8') > 2000) {
    throw new BiliError('私信内容过长（最多 2000 字节）', { code: -400 });
  }
  const devSeed = `${client.uid}:${receiverId}:${content}:${Math.floor(Date.now() / 300000)}`;
  const devHash = crypto.createHash('sha1').update(devSeed).digest('hex');
  const devId = `${devHash.slice(0, 8)}-${devHash.slice(8, 12)}-${devHash.slice(12, 16)}-${devHash.slice(16, 20)}-${devHash.slice(20, 32)}`;
  const details = { receiver_id: String(receiverId), text: content, dev_id: devId };
  if (!confirm) return preview('send_message', { receiver_id: String(receiverId) }, details, '私信会立即发送给对方。确认后再设 confirm=true。');
  const timestamp = Math.floor(Date.now() / 1000);
  const result = await client.postSignedForm(
    'https://api.vc.bilibili.com/web_im/v1/web_im/send_msg',
    {
      'msg[sender_uid]': client.uid,
      'msg[receiver_id]': String(receiverId),
      'msg[receiver_type]': 1,
      'msg[msg_type]': 1,
      'msg[msg_status]': 0,
      'msg[dev_id]': devId,
      'msg[timestamp]': timestamp,
      'msg[new_face_version]': 0,
      'msg[content]': JSON.stringify({ content }),
      csrf: client.csrf,
      from_firework: 0,
      build: 0,
      mobi_app: 'web',
    },
    { query: { w_sender_uid: client.uid, w_receiver_id: String(receiverId), w_dev_id: devId }, retry: 0 },
  );
  return {
    ok: result.code === 0,
    action: 'send_message',
    receiver_id: String(receiverId),
    msg_key: result.data?.msg_key_str || result.data?.msg_key || null,
    result: { code: result.code, message: result.message },
  };
}
