// notify.js — every Telegram message, tested against a stubbed fetch.
// Run: npm test

import { test, before, beforeEach, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs';
import os from 'os';
import path from 'path';

let notify, dir, sentFile;
const calls = [];         // request bodies posted to Telegram, in order
let nextStatuses = [];    // HTTP statuses for upcoming fetches (default 200)

before(async () => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'okx-notify-test-'));
  process.env.OKX_BOT_LOG_DIR = path.join(dir, 'logs');
  process.env.TELEGRAM_BOT_TOKEN = 'test-token';
  process.env.TELEGRAM_CHAT_ID = '42';
  process.env.DRY_RUN = 'true';
  sentFile = path.join(dir, 'logs', 'alerts_sent.json');
  globalThis.fetch = async (url, opts) => {
    calls.push({ url, body: JSON.parse(opts.body), signal: opts.signal });
    const status = nextStatuses.shift() ?? 200;
    return {
      ok: status === 200,
      status,
      json: async () => (status === 200
        ? { ok: true }
        : { ok: false, description: "Bad Request: can't parse entities" }),
    };
  };
  const { setLogLevel } = await import('../logger.js');
  setLogLevel('error');
  notify = await import('../notify.js');
});

after(() => fs.rmSync(dir, { recursive: true, force: true }));

beforeEach(() => {
  calls.length = 0;
  nextStatuses = [];
  fs.rmSync(sentFile, { force: true });
});

function seedSent(map) {
  fs.mkdirSync(path.dirname(sentFile), { recursive: true });
  fs.writeFileSync(sentFile, typeof map === 'string' ? map : JSON.stringify(map));
}

// ─── Formatting ───────────────────────────────────────────────────────────

test('esc neutralises HTML in dynamic values', () => {
  assert.equal(notify.esc('<b>a & b</b>'), '&lt;b&gt;a &amp; b&lt;/b&gt;');
  assert.equal(notify.esc(undefined), '');
});

test('clip keeps short text and trims long text to n chars', () => {
  assert.equal(notify.clip('abc'), 'abc');
  const long = notify.clip('x'.repeat(500));
  assert.equal(long.length, 300);
  assert.ok(long.endsWith('…'));
});

test('fmtPrice keeps 4 significant digits and never uses exponent notation', () => {
  assert.equal(notify.fmtPrice(0.0000213456), '$0.00002135');
  assert.equal(notify.fmtPrice(1.234e-7), '$0.0000001234');
  assert.equal(notify.fmtPrice(150.234), '$150.2');
  assert.equal(notify.fmtPrice(NaN), 'n/a');
});

test('fmtDuration renders minutes, hours and days', () => {
  assert.equal(notify.fmtDuration(45 * 60_000), '45m');
  assert.equal(notify.fmtDuration((5 * 60 + 12) * 60_000), '5h 12m');
  assert.equal(notify.fmtDuration(30 * 3600_000), '1d 6h');
});

test('fmtSigned uses a real minus sign and fmtInt groups thousands', () => {
  assert.equal(notify.fmtSigned(1.5, '$'), '+$1.50');
  assert.equal(notify.fmtSigned(-2.06, '$'), '−$2.06');
  assert.equal(notify.fmtSigned(0, '', '%'), '0.00%');
  assert.equal(notify.fmtInt(76144), '76,144');
});

test('fmtTime renders day, month, time and zone in the process time zone', () => {
  // TZ is fixed at process start, so assert the shape, not the zone.
  assert.match(notify.fmtTime('2026-09-29T21:40:00Z'), /^\d{1,2} \w+, \d{2}:\d{2} \S+$/);
});

test('humanReason turns codes into words and passes unknown codes through', () => {
  assert.equal(notify.humanReason('trailing_stop_8pct'), 'trailing stop (−8% from peak)');
  assert.equal(notify.humanReason('volume_collapse_73pct'), 'volume collapsed 73% vs entry bar');
  assert.equal(notify.humanReason('three_consecutive_losses'), '3 losses in a row');
  assert.equal(notify.humanReason('hard_stop'), 'hard stop');
  assert.equal(notify.humanReason('something_new'), 'something_new');
});

