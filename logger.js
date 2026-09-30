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
let fileLogBroken = false;

// The file log is best effort: a full disk or an unwritable log dir must
// never take the caller down, and alert delivery (notify.js) logs through
// here. The first failure is reported once on the console (docker logs).
function fileLogFailed(err) {
  if (fileLogBroken) return;
  fileLogBroken = true;
  console.error(`[logger] file log disabled: ${err.message}`);
}

function ensureLogDir() {
  if (!fs.existsSync(LOG_DIR)) {
    fs.mkdirSync(LOG_DIR, { recursive: true });
  }
}

function getLogStream() {
  const today = new Date().toISOString().slice(0, 10);
  if (today !== currentLogDate) {
    if (logStream) {
      logStream.end();
      logStream = null;
    }
    ensureLogDir();
    currentLogDate = today;
    logStream = fs.createWriteStream(
      path.join(LOG_DIR, `bot-${today}.log`),
      { flags: 'a' }
    );
    // Without a listener, ENOSPC/EACCES on the file would be an uncaughtException.
    logStream.on('error', fileLogFailed);
  }
  return logStream;
}

export function setLogLevel(level) {
  currentLogLevel = LEVELS[level] ?? LEVELS.info;
}

function log(level, message, data = {}) {
  if (LEVELS[level] < currentLogLevel) return;

  const d = data ?? {};
  const entry = {
    ts: new Date().toISOString(),
    level,
    msg: message,
    ...d,
  };

  // File: structured JSON, best effort (see fileLogFailed).
  try {
    getLogStream().write(JSON.stringify(entry) + '\n');
  } catch (err) {
    fileLogFailed(err);
  }

  // Console: human readable
  const color = COLORS[level] || '';
  const reset = COLORS.reset;
  const prefix = `${color}[${entry.ts.slice(11, 19)} ${level.toUpperCase()}]${reset}`;
  let dataStr = '';
  try {
    dataStr = Object.keys(d).length ? ' ' + JSON.stringify(d) : '';
  } catch {
    dataStr = ' [unserializable data]';
  }
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
