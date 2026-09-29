// notify.js — every Telegram message the bot can send, in one place.
//
// To know what can land on your phone, read this file top to bottom.
//
// Tiers:
//   loud   — act now: can't start, crashed, unhandled error, blind,
//            exit blocked/failing, untracked position, HALTED,
//            stopped with open positions
//   normal — trades: BUY, EXIT, BUY blocked
//   silent — FYI, no sound: started, stopped flat, recovered, scale-out,
//            SLOW, back to NORMAL, profit target, daily report, weekly heartbeat
//
// Transport: Bot API sendMessage with parse_mode HTML; every dynamic value
// goes through esc(). If Telegram still rejects the markup (HTTP 400) the
// message is re-sent once as plain text — a formatting slip must never eat
// an alert. Repeating alerts are throttled per key, and the last-sent map is
// persisted next to the logs so a Docker crash-restart loop can't spam.

import fs from 'fs';
import path from 'path';
import { logger } from './logger.js';

const TELEGRAM_TIMEOUT_MS = 5_000;
const MAX_DYNAMIC_CHARS = 300;             // Telegram's hard limit is 4096
const THROTTLE_KEEP_MS = 7 * 24 * 3600_000;
const HOUR = 3600_000;

// ─── Formatting ────────────────────────────────────────────────────────────

