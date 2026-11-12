#!/usr/bin/env node
/**
 * One-command image comment poster for the `agent-browser` CLI (Linux friendly).
 *
 *   node scripts/post-image-comment.mjs \
 *     --url https://www.bilibili.com/video/BV.../ \
 *     --image /path/to/comment.png \
 *     --text "@汐儿不是鱼 喵"
 *
 * It reads the MCP cookie file, injects the login cookies into agent-browser,
 * opens the page, builds the page script + base64 in memory (no shell
 * escaping), pipes it through `agent-browser eval --stdin`, then polls
 * window.__biliResult internally. Output includes rpid and has_image.
 */
import fs from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';
import { spawn } from 'node:child_process';
import { paths, readStoredCookies } from '../src/core/config.mjs';
import { LOGIN_COOKIE_NAMES, parseCookieHeader } from '../src/core/cookies.mjs';
import { parseCookieInput } from '../src/core/cookie-input.mjs';

const PAGE_SCRIPT_SOURCE = "/**\n * B站图片评论：在“已登录的浏览器页面”里执行，不调用评论 API。\n *\n * 用法（agent browser 的页面执行能力）：\n *   1. 打开视频页或动态页，例如 https://www.bilibili.com/opus/1262836254683168775\n *   2. 把本文件内容注入页面\n *   3. 执行：\n *        await window.postBiliImageComment({\n *          text: \"喵\",\n *          imageBase64: \"<图片的 base64，可带 data:image/png;base64, 前缀>\",\n *          imageName: \"7.png\",\n *          imageType: \"image/png\",\n *        })\n *\n * 只接受 imageBase64；本地文件由 agent 读成 base64 后传入。\n * 返回 { ok, rpid, link, state, text, image, has_image, picture_count, pictures }。失败会 throw Error。\n *\n * 说明：B站网页评论请求带 b_wet / x-bili-metadata-gaia-bin 等浏览器风控 token，\n * 纯 API 图片评论可能仅自己可见，因此图片评论应走本脚本。\n */\n(function installPostBiliImageComment() {\n  const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));\n\n  function deepQueryAll(root, selector, out = []) {\n    if (!root) return out;\n    for (const el of root.querySelectorAll(selector)) out.push(el);\n    for (const el of root.querySelectorAll('*')) {\n      if (el.shadowRoot) deepQueryAll(el.shadowRoot, selector, out);\n    }\n    return out;\n  }\n\n  function deepQuery(root, selector) {\n    return deepQueryAll(root, selector)[0] || null;\n  }\n\n  function visible(el) {\n    if (!el) return false;\n    const rect = el.getBoundingClientRect();\n    return rect.width > 0 && rect.height > 0;\n  }\n\n  function findCommentHost() {\n    // 视频页：#commentapp 里的 bili-comments；动态/opus：.bili-comment-container 里的 bili-comments。\n    return document.querySelector('#commentapp bili-comments')\n      || document.querySelector('.bili-comment-container bili-comments')\n      || document.querySelector('bili-comments');\n  }\n\n  function findCommentBox(host) {\n    const boxes = deepQueryAll(host.shadowRoot, 'bili-comment-box');\n    return boxes.find((box) => {\n      const editor = deepQuery(box.shadowRoot, '.brt-editor');\n      return visible(editor);\n    }) || boxes[0] || null;\n  }\n\n  async function activateBox(box) {\n    if (!box?.shadowRoot) throw new Error('评论区组件尚未加载');\n    // 动态页的评论框在 header shadow 里，初始 footer 是 hidden 的；点一下编辑区激活。\n    const editorArea = box.shadowRoot.querySelector('#editor')\n      || box.shadowRoot.querySelector('bili-comment-rich-textarea');\n    if (editorArea) editorArea.click();\n    await sleep(600);\n    const editor = deepQuery(box.shadowRoot, '.brt-editor');\n    if (!editor) throw new Error('找不到评论输入框（.brt-editor）');\n    editor.click();\n    await sleep(300);\n    return editor;\n  }\n\n  function setEditorText(editor, text) {\n    editor.focus();\n    try {\n      document.execCommand('selectAll', false, null);\n      document.execCommand('insertText', false, text);\n    } catch {\n      // Fall through to the DOM fallback below.\n    }\n    if ((editor.textContent || '').trim() !== text) {\n      editor.textContent = text;\n      for (const type of ['beforeinput', 'input', 'keyup']) {\n        try {\n          if (type === 'keyup') {\n            editor.dispatchEvent(new KeyboardEvent(type, { bubbles: true, key: 'a' }));\n          } else {\n            editor.dispatchEvent(new InputEvent(type, {\n              bubbles: true,\n              inputType: 'insertText',\n              data: text,\n            }));\n          }\n        } catch {\n          // Ignore event-constructor differences in older browsers.\n        }\n      }\n    }\n  }\n\n  async function base64ToFile({ imageBase64, imageName, imageType }) {\n    if (!imageBase64) throw new Error('需要 imageBase64');\n    const clean = String(imageBase64).replace(/^data:[^,]+,/, '');\n    const binary = atob(clean);\n    const bytes = new Uint8Array(binary.length);\n    for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i);\n    const blob = new Blob([bytes], { type: imageType || 'image/png' });\n    return new File([blob], imageName || 'image.png', {\n      type: imageType || 'image/png',\n    });\n  }\n\n  function findImageButton(box) {\n    const buttons = [...(box.shadowRoot?.querySelectorAll('#footer button.tool-btn') || [])];\n    // Prefer the button carrying the image icon; fall back to the known third slot.\n    return buttons.find((button) => /image_line|image/i.test(button.innerHTML || ''))\n      || buttons[2]\n      || null;\n  }\n\n  async function captureFileInput(box, imageButton) {\n    let captured = null;\n    const originalClick = HTMLInputElement.prototype.click;\n    HTMLInputElement.prototype.click = function patchedClick(...args) {\n      if (this.type === 'file') {\n        captured = this;\n        return;\n      }\n      return originalClick.apply(this, args);\n    };\n    try {\n      imageButton.click();\n      await sleep(500);\n    } finally {\n      HTMLInputElement.prototype.click = originalClick;\n    }\n    if (!captured) {\n      const upload = deepQuery(box.shadowRoot, 'bili-comment-pictures-upload');\n      captured = deepQuery(upload?.shadowRoot, 'input[type=file]')\n        || deepQuery(box.shadowRoot, 'input[type=file]');\n    }\n    if (!captured) throw new Error('没有捕获到图片 file input；浏览器可能使用系统文件选择器，请改用 agent browser 的上传文件能力');\n    return captured;\n  }\n\n  function assignFile(input, file) {\n    const transfer = new DataTransfer();\n    transfer.items.add(file);\n    input.files = transfer.files;\n    input.dispatchEvent(new Event('input', { bubbles: true }));\n    input.dispatchEvent(new Event('change', { bubbles: true }));\n  }\n\n  function previewUrl(value) {\n    const text = String(value || '').trim();\n    const match = text.match(/^url\\((['\"]?)(.*)\\1\\)$/i);\n    return match ? match[2].trim() : text;\n  }\n\n  function isUploadedPreviewUrl(value) {\n    const src = String(value || '').trim();\n    if (!src || /^blob:/i.test(src)) return false;\n    // Some video-page builds keep the local data: URL preview after the\n    // upload_bfs response; upload success is verified separately below.\n    return /^data:image\\//i.test(src) || /(?:new_dyn|\\/bfs\\/|hdslb\\.com\\/bfs)/i.test(src);\n  }\n\n  async function waitForUpload(box, timeoutMs) {\n    const deadline = Date.now() + timeoutMs;\n    while (Date.now() < deadline) {\n      const upload = deepQuery(box.shadowRoot, 'bili-comment-pictures-upload');\n      const shadow = upload?.shadowRoot;\n      if (shadow) {\n        const images = [...shadow.querySelectorAll('img')];\n        if (images.some((img) => isUploadedPreviewUrl(img.currentSrc || img.src))) return true;\n        // Some versions render the preview as a background image instead of\n        // an <img>. Accept data/BFS previews; blob previews are rejected, and\n        // upload_bfs success is verified before this check.\n        const elements = [...shadow.querySelectorAll('*')];\n        if (elements.some((el) => isUploadedPreviewUrl(previewUrl(getComputedStyle(el).backgroundImage)))) return true;\n      }\n      await sleep(300);\n    }\n    return false;\n  }\n\n  async function waitForUploadRequests(requests, { timeoutMs, settleMs = 1200 } = {}) {\n    const deadline = Date.now() + timeoutMs;\n    let lastCount = -1;\n    let lastChange = Date.now();\n    while (Date.now() < deadline) {\n      if (requests.length !== lastCount) {\n        lastCount = requests.length;\n        lastChange = Date.now();\n      }\n      const allDone = requests.length > 0 && requests.every((item) => item.json !== null);\n      const success = requests.some(\n        (item) => item.json && item.json.code === 0\n          && (item.json.data?.image_url || item.json.data?.url),\n      );\n      if (allDone && success && Date.now() - lastChange >= settleMs) return requests;\n      if (allDone && !success && Date.now() - lastChange >= 500) {\n        const failed = requests.find((item) => item.json && item.json.code !== 0)?.json;\n        throw new Error(`图片上传失败：${failed?.code ?? 'unknown'} ${failed?.message || ''}`.trim());\n      }\n      await sleep(200);\n    }\n    throw new Error('图片上传未完成（等待 upload_bfs 超时）');\n  }\n\n  function isPictureEntry(picture) {\n    if (typeof picture === 'string') return picture.trim().length > 0;\n    if (!picture || typeof picture !== 'object') return false;\n    const url = picture.img_src || picture.url;\n    return typeof url === 'string' && url.trim().length > 0;\n  }\n\n  function parsePictureList(value) {\n    if (Array.isArray(value)) return value.filter(isPictureEntry);\n    if (typeof value !== 'string') return [];\n    const text = value.trim();\n    if (!text || text === '[]') return [];\n    try {\n      const parsed = JSON.parse(text);\n      return Array.isArray(parsed) ? parsed.filter(isPictureEntry) : [];\n    } catch {\n      return [];\n    }\n  }\n\n  function extractCommentPictures(body) {\n    if (body === null || body === undefined) return null;\n    try {\n      if (typeof FormData !== 'undefined' && body instanceof FormData) {\n        return body.has('pictures') ? parsePictureList(body.get('pictures')) : [];\n      }\n      if (typeof URLSearchParams !== 'undefined' && body instanceof URLSearchParams) {\n        return body.has('pictures') ? parsePictureList(body.get('pictures')) : [];\n      }\n      if (typeof body === 'string') {\n        const text = body.trim();\n        if (text.startsWith('{')) {\n          const parsed = JSON.parse(text);\n          return Object.prototype.hasOwnProperty.call(parsed, 'pictures') ? parsePictureList(parsed.pictures) : [];\n        }\n        const params = new URLSearchParams(text);\n        return params.has('pictures') ? parsePictureList(params.get('pictures')) : [];\n      }\n    } catch {\n      // Body shape is not inspectable; the caller blocks null.\n      return null;\n    }\n    return null;\n  }\n\n  async function waitForPublishedComment(host, text, timeoutMs) {\n    const deadline = Date.now() + timeoutMs;\n    while (Date.now() < deadline) {\n      const renderers = deepQueryAll(host.shadowRoot, 'bili-comment-renderer');\n      if (renderers.some((el) => (el.shadowRoot?.innerText || el.innerText || '').includes(text))) {\n        return true;\n      }\n      await sleep(300);\n    }\n    return false;\n  }\n\n  async function waitForRpid(timeoutMs) {\n    // Capture fetch and XHR around submit; either transport can be used by the\n    // page. The caller still has a DOM-success fallback.\n    const originalFetch = window.fetch;\n    const OriginalXHR = window.XMLHttpRequest;\n    const originalOpen = OriginalXHR.prototype.open;\n    const originalSend = OriginalXHR.prototype.send;\n    let captured = null;\n    let blocked = null;\n    let requestPictures = [];\n    window.fetch = async function patchedFetch(...args) {\n      const url = typeof args[0] === 'string' ? args[0] : args[0]?.url || '';\n      const isReplyAdd = String(url).includes('/x/v2/reply/add');\n      if (isReplyAdd) {\n        const body = args[1]?.body;\n        const pictures = extractCommentPictures(body);\n        if (pictures === null || pictures.length === 0) {\n          // Never publish a text-only comment when the caller asked for an\n          // image comment. Unknown/unparseable bodies are blocked too.\n          blocked = new Error('评论请求没有 pictures，已阻止发布（图片没有挂到评论上）');\n          throw blocked;\n        }\n        requestPictures = pictures;\n      }\n      const response = await originalFetch.apply(this, args);\n      try {\n        if (isReplyAdd) {\n          response.clone().json().then((json) => { captured = json; }).catch(() => {});\n        }\n      } catch {\n        // Ignore response-inspection errors; the DOM fallback still applies.\n      }\n      return response;\n    };\n    OriginalXHR.prototype.open = function patchedOpen(method, url, ...rest) {\n      this.__biliCommentUrl = String(url || '');\n      return originalOpen.call(this, method, url, ...rest);\n    };\n    OriginalXHR.prototype.send = function patchedSend(...args) {\n      const isReplyAdd = String(this.__biliCommentUrl || '').includes('/x/v2/reply/add');\n      if (isReplyAdd) {\n        const pictures = extractCommentPictures(args[0]);\n        if (pictures === null || pictures.length === 0) {\n          blocked = new Error('评论请求没有 pictures，已阻止发布（图片没有挂到评论上）');\n          throw blocked;\n        }\n        requestPictures = pictures;\n      }\n      try {\n        this.addEventListener('load', () => {\n          if (isReplyAdd) {\n            try { captured = JSON.parse(this.responseText); } catch { /* ignore */ }\n          }\n        });\n      } catch {\n        // Ignore listener failures.\n      }\n      return originalSend.apply(this, args);\n    };\n    return {\n      restore: () => {\n        window.fetch = originalFetch;\n        OriginalXHR.prototype.open = originalOpen;\n        OriginalXHR.prototype.send = originalSend;\n      },\n      wait: async () => {\n        const deadline = Date.now() + timeoutMs;\n        while (Date.now() < deadline && !captured) {\n          if (blocked && !captured) throw blocked;\n          await sleep(250);\n        }\n        if (blocked && !captured) throw blocked;\n        return { json: captured, requestPictures };\n      },\n    };\n  }\n\n  window.postBiliImageComment = async function postBiliImageComment({\n    text,\n    imageBase64,\n    imageName = 'image.png',\n    imageType = 'image/png',\n    timeoutMs = 120_000,\n  } = {}) {\n    const content = String(text ?? '').trim();\n    if (!content) throw new Error('text 不能为空');\n    if (!imageBase64) throw new Error('需要 imageBase64');\n\n    let comments = findCommentHost();\n    if (!comments) {\n      // 动态/视频的评论组件是懒加载的，先滚动到评论区。\n      window.scrollTo(0, document.body.scrollHeight * 0.55);\n      await sleep(1800);\n      window.scrollTo(0, document.body.scrollHeight);\n      await sleep(1800);\n      comments = findCommentHost();\n    }\n    let box = comments ? findCommentBox(comments) : null;\n    // Some video pages mount the host before the comment box; retry after\n    // scrolling instead of failing immediately.\n    for (let attempt = 0; !box && attempt < 3; attempt += 1) {\n      window.scrollBy(0, 700);\n      await sleep(1200);\n      comments = findCommentHost();\n      box = comments ? findCommentBox(comments) : null;\n    }\n    if (!comments) throw new Error('页面没有评论组件（bili-comments）');\n    if (!box) throw new Error('找不到评论框（bili-comment-box）；请确认评论区已加载并且页面已登录');\n\n    const editor = await activateBox(box);\n    setEditorText(editor, content);\n\n    const imageButton = findImageButton(box);\n    if (!imageButton) throw new Error('找不到评论图片按钮');\n\n    const file = await base64ToFile({ imageBase64, imageName, imageType });\n    const input = await captureFileInput(box, imageButton);\n\n    // Track every upload_bfs request. Retries or duplicate component handling\n    // can produce more than one upload; waiting for only the first response\n    // lets the script publish before the form has attached pictures.\n    const originalFetch = window.fetch;\n    const uploadRequests = [];\n    window.fetch = async function patchedUploadFetch(...args) {\n      const url = typeof args[0] === 'string' ? args[0] : args[0]?.url || '';\n      const isUpload = String(url).includes('/x/dynamic/feed/draw/upload_bfs');\n      const record = { at: Date.now(), json: null };\n      if (isUpload) uploadRequests.push(record);\n      try {\n        const response = await originalFetch.apply(this, args);\n        if (isUpload) {\n          response.clone().json().then((json) => { record.json = json; }).catch(() => {\n            record.json = { code: -1, message: 'upload response is not JSON' };\n          });\n        }\n        return response;\n      } catch (error) {\n        if (isUpload) record.json = { code: -1, message: String(error?.message || error) };\n        throw error;\n      }\n    };\n    try {\n      assignFile(input, file);\n      await waitForUploadRequests(uploadRequests, {\n        timeoutMs: Math.min(timeoutMs, 45_000),\n        settleMs: 1200,\n      });\n      if (!(await waitForUpload(box, timeoutMs))) {\n        throw new Error('图片上传未完成（未检测到图片预览）');\n      }\n      // Let the comment component commit its picture state before publishing.\n      await sleep(300);\n    } finally {\n      window.fetch = originalFetch;\n    }\n\n    const publish = box.shadowRoot.querySelector('#pub button');\n    if (!publish) throw new Error('找不到发布按钮');\n    if (publish.disabled) throw new Error('发布按钮不可用（未登录或内容为空）');\n\n    const capture = await waitForRpid(timeoutMs);\n    let responseJson = null;\n    let requestPictures = [];\n    try {\n      publish.click();\n      const captured = await capture.wait();\n      responseJson = captured?.json || null;\n      requestPictures = captured?.requestPictures || [];\n    } finally {\n      capture.restore();\n    }\n\n    if (responseJson && responseJson.code !== 0) {\n      throw new Error(`评论发布失败：${responseJson.code} ${responseJson.message || ''}`);\n    }\n    const responseContent = responseJson?.data?.reply?.content;\n    const responseHasPictures = Boolean(responseContent\n      && Object.prototype.hasOwnProperty.call(responseContent, 'pictures'));\n    const responsePictures = responseHasPictures && Array.isArray(responseContent.pictures)\n      ? responseContent.pictures\n      : [];\n    const pictures = responseHasPictures ? responsePictures : requestPictures;\n    const pictureSource = responseHasPictures ? 'response' : 'request';\n    const pictureSummary = pictures.map((picture) => {\n      if (typeof picture === 'string') return { url: picture, width: 0, height: 0, size: 0 };\n      return {\n        url: picture.img_src || picture.url || '',\n        width: Number(picture.img_width ?? picture.width) || 0,\n        height: Number(picture.img_height ?? picture.height) || 0,\n        size: Number(picture.img_size ?? picture.size) || 0,\n      };\n    }).filter((picture) => picture.url);\n    const hasImage = pictureSummary.length > 0;\n    const pictureCount = pictureSummary.length;\n    const rpid = responseJson?.data?.rpid_str || responseJson?.data?.rpid || null;\n    const baseUrl = location.href.split('#')[0];\n    if (!rpid) {\n      const published = await waitForPublishedComment(comments, content, Math.min(timeoutMs, 15_000));\n      if (!published) {\n        throw new Error('评论提交结果未知：未捕获 /x/v2/reply/add 响应，也没在页面看到新评论；请先检查评论列表，不要直接重试');\n      }\n      return {\n        ok: hasImage,\n        action: 'comment_browser',\n        text: content,\n        image: imageName,\n        rpid: null,\n        state: null,\n        published_unknown: true,\n        has_image: hasImage,\n        picture_count: pictureCount,\n        pictures: pictureSummary,\n        picture_source: pictureSource,\n        link: baseUrl,\n        result: null,\n        note: hasImage\n          ? '页面已出现新评论，但没有捕获到 rpid；请用 comments 工具按内容确认。'\n          : '页面出现新评论，但未确认图片；请立即检查评论列表，不要直接重试。',\n      };\n    }\n    return {\n      ok: hasImage,\n      action: 'comment_browser',\n      text: content,\n      image: imageName,\n      rpid: String(rpid),\n      state: responseJson?.data?.reply?.state ?? null,\n      has_image: hasImage,\n      picture_count: pictureCount,\n      pictures: pictureSummary,\n      picture_source: pictureSource,\n      link: `${baseUrl}#reply${rpid}`,\n      result: { code: responseJson.code, message: responseJson.message },\n      note: hasImage ? undefined : '评论已提交，但请求/响应里没有 pictures；请立即检查并删除这条评论。',\n    };\n  };\n})();\n";
const IMAGE_TYPES = {
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.png': 'image/png',
  '.gif': 'image/gif',
};
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function usage() {
  return `用法:
  node scripts/post-image-comment.mjs --url <BV/av/链接/动态ID> --image <本地图片> --text <评论正文> [选项]
  node scripts/post-image-comment.mjs <BV/av/链接/动态ID> <本地图片> <评论正文...> [选项]

选项:
  --agent-browser <path>  agent-browser 可执行文件，默认 agent-browser
                          也可用 AGENT_BROWSER_BIN
  --cookie-file <path>    Cookie 文件；默认 MCP 的 cookies.json
  --no-cookie             不自动注入 Cookie（浏览器已有登录态时用）
  --cookie-domain <d>     Cookie domain，默认 .bilibili.com
  --timeout <ms>          页面脚本超时，默认 120000
  --quiet                 只输出 rpid=... has_image=...
  --probe                 只打开页面，输出 title/url，检查 agent-browser 和登录态

示例:
  node scripts/post-image-comment.mjs \\
    --url https://www.bilibili.com/video/BV1ZN4y1x74v/ \\
    --image /path/to/a.png --text "@汐儿不是鱼 喵"

说明:
  - Cookie 默认从 MCP 配置目录读取（${paths().cookieFile}）；
  - 通过 agent-browser cookies set 逐项注入登录 Cookie；
  - 页面脚本会等待 upload_bfs、检查 pictures，确认图片挂上才发布；
  - 输出 JSON；--quiet 输出 rpid 和 has_image。
`;
}

