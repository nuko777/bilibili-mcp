/**
 * B站图片评论：在“已登录的浏览器页面”里执行，不调用评论 API。
 *
 * 用法（agent browser 的页面执行能力）：
 *   1. 打开视频页或动态页，例如 https://www.bilibili.com/opus/1262836254683168775
 *   2. 把本文件内容注入页面
 *   3. 执行：
 *        await window.postBiliImageComment({
 *          text: "喵",
 *          imageBase64: "<图片的 base64，可带 data:image/png;base64, 前缀>",
 *          imageName: "7.png",
 *          imageType: "image/png",
 *        })
 *
 * 只接受 imageBase64；本地文件由 agent 读成 base64 后传入。
 * 返回 { ok, rpid, link, state, text, image }。失败会 throw Error。
 *
 * 说明：B站网页评论请求带 b_wet / x-bili-metadata-gaia-bin 等浏览器风控 token，
 * 纯 API 图片评论可能仅自己可见，因此图片评论应走本脚本。
 */
(function installPostBiliImageComment() {
  const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

  function deepQueryAll(root, selector, out = []) {
    if (!root) return out;
    for (const el of root.querySelectorAll(selector)) out.push(el);
    for (const el of root.querySelectorAll('*')) {
      if (el.shadowRoot) deepQueryAll(el.shadowRoot, selector, out);
    }
    return out;
  }

  function deepQuery(root, selector) {
    return deepQueryAll(root, selector)[0] || null;
  }

  function visible(el) {
    if (!el) return false;
    const rect = el.getBoundingClientRect();
    return rect.width > 0 && rect.height > 0;
  }

  function findCommentHost() {
    // 视频页：#commentapp 里的 bili-comments；动态/opus：.bili-comment-container 里的 bili-comments。
    return document.querySelector('#commentapp bili-comments')
      || document.querySelector('.bili-comment-container bili-comments')
      || document.querySelector('bili-comments');
  }

  function findCommentBox(host) {
    const boxes = deepQueryAll(host.shadowRoot, 'bili-comment-box');
    return boxes.find((box) => {
      const editor = deepQuery(box.shadowRoot, '.brt-editor');
      return visible(editor);
    }) || boxes[0] || null;
  }

  async function activateBox(box) {
    if (!box?.shadowRoot) throw new Error('评论区组件尚未加载');
    // 动态页的评论框在 header shadow 里，初始 footer 是 hidden 的；点一下编辑区激活。
    const editorArea = box.shadowRoot.querySelector('#editor')
      || box.shadowRoot.querySelector('bili-comment-rich-textarea');
    if (editorArea) editorArea.click();
    await sleep(600);
    const editor = deepQuery(box.shadowRoot, '.brt-editor');
    if (!editor) throw new Error('找不到评论输入框（.brt-editor）');
    editor.click();
    await sleep(300);
    return editor;
  }

  function setEditorText(editor, text) {
    editor.focus();
    try {
      document.execCommand('selectAll', false, null);
      document.execCommand('insertText', false, text);
    } catch {
      // Fall through to the DOM fallback below.
    }
    if ((editor.textContent || '').trim() !== text) {
      editor.textContent = text;
      for (const type of ['beforeinput', 'input', 'keyup']) {
        try {
          if (type === 'keyup') {
            editor.dispatchEvent(new KeyboardEvent(type, { bubbles: true, key: 'a' }));
          } else {
            editor.dispatchEvent(new InputEvent(type, {
              bubbles: true,
              inputType: 'insertText',
              data: text,
            }));
          }
        } catch {
          // Ignore event-constructor differences in older browsers.
        }
      }
    }
  }

  async function base64ToFile({ imageBase64, imageName, imageType }) {
    if (!imageBase64) throw new Error('需要 imageBase64');
    const clean = String(imageBase64).replace(/^data:[^,]+,/, '');
    const binary = atob(clean);
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i);
    const blob = new Blob([bytes], { type: imageType || 'image/png' });
    return new File([blob], imageName || 'image.png', {
      type: imageType || 'image/png',
    });
  }

  function findImageButton(box) {
    const buttons = [...(box.shadowRoot?.querySelectorAll('#footer button.tool-btn') || [])];
    // Prefer the button carrying the image icon; fall back to the known third slot.
    return buttons.find((button) => /image_line|image/i.test(button.innerHTML || ''))
      || buttons[2]
      || null;
  }

  async function captureFileInput(box, imageButton) {
    let captured = null;
    const originalClick = HTMLInputElement.prototype.click;
    HTMLInputElement.prototype.click = function patchedClick(...args) {
      if (this.type === 'file') {
        captured = this;
        return;
      }
      return originalClick.apply(this, args);
    };
    try {
      imageButton.click();
      await sleep(500);
    } finally {
      HTMLInputElement.prototype.click = originalClick;
    }
    if (!captured) {
      const upload = deepQuery(box.shadowRoot, 'bili-comment-pictures-upload');
      captured = deepQuery(upload?.shadowRoot, 'input[type=file]')
        || deepQuery(box.shadowRoot, 'input[type=file]');
    }
    if (!captured) throw new Error('没有捕获到图片 file input；浏览器可能使用系统文件选择器，请改用 agent browser 的上传文件能力');
    return captured;
  }

  function assignFile(input, file) {
    const transfer = new DataTransfer();
    transfer.items.add(file);
    input.files = transfer.files;
    input.dispatchEvent(new Event('input', { bubbles: true }));
    input.dispatchEvent(new Event('change', { bubbles: true }));
  }

  async function waitForValue(getter, timeoutMs) {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      const value = getter();
      if (value) return value;
      await sleep(250);
    }
    return null;
  }

  async function waitForUpload(box, timeoutMs) {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      const upload = deepQuery(box.shadowRoot, 'bili-comment-pictures-upload');
      const shadow = upload?.shadowRoot;
      if (shadow) {
        const html = shadow.innerHTML || '';
        if (/new_dyn|<img/i.test(html)) return true;
      }
      await sleep(300);
    }
    return false;
  }

  async function waitForPublishedComment(host, text, timeoutMs) {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      const renderers = deepQueryAll(host.shadowRoot, 'bili-comment-renderer');
      if (renderers.some((el) => (el.shadowRoot?.innerText || el.innerText || '').includes(text))) {
        return true;
      }
      await sleep(300);
    }
    return false;
  }

  async function waitForRpid(timeoutMs) {
    // Capture fetch and XHR around submit; either transport can be used by the
    // page. The caller still has a DOM-success fallback.
    const originalFetch = window.fetch;
    const OriginalXHR = window.XMLHttpRequest;
    const originalOpen = OriginalXHR.prototype.open;
    const originalSend = OriginalXHR.prototype.send;
    let captured = null;
    window.fetch = async function patchedFetch(...args) {
      const response = await originalFetch.apply(this, args);
      try {
        const url = typeof args[0] === 'string' ? args[0] : args[0]?.url || '';
        if (String(url).includes('/x/v2/reply/add')) {
          response.clone().json().then((json) => { captured = json; }).catch(() => {});
        }
      } catch {
        // Ignore response-inspection errors; the DOM fallback still applies.
      }
      return response;
    };
    OriginalXHR.prototype.open = function patchedOpen(method, url, ...rest) {
      this.__biliCommentUrl = String(url || '');
      return originalOpen.call(this, method, url, ...rest);
    };
    OriginalXHR.prototype.send = function patchedSend(...args) {
      try {
        this.addEventListener('load', () => {
          if (String(this.__biliCommentUrl || '').includes('/x/v2/reply/add')) {
            try { captured = JSON.parse(this.responseText); } catch { /* ignore */ }
          }
        });
      } catch {
        // Ignore listener failures.
      }
      return originalSend.apply(this, args);
    };
    return {
      restore: () => {
        window.fetch = originalFetch;
        OriginalXHR.prototype.open = originalOpen;
        OriginalXHR.prototype.send = originalSend;
      },
      wait: async () => {
        const deadline = Date.now() + timeoutMs;
        while (Date.now() < deadline && !captured) await sleep(250);
        return captured;
      },
    };
  }

  window.postBiliImageComment = async function postBiliImageComment({
    text,
    imageBase64,
    imageName = 'image.png',
    imageType = 'image/png',
    timeoutMs = 120_000,
  } = {}) {
    const content = String(text ?? '').trim();
    if (!content) throw new Error('text 不能为空');
    if (!imageBase64) throw new Error('需要 imageBase64');

    let comments = findCommentHost();
    if (!comments) {
      // 动态/视频的评论组件是懒加载的，先滚动到评论区。
      window.scrollTo(0, document.body.scrollHeight * 0.55);
      await sleep(1800);
      window.scrollTo(0, document.body.scrollHeight);
      await sleep(1800);
      comments = findCommentHost();
    }
    let box = comments ? findCommentBox(comments) : null;
    // Some video pages mount the host before the comment box; retry after
    // scrolling instead of failing immediately.
    for (let attempt = 0; !box && attempt < 3; attempt += 1) {
      window.scrollBy(0, 700);
      await sleep(1200);
      comments = findCommentHost();
      box = comments ? findCommentBox(comments) : null;
    }
    if (!comments) throw new Error('页面没有评论组件（bili-comments）');
    if (!box) throw new Error('找不到评论框（bili-comment-box）；请确认评论区已加载并且页面已登录');

    const editor = await activateBox(box);
    setEditorText(editor, content);

    const imageButton = findImageButton(box);
    if (!imageButton) throw new Error('找不到评论图片按钮');

    const file = await base64ToFile({ imageBase64, imageName, imageType });
    const input = await captureFileInput(box, imageButton);

    // Capture the upload response when the page uses fetch (the web UI does),
    // and fall back to the picture-preview DOM for other transports.
    const originalFetch = window.fetch;
    let uploadJson = null;
    window.fetch = async function patchedUploadFetch(...args) {
      const response = await originalFetch.apply(this, args);
      try {
        const url = typeof args[0] === 'string' ? args[0] : args[0]?.url || '';
        if (String(url).includes('/x/dynamic/feed/draw/upload_bfs')) {
          response.clone().json().then((json) => { uploadJson = json; }).catch(() => {});
        }
      } catch {
        // Ignore inspection errors and use the DOM fallback.
      }
      return response;
    };
    try {
      assignFile(input, file);
      await waitForValue(() => uploadJson, Math.min(timeoutMs, 30_000));
      if (uploadJson && uploadJson.code !== 0) {
        throw new Error(`图片上传失败：${uploadJson.code} ${uploadJson.message || ''}`);
      }
      if (!(await waitForUpload(box, timeoutMs))) {
        throw new Error('图片上传未完成（未检测到图片预览）');
      }
    } finally {
      window.fetch = originalFetch;
    }

    const publish = box.shadowRoot.querySelector('#pub button');
    if (!publish) throw new Error('找不到发布按钮');
    if (publish.disabled) throw new Error('发布按钮不可用（未登录或内容为空）');

    const capture = await waitForRpid(timeoutMs);
    let responseJson = null;
    try {
      publish.click();
      responseJson = await capture.wait();
    } finally {
      capture.restore();
    }

    if (responseJson && responseJson.code !== 0) {
      throw new Error(`评论发布失败：${responseJson.code} ${responseJson.message || ''}`);
    }
    const rpid = responseJson?.data?.rpid_str || responseJson?.data?.rpid || null;
    const baseUrl = location.href.split('#')[0];
    if (!rpid) {
      const published = await waitForPublishedComment(comments, content, Math.min(timeoutMs, 15_000));
      if (!published) {
        throw new Error('评论提交结果未知：未捕获 /x/v2/reply/add 响应，也没在页面看到新评论；请先检查评论列表，不要直接重试');
      }
      return {
        ok: true,
        action: 'comment_browser',
        text: content,
        image: imageName,
        rpid: null,
        state: null,
        published_unknown: true,
        link: baseUrl,
        result: null,
        note: '页面已出现新评论，但没有捕获到 rpid；请用 comments 工具按内容确认。',
      };
    }
    return {
      ok: true,
      action: 'comment_browser',
      text: content,
      image: imageName,
      rpid: String(rpid),
      state: responseJson?.data?.reply?.state ?? null,
      link: `${baseUrl}#reply${rpid}`,
      result: { code: responseJson.code, message: responseJson.message },
    };
  };
})();