test('humanSetup reads setup ids', () => {
  assert.equal(notify.humanSetup('smart_money+on_chain_spike__rs'), 'smart money + on chain spike · RS boost');
  assert.equal(notify.humanSetup('smart_money__no_rs'), 'smart money');
});

test('formatters return n/a instead of throwing on missing numbers', () => {
  assert.equal(notify.fmtUsd(undefined), 'n/a');
  assert.equal(notify.fmtSigned(NaN, '$'), 'n/a');
  assert.equal(notify.fmtInt(undefined), 'n/a');
  assert.equal(notify.fmtDuration(NaN), 'n/a');
});

test('fmtSigned drops the sign when the value rounds to zero; fmtInt rounds', () => {
  assert.equal(notify.fmtSigned(-0.004, '$'), '$0.00');
  assert.equal(notify.fmtSigned(0.004, '', '%'), '0.00%');
  assert.equal(notify.fmtInt(1234.5678), '1,235');
});

test('fmtInt never renders a negative zero', () => {
  assert.equal(notify.fmtInt(-0.4), '0');
});

test('clip never splits an emoji in half', () => {
  const s = notify.clip('x'.repeat(298) + '😀😀😀');
  assert.ok(s.isWellFormed());
  assert.ok(s.endsWith('😀…'));
});

test('humanReason ignores inherited object keys', () => {
  assert.equal(notify.humanReason('toString'), 'toString');
});

// ─── Transport ────────────────────────────────────────────────────────────

test('send posts HTML; silent maps to disable_notification', async () => {
  await notify.send('<b>hi</b>', { silent: true });
  await notify.send('<b>loud</b>');
  assert.equal(calls.length, 2);
  assert.equal(calls[0].url, 'https://api.telegram.org/bottest-token/sendMessage');
  assert.deepEqual(calls[0].body, {
    chat_id: '42', text: '<b>hi</b>', parse_mode: 'HTML', disable_notification: true,
  });
  assert.equal(calls[1].body.disable_notification, false);
  assert.ok(calls[0].signal instanceof AbortSignal, 'fetch is abortable (5 s timeout)');
});

test('a 400 (markup rejected) is retried once as plain text', async () => {
  nextStatuses = [400];
  await notify.send('<b>EXIT</b> a &lt; b &amp; c');
  assert.equal(calls.length, 2);
  assert.equal(calls[1].body.text, 'EXIT a < b & c');
  assert.equal(calls[1].body.parse_mode, undefined);
});

test('other HTTP failures are not retried', async () => {
  nextStatuses = [500];
  await notify.send('x');
  assert.equal(calls.length, 1);
});

test('a network error never escapes send', async () => {
  const realFetch = globalThis.fetch;
  globalThis.fetch = async () => { throw new Error('ECONNRESET'); };
  try {
    await assert.doesNotReject(() => notify.send('x'));
  } finally {
    globalThis.fetch = realFetch;
  }
});

test('without Telegram env nothing is posted', async () => {
  const token = process.env.TELEGRAM_BOT_TOKEN;
  delete process.env.TELEGRAM_BOT_TOKEN;
  try {
    await notify.send('x');
    assert.equal(calls.length, 0);
  } finally {
    process.env.TELEGRAM_BOT_TOKEN = token;
  }
});

// ─── Throttle ─────────────────────────────────────────────────────────────

test('throttle: the same key inside the window is sent once and persisted', async () => {
  await notify.send('a', { key: 'k1', everyMs: 60_000 });
  await notify.send('a', { key: 'k1', everyMs: 60_000 });
  assert.equal(calls.length, 1);
  const saved = JSON.parse(fs.readFileSync(sentFile, 'utf-8'));
  assert.equal(typeof saved.k1, 'number');
});

test('throttle: an entry older than the window sends again', async () => {
  seedSent({ k2: Date.now() - 2 * 60_000 });
  await notify.send('a', { key: 'k2', everyMs: 60_000 });
  assert.equal(calls.length, 1);
});