function normalizeTargetUrl(value) {
  const input = String(value || '').trim();
  if (/^BV[0-9A-Za-z]{10}$/i.test(input)) return `https://www.bilibili.com/video/${input}/`;
  if (/^av\d+$/i.test(input)) return `https://www.bilibili.com/video/${input}/`;
  if (/^\d+$/.test(input)) return `https://www.bilibili.com/opus/${input}`;
  try {
    const url = new URL(input);
    if (!['http:', 'https:'].includes(url.protocol)) throw new Error('地址必须是 http(s) URL');
    return url.toString();
  } catch {
    throw new Error(`无法识别的地址：${input}`);
  }
}

function parseArgs(argv) {
  const args = {
    bin: process.env.AGENT_BROWSER_BIN || 'agent-browser',
    timeoutMs: 120_000,
    cookieDomain: '.bilibili.com',
    quiet: false,
    probe: false,
  };
  const positional = [];
  for (let index = 0; index < argv.length; index += 1) {
    const item = argv[index];
    if (item === '--help' || item === '-h') { args.help = true; continue; }
    if (item === '--url') { args.url = argv[++index]; continue; }
    if (item === '--image') { args.image = argv[++index]; continue; }
    if (item === '--text') { args.text = argv[++index]; continue; }
    if (item === '--agent-browser') { args.bin = argv[++index]; continue; }
    if (item === '--cookie-file') { args.cookieFile = argv[++index]; continue; }
    if (item === '--no-cookie') { args.noCookie = true; continue; }
    if (item === '--cookie-domain') { args.cookieDomain = argv[++index]; continue; }
    if (item === '--timeout') { args.timeoutMs = Number(argv[++index]); continue; }
    if (item === '--quiet') { args.quiet = true; continue; }
    if (item === '--probe') { args.probe = true; continue; }
    if (item.startsWith('--')) throw new Error(`未知参数：${item}`);
    positional.push(item);
  }
  if (!args.url && positional.length) args.url = positional.shift();
  if (!args.image && positional.length) args.image = positional.shift();
  if (!args.text && positional.length) args.text = positional.join(' ');
  if (args.help) return args;
  if (!args.url) throw new Error('需要 --url（BV 号、av 号、视频/动态链接或动态 ID）');
  args.url = normalizeTargetUrl(args.url);
  if (!Number.isFinite(args.timeoutMs) || args.timeoutMs < 10_000) throw new Error('--timeout 至少 10000ms');
  args.timeoutMs = Math.min(Math.trunc(args.timeoutMs), 300_000);
  if (!args.probe) {
    if (!args.image) throw new Error('需要 --image（本地图片路径）');
    if (!args.text || !String(args.text).trim()) throw new Error('需要 --text（评论正文）');
  }
  return args;
}

