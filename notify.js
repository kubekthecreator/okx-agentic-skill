// notify.js — every Telegram message the bot can send, in one place.
//
// To know what can land on your phone, read this file top to bottom.
//
// Tiers:
//   loud   — act now: can't start, crashed, blind, exit blocked/failing,
//            untracked position, HALTED, stopped with open positions
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
  const s = String(v ?? '');
  return s.length > n ? s.slice(0, n - 1) + '…' : s;
}

// "29 Sept, 23:40 CEST" in the process time zone — set TZ (e.g.
// Europe/Warsaw) in .env; unset means UTC.
export function fmtTime(ts) {
  return new Date(ts).toLocaleString('en-GB', {
    day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit', timeZoneName: 'short',
  });
}

export function fmtDuration(ms) {
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
  return '$' + v.toFixed(2);
}

export function fmtSigned(v, prefix = '', suffix = '') {
  const sign = v > 0 ? '+' : v < 0 ? '−' : '';
  return `${sign}${prefix}${Math.abs(v).toFixed(2)}${suffix}`;
}

export function fmtInt(n) {
  return n.toLocaleString('en-US');
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
  if (REASONS[code]) return REASONS[code];
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

// True when `key` was sent less than `everyMs` ago (→ suppress); otherwise
// records this send. A missing or corrupt file counts as empty: worst case
// one duplicate alert, never a lost one.
function throttled(key, everyMs, now = Date.now()) {
  let sent = {};
  try {
    sent = JSON.parse(fs.readFileSync(sentFile(), 'utf-8')) || {};
  } catch { /* first run or corrupt file */ }
  if (typeof sent[key] === 'number' && now - sent[key] < everyMs) return true;
  sent[key] = now;
  for (const k of Object.keys(sent)) {
    if (!(now - sent[k] < THROTTLE_KEEP_MS)) delete sent[k];
  }
  try {
    fs.mkdirSync(path.dirname(sentFile()), { recursive: true });
    fs.writeFileSync(sentFile(), JSON.stringify(sent));
  } catch (err) {
    logger.warn('alerts_sent_write_failed', { error: err.message });
  }
  return false;
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
    .replace(/<[^>]+>/g, '')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&amp;/g, '&');
}

// Never throws: alert delivery must not affect trading decisions.
export async function send(html, { silent = false, key = null, everyMs = 0 } = {}) {
  try {
    if (key && throttled(key, everyMs)) {
      logger.info('alert_throttled', { key });
      return;
    }
    logger.info('alert', { message: html, silent });

    const token = process.env.TELEGRAM_BOT_TOKEN;
    const chat = process.env.TELEGRAM_CHAT_ID;
    if (!token || !chat) return;

    const status = await post(token, {
      chat_id: chat, text: html, parse_mode: 'HTML', disable_notification: silent,
    });
    if (status === 400) {
      // Markup rejected → the same content as plain text rather than nothing.
      await post(token, { chat_id: chat, text: toPlainText(html), disable_notification: silent });
    }
  } catch (err) {
    logger.warn('alert_failed', { error: err.message });
  }
}