test('throttle: a fresh entry left by a previous process still suppresses (crash loop)', async () => {
  seedSent({ k3: Date.now() - 1000 });
  await notify.send('a', { key: 'k3', everyMs: 60_000 });
  assert.equal(calls.length, 0);
});

test('throttle: a corrupt file counts as empty — worst case a duplicate, never a lost alert', async () => {
  seedSent('{not json');
  await notify.send('a', { key: 'k4', everyMs: 60_000 });
  assert.equal(calls.length, 1);
});

test('throttle: keys older than 7 days are pruned on write', async () => {
  seedSent({ ancient: Date.now() - 8 * 24 * 3600_000 });
  await notify.send('a', { key: 'k5', everyMs: 60_000 });
  const saved = JSON.parse(fs.readFileSync(sentFile, 'utf-8'));
  assert.equal(saved.ancient, undefined);
  assert.equal(typeof saved.k5, 'number');
});

test('the plain-text retry keeps link targets', async () => {
  nextStatuses = [400];
  await notify.send('BUY X\n<a href="https://solscan.io/tx/abc">tx on Solscan</a>');
  assert.equal(calls[1].body.text, 'BUY X\ntx on Solscan (https://solscan.io/tx/abc)');
});

test('send never rejects, even on null options', async () => {
  await assert.doesNotReject(() => notify.send('x', null));
});

test('throttle: a failed delivery does not use up the slot', async () => {
  nextStatuses = [500];
  await notify.send('a', { key: 'k6', everyMs: 60_000 });
  await notify.send('a', { key: 'k6', everyMs: 60_000 });
  assert.equal(calls.length, 2, 'nothing was delivered, so the next send tries again');
});

test('throttle: a plain-text retry that succeeds counts as delivered', async () => {
  nextStatuses = [400];   // HTML rejected, plain text accepted
  await notify.send('<b>a</b>', { key: 'k7', everyMs: 60_000 });
  await notify.send('<b>a</b>', { key: 'k7', everyMs: 60_000 });
  assert.equal(calls.length, 2, 'HTML attempt + plain text, then suppressed');
});

test('throttle: without Telegram credentials nothing is recorded', async () => {
  const token = process.env.TELEGRAM_BOT_TOKEN;
  delete process.env.TELEGRAM_BOT_TOKEN;
  try {
    await notify.send('a', { key: 'k8', everyMs: 60_000 });
  } finally {
    process.env.TELEGRAM_BOT_TOKEN = token;
  }
  await notify.send('a', { key: 'k8', everyMs: 60_000 });
  assert.equal(calls.length, 1);
});

test('throttle: a valid-JSON non-object file counts as empty', async () => {
  seedSent('123');
  await notify.send('a', { key: 'k9', everyMs: 60_000 });
  assert.equal(calls.length, 1);
});

test('throttle: a timestamp in the future (clock stepped back) does not mute alerts', async () => {
  seedSent({ k10: Date.now() + 3600_000 });
  await notify.send('a', { key: 'k10', everyMs: 60_000 });
  assert.equal(calls.length, 1);
});

test('throttle: same-key sends fired together deliver once', async () => {
  await Promise.all([
    notify.send('a', { key: 'k11', everyMs: 60_000 }),
    notify.send('a', { key: 'k11', everyMs: 60_000 }),
  ]);
  assert.equal(calls.length, 1);
});

test('throttle: a network error does not use up the slot (DNS down after a reboot)', async () => {
  const realFetch = globalThis.fetch;
  globalThis.fetch = async () => { throw new Error('getaddrinfo ENOTFOUND api.telegram.org'); };
  try {
    await notify.send('a', { key: 'k12', everyMs: 60_000 });
  } finally {
    globalThis.fetch = realFetch;
  }
  await notify.send('a', { key: 'k12', everyMs: 60_000 });
  assert.equal(calls.length, 1, 'delivered once the network is back');
});