function run(bin, args, { input = null, timeoutMs = 120_000 } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(bin, args, { stdio: ['pipe', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    let settled = false;
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      try { child.kill('SIGKILL'); } catch { /* ignore */ }
      reject(new Error(`agent-browser 命令超时：${args.slice(0, 3).join(' ')}`));
    }, timeoutMs);
    const append = (current, chunk) => {
      const next = current + chunk.toString();
      return next.length > 2 * 1024 * 1024 ? next.slice(-1_000_000) : next;
    };
    child.stdout.on('data', (chunk) => { stdout = append(stdout, chunk); });
    child.stderr.on('data', (chunk) => { stderr = append(stderr, chunk); });
    child.on('error', (error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      reject(new Error(`无法运行 ${bin}：${error.message}`));
    });
    child.on('close', (code) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({ code, stdout, stderr });
    });
    if (input !== null && input !== undefined) child.stdin.end(input);
    else child.stdin.end();
  });
}

async function agentBrowser(args, options = {}, { retries = 0 } = {}) {
  let last;
  for (let attempt = 0; attempt <= retries; attempt += 1) {
    last = await run(options.bin || 'agent-browser', args, {
      input: options.input,
      timeoutMs: options.timeoutMs,
    });
    const combined = `${last.stdout}\n${last.stderr}`;
    const retryable = last.code !== 0 && /Resource temporarily unavailable|temporarily unavailable|timed out|timeout/i.test(combined);
    if (!retryable || attempt === retries) return last;
    await sleep(1200 * (attempt + 1));
  }
  return last;
}

