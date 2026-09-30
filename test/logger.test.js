// logger.js must never throw: alert delivery (notify.js) logs through it,
// so a broken log dir would otherwise silence every alert. Run: npm test

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
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'okx-logger-test-'));
  const notADir = path.join(dir, 'file');
  fs.writeFileSync(notADir, '');
  process.env.OKX_BOT_LOG_DIR = path.join(notADir, 'logs');   // mkdir fails: ENOTDIR
  ({ logger } = await import('../logger.js'));
});

test('an unusable log dir never makes logging throw, and is reported once', (t) => {
  t.mock.method(console, 'log', () => {});
  const err = t.mock.method(console, 'error', () => {});
  assert.doesNotThrow(() => logger.info('x', { a: 1 }));
  assert.doesNotThrow(() => logger.error('y'));
  assert.equal(err.mock.calls.length, 1, 'one console notice, not one per line');
  assert.match(String(err.mock.calls[0].arguments[0]), /file log disabled/);
});

test('unserializable or null data never makes logging throw', (t) => {
  t.mock.method(console, 'log', () => {});
  t.mock.method(console, 'error', () => {});
  const circular = {};
  circular.self = circular;
  assert.doesNotThrow(() => logger.warn('z', circular));
  assert.doesNotThrow(() => logger.info('n', null));
});

test('alerts still reach Telegram when the log dir is unusable', async (t) => {
  t.mock.method(console, 'log', () => {});
  t.mock.method(console, 'error', () => {});
  const posted = [];
  const realFetch = globalThis.fetch;
  globalThis.fetch = async (url, opts) => {
    posted.push(JSON.parse(opts.body));
    return { ok: true, status: 200, json: async () => ({ ok: true }) };
  };
  process.env.TELEGRAM_BOT_TOKEN = 'test-token';
  process.env.TELEGRAM_CHAT_ID = '42';
  try {
    const notify = (await import('../notify.js')).default;
    await assert.doesNotReject(() => notify.cannotStart('cli_unrunnable', 'x', 'y'));
    assert.equal(posted.length, 1);
    assert.match(posted[0].text, /okx-bot DOWN/);
  } finally {
    globalThis.fetch = realFetch;
    delete process.env.TELEGRAM_BOT_TOKEN;
    delete process.env.TELEGRAM_CHAT_ID;
  }
});

test('data that fights the entry (own ts, throwing getter, bad toJSON) never makes logging throw', (t) => {
  t.mock.method(console, 'log', () => {});
  t.mock.method(console, 'error', () => {});
  assert.doesNotThrow(() => logger.info('x', { ts: 123 }));
  assert.doesNotThrow(() => logger.info('x', { get boom() { throw new Error('getter'); } }));
  assert.doesNotThrow(() => logger.info('x', { toJSON() { throw null; } }));
});
