// The async file-stream error path: the log FILE itself can't be opened
// (here it is a directory). That must never become an uncaughtException.
// Run: npm test

import { test, before } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs';
import os from 'os';
import path from 'path';

let logger;
before(async () => {
  // Unit tests must never reach Telegram, whatever the developer's shell exports.
  delete process.env.TELEGRAM_BOT_TOKEN;
  delete process.env.TELEGRAM_CHAT_ID;
  globalThis.fetch = () => { throw new Error('network is off in unit tests'); };
  const logDir = fs.mkdtempSync(path.join(os.tmpdir(), 'okx-logger-stream-test-'));
  process.env.OKX_BOT_LOG_DIR = logDir;
  fs.mkdirSync(path.join(logDir, `bot-${new Date().toISOString().slice(0, 10)}.log`));
  ({ logger } = await import('../logger.js'));
});

test('a log file that cannot be opened is reported once, never thrown', async (t) => {
  t.mock.method(console, 'log', () => {});
  const err = t.mock.method(console, 'error', () => {});
  const uncaught = [];
  const onUncaught = e => uncaught.push(e);
  process.on('uncaughtException', onUncaught);
  try {
    logger.info('a');
    logger.info('b');
    logger.warn('c');
    await new Promise(r => setTimeout(r, 200));   // let the async open fail
    assert.equal(uncaught.length, 0, 'no uncaughtException');
    assert.equal(err.mock.calls.length, 1, 'one console notice');
    assert.match(String(err.mock.calls[0].arguments[0]), /file log disabled/);
  } finally {
    process.off('uncaughtException', onUncaught);
  }
});