async function ensureAgentBrowser(bin) {
  const result = await run(bin, ['--version'], { timeoutMs: 15_000 });
  if (result.code !== 0) {
    throw new Error(`无法运行 agent-browser（${bin}）：${(result.stderr || result.stdout).trim().slice(0, 200)}`);
  }
}

async function loadCookies(args) {
  if (args.noCookie) return {};
  let cookies;
  if (args.cookieFile) {
    const raw = await fs.readFile(args.cookieFile, 'utf8');
    cookies = parseCookieInput(raw);
  } else if (process.env.BILI_COOKIE && process.env.BILI_COOKIE.trim()) {
    cookies = parseCookieHeader(process.env.BILI_COOKIE);
  } else {
    const stored = await readStoredCookies();
    cookies = stored.cookies || {};
  }
  const selected = {};
  for (const name of LOGIN_COOKIE_NAMES) {
    if (cookies[name]) selected[name] = cookies[name];
  }
  return selected;
}

async function injectCookies(bin, cookies, domain, timeoutMs = 20_000) {
  const names = Object.keys(cookies);
  if (!names.length) return { injected: 0, skipped: true };
  await ensureAgentBrowser(bin);
  // Launch a blank page first so cookies are present before the first B站 load.
  const opened = await agentBrowser(['open'], { bin, timeoutMs: 30_000 }, { retries: 1 });
  if (opened.code !== 0) {
    throw new Error(`agent-browser open 失败：${(opened.stderr || opened.stdout).trim().slice(0, 300)}`);
  }
  for (const name of names) {
    const value = cookies[name];
    const args = ['cookies', 'set', name, value, '--domain', domain, '--path', '/', '--secure'];
    if (name === 'SESSDATA') args.push('--http-only');
    const result = await agentBrowser(args, { bin, timeoutMs }, { retries: 0 });
    if (result.code !== 0) {
      throw new Error(`agent-browser cookies set ${name} 失败：${(result.stderr || result.stdout).trim().slice(0, 200)}`);
    }
  }
  return { injected: names.length, skipped: false };
}

