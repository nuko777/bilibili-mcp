import crypto from 'node:crypto';

export const MIXIN_KEY_ENC_TAB = [
  46, 47, 18, 2, 53, 8, 23, 32, 15, 50, 10, 31, 58, 3, 45, 35, 27, 43, 5, 49, 33, 9, 42, 19, 29, 28, 14, 39, 12, 38,
  41, 13, 37, 48, 7, 16, 24, 55, 40, 61, 26, 17, 0, 1, 60, 51, 30, 4, 22, 25, 54, 21, 56, 59, 6, 63, 57, 62, 11, 36,
  20, 34, 44, 52,
];

export function md5(value) {
  return crypto.createHash('md5').update(value).digest('hex');
}

export function getMixinKey(imgKey, subKey) {
  const raw = `${imgKey}${subKey}`;
  return MIXIN_KEY_ENC_TAB.map((index) => raw[index] || '').join('').slice(0, 32);
}

export function extractWbiKeys(navJson) {
  const imgUrl = navJson?.data?.wbi_img?.img_url;
  const subUrl = navJson?.data?.wbi_img?.sub_url;
  if (!imgUrl || !subUrl) {
    throw new Error('nav 响应中没有 WBI 密钥（wbi_img.img_url / sub_url）');
  }
  const imgKey = imgUrl.split('/').pop().split('.')[0];
  const subKey = subUrl.split('/').pop().split('.')[0];
  return { imgKey, subKey, mixinKey: getMixinKey(imgKey, subKey) };
}

/**
 * Bilibili's WBI signing removes !'()* from values, but otherwise uses
 * URLSearchParams-compatible percent encoding. The *same* encoder must be used
 * for both the signature input and the final query string; using
 * URLSearchParams after signing would turn %20 into + and re-encode the
 * filtered characters, breaking the signature.
 */
export function encodeWbiValue(value) {
  return encodeURIComponent(String(value)).replace(/[!'()*]/g, '');
}

export function buildQuery(params, { sort = true } = {}) {
  const keys = Object.keys(params).filter((key) => params[key] !== undefined && params[key] !== null);
  if (sort) keys.sort();
  return keys.map((key) => `${encodeURIComponent(key)}=${encodeWbiValue(params[key])}`).join('&');
}

/**
 * Sign query parameters using Bilibili's WBI scheme.
 * The input object is not mutated; wts/w_rid are returned in a new object.
 */
export function signParams(params, mixinKey, { wts = Math.floor(Date.now() / 1000) } = {}) {
  if (!mixinKey || mixinKey.length !== 32) {
    throw new Error('WBI mixinKey 无效');
  }
  const withTs = { ...params, wts };
  const query = buildQuery(withTs, { sort: true });
  const w_rid = md5(`${query}${mixinKey}`);
  return { ...withTs, w_rid };
}

export function buildSignedQuery(params, mixinKey, options) {
  return buildQuery(signParams(params, mixinKey, options), { sort: true });
}
