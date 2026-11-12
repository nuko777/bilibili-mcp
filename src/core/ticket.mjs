import crypto from 'node:crypto';

export const TICKET_ENDPOINT =
  'https://api.bilibili.com/bapis/bilibili.api.ticket.v1.Ticket/GenWebTicket';
export const TICKET_KEY = 'XgwSnGZ1p';
export const TICKET_KEY_ID = 'ec02';
export const TICKET_TTL_SECONDS = 259200;
export const TICKET_REFRESH_MARGIN_MS = 30 * 60_000;

/**
 * The browser computes HMAC-SHA256("XgwSnGZ1p", "ts" + unixSeconds) and sends
 * the lowercase hex as `hexsign`. Verified against the live GenWebTicket
 * endpoint on 2026-11-13.
 */
export function signTicketTimestamp(timestamp) {
  return crypto.createHmac('sha256', TICKET_KEY).update(`ts${timestamp}`).digest('hex');
}

export function buildTicketParams(timestamp, csrf = '') {
  return {
    key_id: TICKET_KEY_ID,
    hexsign: signTicketTimestamp(timestamp),
    'context[ts]': String(timestamp),
    csrf: csrf || '',
  };
}

/**
 * Refresh when the stored ticket is missing or within the browser's 30-minute
 * margin. auth_status uses this unless the caller explicitly forces a refresh.
 */
export function needsTicketRefresh(cookies = {}, now = Date.now(), marginMs = TICKET_REFRESH_MARGIN_MS) {
  const expires = Number(cookies?.bili_ticket_expires);
  if (!cookies?.bili_ticket || !Number.isFinite(expires) || expires <= 0) return true;
  return expires * 1000 <= now + marginMs;
}