export function esc(v) {
  return String(v ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

export function clip(v, n = MAX_DYNAMIC_CHARS) {
  const chars = Array.from(String(v ?? ''));   // code points: never split an emoji
  return chars.length > n ? chars.slice(0, n - 1).join('') + '…' : chars.join('');
}

// "29 Sept, 23:40 CEST" in the process time zone — set TZ (e.g.
// Europe/Warsaw) in .env; unset means UTC.
export function fmtTime(ts) {
  return new Date(ts).toLocaleString('en-GB', {
    day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit', timeZoneName: 'short',
  });
}

export function fmtDuration(ms) {
  if (!Number.isFinite(ms)) return 'n/a';
  const m = Math.max(0, Math.round(ms / 60_000));
  if (m < 60) return `${m}m`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ${m % 60}m`;
  return `${Math.floor(h / 24)}d ${h % 24}h`;
}

// 4 significant digits and never exponent notation, so BONK-sized prices
// stay readable ($0.00002135, not 2.135e-5 or 0.0000213456789012).
export function fmtPrice(usd) {
  if (!Number.isFinite(usd)) return 'n/a';
  return '$' + usd.toLocaleString('en-US', { maximumSignificantDigits: 4 });
}

export function fmtUsd(v) {
  return Number.isFinite(v) ? '$' + v.toFixed(2) : 'n/a';
}

// The sign follows the rounded value, so −0.004 reads "0.00", not "−0.00".
export function fmtSigned(v, prefix = '', suffix = '') {
  if (!Number.isFinite(v)) return 'n/a';
  const abs = Math.abs(v).toFixed(2);
  const sign = abs === '0.00' ? '' : v > 0 ? '+' : '−';
  return `${sign}${prefix}${abs}${suffix}`;
}

export function fmtInt(n) {
  return Number.isFinite(n) ? (Math.round(n) + 0).toLocaleString('en-US') : 'n/a';
}

const REASONS = {
  hard_stop: 'hard stop',
  time_stop_5d: 'time stop (held 5 days)',
  catalyst_death: 'catalyst gone',
  three_consecutive_losses: '3 losses in a row',
  daily_loss_limit: 'daily loss limit hit',
  two_losses_today: '2 losses today',
  half_daily_loss: 'daily loss past half the limit',
  low_exit_quality: 'recent exits gave back most of their peak gains',
};

export function humanReason(code) {
  if (Object.hasOwn(REASONS, code)) return REASONS[code];
  let m;
  if ((m = /^trailing_stop_(\d+)pct$/.exec(code))) return `trailing stop (−${m[1]}% from peak)`;
  if ((m = /^volume_collapse_(\d+)pct$/.exec(code))) return `volume collapsed ${m[1]}% vs entry bar`;
  return String(code);
}

// "smart_money+on_chain_spike__rs" → "smart money + on chain spike · RS boost"
export function humanSetup(id) {
  const [cats, rs] = String(id ?? '').split('__');
  const label = cats.split('+').map(c => c.replace(/_/g, ' ')).join(' + ');
  return rs === 'rs' ? `${label} · RS boost` : label;
}

const isDryRun = () => process.env.DRY_RUN !== 'false';
const dryTag = () => (isDryRun() ? ' · DRY' : '');
const modeLabel = () => (isDryRun() ? 'DRY RUN' : 'LIVE');

// Solana signatures are base58, ~88 chars. Order ids are shown as plain
// code rather than as a dead link; dry runs have no tx to show.
function txLine(txId) {
  if (!txId || isDryRun()) return '';
  if (/^[1-9A-HJ-NP-Za-km-z]{80,90}$/.test(txId)) {
    return `\n<a href="https://solscan.io/tx/${txId}">tx on Solscan</a>`;
  }
  return `\ntx: <code>${esc(txId)}</code>`;
}

// ─── Transport ─────────────────────────────────────────────────────────────

function sentFile() {
  const dir = process.env.OKX_BOT_LOG_DIR || path.join(process.cwd(), 'logs');
  return path.join(dir, 'alerts_sent.json');
}

function readSent() {
  try {
    const sent = JSON.parse(fs.readFileSync(sentFile(), 'utf-8'));
    // Anything but a plain object (hand-edited, truncated…) counts as empty.
    return sent && typeof sent === 'object' && !Array.isArray(sent) ? sent : {};
  } catch {
    return {};   // first run or corrupt file
  }
}

// True when `key` was delivered less than `everyMs` ago. A timestamp in the
// future (clock stepped back) doesn't count, so it can't mute alerts.
function isThrottled(key, everyMs, now = Date.now()) {
  const at = readSent()[key];
  return typeof at === 'number' && at <= now && now - at < everyMs;
}

// Called only after Telegram accepted the message: a failed delivery must
// not use up the slot, or DNS being down right after a VPS reboot would
// mute exactly the alerts this exists for. Worst case: one duplicate.
function markSent(key, now = Date.now()) {
  const sent = readSent();
  sent[key] = now;
  for (const k of Object.keys(sent)) {
    const age = now - sent[k];
    if (!(age >= 0 && age < THROTTLE_KEEP_MS)) delete sent[k];
  }
  try {
    fs.mkdirSync(path.dirname(sentFile()), { recursive: true });
    fs.writeFileSync(sentFile(), JSON.stringify(sent));
  } catch (err) {
    logger.warn('alerts_sent_write_failed', { error: err.message });
  }
}

// Returns the HTTP status, or null on timeout / network error.
async function post(token, body) {
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), TELEGRAM_TIMEOUT_MS);
  try {
    const res = await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
      signal: controller.signal,
    });
    if (!res.ok) {
      const description = await res.json().then(j => j?.description ?? null).catch(() => null);
      logger.warn('telegram_send_failed', { status: res.status, description });
    }
    return res.status;
  } catch (err) {
    if (err.name === 'AbortError') {
      logger.warn('telegram_timeout', { timeout_ms: TELEGRAM_TIMEOUT_MS });
    } else {
      logger.warn('telegram_error', { error: err.message });
    }
    return null;
  } finally {
    clearTimeout(timeoutId);
  }
}

function toPlainText(html) {
  return html
    .replace(/<a href="([^"]*)">([^<]*)<\/a>/g, '$2 ($1)')
    .replace(/<[^>]+>/g, '')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&amp;/g, '&');
}

// Keys being delivered right now. The record happens only after delivery,
// so without this a burst of same-key alerts (e.g. several rejections with
// the same message) would all pass the check and all go out.
const inFlight = new Set();

// Never throws: alert delivery must not affect trading decisions.
// opts: { silent = false, key = null, everyMs = 0 }
export async function send(html, opts) {
  try {
    const { silent = false, key = null, everyMs = 0 } = opts ?? {};
    if (key && (inFlight.has(key) || isThrottled(key, everyMs))) {
      logger.info('alert_throttled', { key });
      return;
    }
    logger.info('alert', { message: html, silent });

    const token = process.env.TELEGRAM_BOT_TOKEN;
    const chat = process.env.TELEGRAM_CHAT_ID;
    if (!token || !chat) return;

    if (key) inFlight.add(key);
    try {
      let status = await post(token, {
        chat_id: chat, text: html, parse_mode: 'HTML', disable_notification: silent,
      });
      if (status === 400) {
        // Markup rejected → the same content as plain text rather than nothing.
        status = await post(token, { chat_id: chat, text: toPlainText(html), disable_notification: silent });
      }
      if (key && status === 200) markSent(key);
    } finally {
      if (key) inFlight.delete(key);
    }
  } catch (err) {
    logger.warn('alert_failed', { error: err.message });
  }
}
