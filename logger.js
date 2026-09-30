// logger.js — structured logging.
//
// Every decision the bot makes goes through here. Logs go to:
//   1. Console (colored, human-readable)
//   2. logs/bot-YYYY-MM-DD.log (structured JSON, one line per event)
// Telegram alerts live in notify.js.
//
// The JSON log is the source of truth — sufficient to replay every decision.

import fs from 'fs';
import path from 'path';

const LOG_DIR = process.env.OKX_BOT_LOG_DIR || path.join(process.cwd(), 'logs');
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

export default logger;
