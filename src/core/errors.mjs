export class BiliError extends Error {
  constructor(message, { code, endpoint, hint, status, details } = {}) {
    super(message);
    this.name = 'BiliError';
    this.code = code;
    this.endpoint = endpoint;
    this.hint = hint;
    this.status = status;
    this.details = details;
  }
}

export function hintForCode(code, context = '') {
  const numeric = Number(code);
  switch (numeric) {
    case -101:
      return '登录态无效或已过期：请使用 bilibili-login skill 在本机重新写入 Cookie，然后重试（或重启 MCP 连接）。';
    case -352:
      return '触发 B 站风控（-352）：稍后重试，避免短时间大量请求；也可重新登录刷新 Cookie。';
    case -403:
      return '接口拒绝访问（-403）：可能缺少权限、登录态或 WBI 签名，也可能是账号风控。';
    case -412:
      return '请求被风控拦截（-412）：请降低频率并检查请求头/Cookie。';
    case -509:
      return '请求过于频繁（-509）：请等待一段时间再试。';
    case -400:
      return '参数不合法（-400）：检查 bvid/aid、分页、内容长度等参数。';
    case -404:
      return '接口不存在（-404）：B 站可能已调整接口，记录该工具并更新端点。';
    case -10403:
      return '大会员权限不足（-10403）。';
    case 4126021:
      return '账号未绑定手机号，B 站不允许发布动态。请先在网页端绑定手机。';
    case 65004:
      return '取消点赞失败（65004）：通常表示本来就未点赞，可视为已经处于目标状态。';
    case 65006:
      return '重复点赞（65006）：目标状态已经生效。';
    case 34002:
      return '不能给自己投币（34002）。';
    case 34003:
      return '投币数量不合法（34003）：仅支持 1 或 2 枚。';
    case 34004:
      return '投币间隔太短（34004）：稍后再试。';
    case 34005:
      return '超过该视频的投币上限（34005）：单稿最多 2 枚。';
    case 22014:
      return '已经关注该用户（22014）。';
    case 22118:
      return '该用户隐私设置，粉丝列表不可见。';
    case 12015:
      return '评论需要验证码（12015）：当前接口无法绕过，请先在网页端完成验证。';
    case 4125014:
      return '图片尺寸不合法或过小；请使用宽高更大的 JPEG/PNG/GIF（建议宽高大于 420px）。';
    case -111:
      return 'csrf 校验失败：Cookie 中的 bili_jct 缺失或已过期，请重新登录。';
    default:
      if (context) return `${context}（B 站 code=${code}）`;
      return `B 站返回 code=${code}`;
  }
}

export function hintForStatus(status) {
  switch (Number(status)) {
    case 403:
      return 'HTTP 403：登录态、权限、WBI 签名或风控问题；检查 Cookie 并降低频率。';
    case 412:
    case 429:
      return 'HTTP 412/429：触发风控或限流；停止重试，等待一段时间。';
    case 404:
      return 'HTTP 404：接口可能已变更。';
    default:
      return `B 站返回 HTTP ${status}`;
  }
}

export function assertSuccess(json, endpoint, { allowCodes = [] } = {}) {
  const code = json?.code;
  if (code === 0 || code === '0' || code === undefined || code === null) return json;
  if (allowCodes.map(String).includes(String(code))) return json;
  const message = json?.message || json?.msg || '未知错误';
  throw new BiliError(`${endpoint} 失败: ${message}`, {
    code,
    endpoint,
    hint: hintForCode(code, endpoint),
    details: json,
  });
}

export function errorPayload(error) {
  const payload = {
    ok: false,
    error: {
      name: error?.name || 'Error',
      message: error?.message || String(error),
    },
  };
  if (error instanceof BiliError) {
    payload.error.code = error.code;
    payload.error.hint = error.hint;
    payload.error.endpoint = error.endpoint;
    payload.error.status = error.status;
  }
  return payload;
}

export function userFacingError(error) {
  const payload = errorPayload(error);
  const lines = [payload.error.message];
  if (payload.error.hint) lines.push(`提示：${payload.error.hint}`);
  return lines.join('\n');
}