async function navigate(bin, url, timeoutMs) {
  const result = await agentBrowser(['open', url], { bin, timeoutMs }, { retries: 1 });
  if (result.code !== 0) {
    throw new Error(`agent-browser open ${url} 失败：${(result.stderr || result.stdout).trim().slice(0, 300)}`);
  }
  // Give SPA/comment component a moment; the page script also scrolls/retries.
  await sleep(1200);
}

function parseEvalResult(stdout) {
  const text = String(stdout || '').replace(/\x1b\[[0-9;]*m/g, '').trim();
  if (!text) return null;
  const candidates = [text];
  const starts = [text.indexOf('{'), text.indexOf('[')].filter((index) => index >= 0);
  if (starts.length) candidates.push(text.slice(Math.min(...starts)));
  for (const candidate of candidates) {
    try {
      let value = JSON.parse(candidate);
      if (typeof value === 'string') {
        try { value = JSON.parse(value); } catch { /* keep string */ }
      }
      return value;
    } catch {
      // Try the next candidate.
    }
  }
  return null;
}

async function evalExpression(bin, expression, { timeoutMs = 30_000, retries = 0 } = {}) {
  const result = await agentBrowser(['eval', expression], { bin, timeoutMs }, { retries });
  if (result.code !== 0) {
    throw new Error(`agent-browser eval 失败：${(result.stderr || result.stdout).trim().slice(0, 300)}`);
  }
  return parseEvalResult(result.stdout);
}

async function loadImage(imagePath) {
  const ext = path.extname(imagePath).toLowerCase();
  const imageType = IMAGE_TYPES[ext];
  if (!imageType) throw new Error(`不支持的图片格式：${ext || '(无扩展名)'}；仅支持 jpg/jpeg/png/gif`);
  const stat = await fs.stat(imagePath).catch(() => null);
  if (!stat?.isFile()) throw new Error(`图片不存在或不是文件：${imagePath}`);
  if (stat.size > 20 * 1024 * 1024) throw new Error('图片超过 20MB，请先压缩');
  const data = await fs.readFile(imagePath);
  return { imageBase64: data.toString('base64'), imageName: path.basename(imagePath), imageType };
}

async function evalInPage(bin, script, timeoutMs) {
  // Starting the page script begins a public write. Never retry this eval:
  // a lost response could otherwise start a second comment.
  const result = await agentBrowser(['eval', '--stdin'], { bin, input: script, timeoutMs }, { retries: 0 });
  if (result.code !== 0) {
    throw new Error(`agent-browser eval --stdin 失败：${(result.stderr || result.stdout).trim().slice(0, 400)}`);
  }
  return result;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) {
    process.stderr.write(usage());
    return;
  }
  await ensureAgentBrowser(args.bin);
  const cookies = await loadCookies(args);
  const cookieResult = await injectCookies(args.bin, cookies, args.cookieDomain);
  if (cookieResult.skipped) {
    const reason = args.noCookie ? '已按 --no-cookie 跳过 Cookie 注入' : '没有可注入的 Cookie';
    process.stderr.write(`警告：${reason}，沿用 agent-browser 当前登录态\n`);
  } else {
    process.stderr.write(`已注入 ${cookieResult.injected} 个登录 Cookie\n`);
  }
  await navigate(args.bin, args.url, 45_000);

  if (args.probe) {
    const info = await evalExpression(args.bin, 'JSON.stringify({ title: document.title, url: location.href })', { timeoutMs: 15_000, retries: 1 });
    process.stdout.write(`${JSON.stringify(info, null, 2)}\n`);
    return;
  }

  const image = await loadImage(args.image);
  const pageScript = PAGE_SCRIPT_SOURCE;
  const payload = {
    text: String(args.text).trim(),
    imageBase64: image.imageBase64,
    imageName: image.imageName,
    imageType: image.imageType,
    timeoutMs: args.timeoutMs,
  };
  const script = `${pageScript}
window.__biliResult = null;
window.postBiliImageComment(${JSON.stringify(payload)})
  .then((result) => { window.__biliResult = result; })
  .catch((error) => { window.__biliResult = { ok: false, error: String(error && error.message ? error.message : error) }; });
'started';`;
  await evalInPage(args.bin, script, args.timeoutMs + 30_000);

  const deadline = Date.now() + args.timeoutMs + 30_000;
  let result = null;
  while (Date.now() < deadline) {
    const current = await evalExpression(
      args.bin,
      'window.__biliResult ? JSON.stringify(window.__biliResult) : ""',
      { timeoutMs: 15_000, retries: 1 },
    );
    if (current && typeof current === 'object') {
      result = current;
      break;
    }
    await sleep(1200);
  }
  if (!result) {
    throw new Error('等待 __biliResult 超时；评论可能已发出，请先用 comments 工具检查，不要直接重试');
  }
  const hasImage = result.has_image === true || (Array.isArray(result.pictures) && result.pictures.length > 0);
  if (args.quiet) {
    process.stdout.write(`rpid=${result.rpid || ''} has_image=${hasImage}\n`);
  } else {
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
  }
  if (result.ok === false && !result.rpid) {
    if (result.published_unknown === true) {
      process.stderr.write('评论已发布但未确认图片，请检查并删除\n');
      process.exitCode = 2;
    } else {
      const outcomeUnknown = /结果未知|可能已发出/.test(result.error || '');
      process.stderr.write(`${outcomeUnknown ? '评论结果未知' : '评论发送失败'}：${result.error || '未知错误'}\n`);
      process.exitCode = 1;
    }
  } else if (!hasImage) {
    process.stderr.write('评论已提交但没有确认图片，请检查并删除\n');
    process.exitCode = 2;
  }
}

main().catch((error) => {
  process.stderr.write(`post-image-comment: ${error.message}\n`);
  process.exitCode = 1;
});
