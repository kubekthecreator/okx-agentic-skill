// logger.js — structured logging with Telegram alerts
//
// Every decision the bot makes goes through here. Logs go to:
//   1. Console (colored, human-readable)
//   2. logs/bot-YYYY-MM-DD.log (structured JSON, one line per event)
//   3. Telegram (for material events only — entries, exits, state changes)
//
// The JSON log is the source of truth — sufficient to replay every decision.

import fs from 'fs';
import path from 'path';

const LOG_DIR = path.join(process.cwd(), 'logs');
const LEVELS = { debug: 0, info: 1, warn: 2, error: 3 };
const COLORS = {
  debug: '\x1b[90m',  // gray
  info: '\x1b[36m',   // cyan
  warn: '\x1b[33m',   // yellow
  error: '\x1b[31m',  // red
  reset: '\x1b[0m',
};

let currentLogLevel = LEVELS.info;
let logStream = null;
let currentLogDate = null;

function ensureLogDir() {
  if (!fs.existsSync(LOG_DIR)) {
    fs.mkdirSync(LOG_DIR, { recursive: true });
  }
}

function getLogStream() {
  const today = new Date().toISOString().slice(0, 10);
  if (today !== currentLogDate) {
    if (logStream) logStream.end();
    ensureLogDir();
    currentLogDate = today;
    logStream = fs.createWriteStream(
      path.join(LOG_DIR, `bot-${today}.log`),
      { flags: 'a' }
    );
  }
  return logStream;
}

export function setLogLevel(level) {
  currentLogLevel = LEVELS[level] ?? LEVELS.info;
}

function log(level, message, data = {}) {
  if (LEVELS[level] < currentLogLevel) return;

  const entry = {
    ts: new Date().toISOString(),
    level,
    msg: message,
    ...data,
  };

  // File: structured JSON
  getLogStream().write(JSON.stringify(entry) + '\n');

  // Console: human readable
  const color = COLORS[level] || '';
  const reset = COLORS.reset;
  const prefix = `${color}[${entry.ts.slice(11, 19)} ${level.toUpperCase()}]${reset}`;
  const dataStr = Object.keys(data).length
    ? ' ' + JSON.stringify(data)
    : '';
  console.log(`${prefix} ${message}${dataStr}`);
}

export const logger = {
  debug: (msg, data) => log('debug', msg, data),
  info: (msg, data) => log('info', msg, data),
  warn: (msg, data) => log('warn', msg, data),
  error: (msg, data) => log('error', msg, data),
  // Best-effort sync flush. Called from shutdown handlers so the last few
  // lines (including the shutdown sequence itself) hit disk before exit.
  flush: () => {
    try {
      if (logStream && !logStream.destroyed) {
        logStream.end();
      }
    } catch (_) { /* ignore */ }
  },
};

// ─── Telegram ──────────────────────────────────────────────────────────────

const TG_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const TG_CHAT = process.env.TELEGRAM_CHAT_ID;

const TELEGRAM_TIMEOUT_MS = 5_000;

export async function alert(message, opts = {}) {
  // Always log
  logger.info('alert', { message, ...opts });

  if (!TG_TOKEN || !TG_CHAT) return;

  // Bound the fetch so a stalled Telegram API (or DNS) can never block a
  // tick. Strategy decisions don't depend on alert delivery succeeding.
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), TELEGRAM_TIMEOUT_MS);

  try {
    const url = `https://api.telegram.org/bot${TG_TOKEN}/sendMessage`;
    const body = {
      chat_id: TG_CHAT,
      text: message,
      parse_mode: 'Markdown',
      disable_notification: opts.silent || false,
    };
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
      signal: controller.signal,
    });
    if (!res.ok) {
      logger.warn('telegram_send_failed', { status: res.status });
    }
  } catch (err) {
    if (err.name === 'AbortError') {
      logger.warn('telegram_timeout', { timeout_ms: TELEGRAM_TIMEOUT_MS });
    } else {
      logger.warn('telegram_error', { error: err.message });
    }
  } finally {
    clearTimeout(timeoutId);
  }
}

// Material-decision alert.
//
// Intent: surface large / risky entries to the operator BEFORE they execute,
// even though v0.1 cannot poll Telegram for a STOP reply. The honest framing
// is "you're being notified", not "you have 2 minutes to cancel" (which the
// previous wording falsely implied).
//
// Returns false unconditionally — the strategy treats the lack of veto as
// "proceed", which is intentional so the bot doesn't stall when the operator
// is asleep. Polling getUpdates for an actual STOP reply is a roadmap item.
export async function alertWithVeto(message) {
  await alert(`⏸️ *Material decision* ${message}\n\n_v0.1 alerts but does not poll for replies; trade proceeds._`);
  return false;
}

export default logger;
