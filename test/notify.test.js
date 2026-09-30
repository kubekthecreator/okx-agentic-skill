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
  assert.equal(notify.fmtDuration(2 * 3600_000), '2h');
  assert.equal(notify.fmtDuration(48 * 3600_000), '2d');
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

test('fmtTime returns n/a for a missing or invalid time', () => {
  assert.equal(notify.fmtTime(undefined), 'n/a');
  assert.equal(notify.fmtTime(null), 'n/a');
  assert.equal(notify.fmtTime('not a date'), 'n/a');
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

// ─── Tick health (blind detector) ─────────────────────────────────────────

// The BLIND tests share one module state, including the 30-min BLIND
// window: keep the t0 values of BLIND-sending tests at least 30 min apart.
test('tickResult: the 5th consecutive failure alerts once (loud), recovery once (silent)', async () => {
  const t0 = Date.parse('2026-09-30T10:00:00Z');
  await notify.tickResult(true, null, t0);   // clean slate
  for (let i = 0; i < 4; i++) await notify.tickResult(false, 'cli_call_failed', t0 + i * 65_000);
  assert.equal(calls.length, 0, 'no alert before the 5th failure');
  await notify.tickResult(false, 'wallet balance: session expired', t0 + 4 * 65_000);
  assert.equal(calls.length, 1);
  assert.match(calls[0].body.text, /BLIND/);
  assert.match(calls[0].body.text, /session expired/);
  assert.equal(calls[0].body.disable_notification, false);
  await notify.tickResult(false, 'still failing', t0 + 5 * 65_000);
  assert.equal(calls.length, 1, 'one alert per incident');
  await notify.tickResult(true, null, t0 + 20 * 60_000);
  assert.equal(calls.length, 2);
  assert.match(calls[1].body.text, /recovered<\/b> after 20m/);
  assert.equal(calls[1].body.disable_notification, true);
  await notify.tickResult(true, null, t0 + 21 * 60_000);
  assert.equal(calls.length, 2, 'no repeated recovery note');
});

test('tickResult: short blips below the threshold stay silent', async () => {
  await notify.tickResult(true);
  for (let i = 0; i < 4; i++) await notify.tickResult(false, 'blip');
  await notify.tickResult(true);
  assert.equal(calls.length, 0);
});

test('tickResult: a success resets the count; a flapping second incident waits out the 30-min BLIND window', async () => {
  const t0 = Date.parse('2026-09-30T12:00:00Z');
  await notify.tickResult(true, null, t0);   // clean slate
  for (let i = 0; i < 3; i++) await notify.tickResult(false, 'x', t0);
  await notify.tickResult(true, null, t0);
  for (let i = 0; i < 3; i++) await notify.tickResult(false, 'x', t0);
  assert.equal(calls.length, 0, '3 + 3 failures split by a success are not 5 in a row');
  for (let i = 0; i < 2; i++) await notify.tickResult(false, 'x', t0);
  assert.equal(calls.length, 1, 'the 5th consecutive failure alerts');
  await notify.tickResult(true, null, t0 + 60_000);   // silent recovery note
  for (let i = 0; i < 5; i++) await notify.tickResult(false, 'y', t0 + 120_000);
  assert.equal(calls.length, 2, 'blind again within 30 min of the last BLIND: quiet (flapping)');
  await notify.tickResult(false, 'y', t0 + 31 * 60_000);
  assert.equal(calls.length, 3, 'still blind after the window: BLIND again');
  assert.match(calls[2].body.text, /BLIND/);
  await notify.tickResult(true, null, t0 + 32 * 60_000);   // leave a clean slate
});

test('tickResult: a BLIND alert Telegram did not take is retried on the next failed tick', async () => {
  const t0 = Date.parse('2026-09-30T14:00:00Z');
  await notify.tickResult(true, null, t0);
  for (let i = 0; i < 4; i++) await notify.tickResult(false, 'x', t0);
  nextStatuses = [500];
  await notify.tickResult(false, 'x', t0);   // 5th: delivery fails
  await notify.tickResult(false, 'x', t0);   // 6th: retried and delivered
  await notify.tickResult(false, 'x', t0);   // 7th: already delivered, stays quiet
  assert.equal(calls.length, 2);
  assert.match(calls[1].body.text, /BLIND<\/b> — 6 ticks failed in a row/);
  await notify.tickResult(true, null, t0);
});

test('tickResult: a failure without an error message still renders', async () => {
  const t0 = Date.parse('2026-09-30T15:00:00Z');
  await notify.tickResult(true, null, t0);
  for (let i = 0; i < 4; i++) await notify.tickResult(false, undefined, t0);
  await notify.tickResult(false, '', t0);   // an Error with an empty message
  assert.match(calls[0].body.text, /Last error: <code>unknown<\/code>/);
  await notify.tickResult(true, null, t0);
});

// ─── Reports ──────────────────────────────────────────────────────────────

const quietDay = {
  date: '2026-09-29', starting_portfolio_usd: 9.68,
  trades: 0, wins: 0, losses: 0, consecutive_losses: 0, realized_pnl_usd: 0,
};

// dailyReport resets the day counters; earlier tests leave failures in them.
async function drainDayCounters() {
  await notify.dailyReport({ day: quietDay, portfolio_usd: 0, open_positions: [] });
  calls.length = 0;
}

test('dailyReport: a quiet day sends nothing', async () => {
  await drainDayCounters();
  await notify.tickResult(true);
  await notify.dailyReport({ day: quietDay, portfolio_usd: 9.68, open_positions: [] });
  assert.equal(calls.length, 0);
});

test('dailyReport: an active day is reported silently from the ended day', async () => {
  await drainDayCounters();
  await notify.tickResult(true);
  await notify.dailyReport({
    day: { ...quietDay, trades: 2, wins: 1, losses: 1, realized_pnl_usd: 0.84 },
    portfolio_usd: 10.52,
    open_positions: [{ symbol: 'JUP', pnl_pct: 3.2, held_ms: 5 * 3600_000 }],
  });
  assert.equal(calls.length, 1);
  const { text, disable_notification } = calls[0].body;
  assert.equal(disable_notification, true);
  assert.match(text, /Day 2026-09-29<\/b> \(UTC\) · DRY RUN/);
  assert.match(text, /Trades 2 \(1W \/ 1L\) · realized \+\$0\.84/);
  assert.match(text, /Portfolio \$10\.52\n/, 'DRY RUN shows no wallet delta');
  assert.match(text, /Open: JUP \+3\.20% \(held 5h\)/);
  assert.match(text, /Health: 1 ticks, 0 failed/);
});

test('dailyReport: failed ticks alone make a day worth reporting', async () => {
  await drainDayCounters();
  await notify.tickResult(false, 'blip');
  await notify.tickResult(true);
  await notify.dailyReport({ day: quietDay, portfolio_usd: 9.68, open_positions: [] });
  assert.equal(calls.length, 1);
  assert.match(calls[0].body.text, /Health: 2 ticks, 1 failed/);
});

test('dailyReport: LIVE shows the wallet change since day start', async () => {
  await drainDayCounters();
  process.env.DRY_RUN = 'false';
  try {
    await notify.dailyReport({
      day: { ...quietDay, trades: 1, wins: 1, realized_pnl_usd: 0.5 },
      portfolio_usd: 10.18,
      open_positions: [],
    });
    assert.match(calls[0].body.text, /Portfolio \$10\.18 \(\+\$0\.50 since day start\)/);
  } finally {
    process.env.DRY_RUN = 'true';
  }
});

test('weeklyHeartbeat: always sent, silent, with the entry-filter breakdown', async () => {
  await notify.weeklyHeartbeat({
    portfolio_usd: 9.68,
    week: { trades: 0, wins: 0, pnl_usd: 0 },
    funnel: { checked: 1000, trend_failed: 700, momentum_failed: 250, no_data: 50 },
  });
  assert.equal(calls.length, 1);
  const { text, disable_notification } = calls[0].body;
  assert.equal(disable_notification, true);
  assert.match(text, /okx-bot weekly<\/b> · DRY RUN · since /);
  assert.match(text, /portfolio \$9\.68/);
  assert.match(text, /Trades 0 \(0W \/ 0L\)/);
  assert.match(text, /1,000 token checks: trend ✗ 700 · momentum ✗ 250 · no candles 50/);
});

test('dailyReport: open positions alone make a day worth reporting', async () => {
  await drainDayCounters();
  await notify.tickResult(true);
  await notify.dailyReport({
    day: quietDay,
    portfolio_usd: 9.68,
    open_positions: [{ symbol: 'WIF', pnl_pct: null, held_ms: 3600_000 }],
  });
  assert.equal(calls.length, 1);
  assert.match(calls[0].body.text, /Open: WIF n\/a \(held 1h\)/);
});

async function drainWeekCounters() {
  await notify.weeklyHeartbeat({ portfolio_usd: 0, week: { trades: 0, wins: 0, pnl_usd: 0 }, funnel: {} });
  calls.length = 0;
}

test('weeklyHeartbeat: counts ticks since the last heartbeat, then starts over', async () => {
  await drainWeekCounters();
  await notify.tickResult(true);
  await notify.tickResult(false, 'x');
  await notify.tickResult(true);
  const week = { trades: 0, wins: 0, pnl_usd: 0 };
  await notify.weeklyHeartbeat({ portfolio_usd: 9.68, week, funnel: {} });
  await notify.weeklyHeartbeat({ portfolio_usd: 9.68, week, funnel: {} });
  assert.match(calls[0].body.text, /3 ticks, 1 failed/);
  assert.match(calls[1].body.text, /0 ticks, 0 failed/);
  assert.match(calls[1].body.text, /token checks: none$/);
});

test('weeklyHeartbeat: rejections listed biggest first; unknown outcomes by their key; zeros dropped', async () => {
  await notify.weeklyHeartbeat({
    portfolio_usd: 9.68,
    week: { trades: 0, wins: 0, pnl_usd: 0 },
    funnel: { checked: 100, no_data: 5, trend_failed: 60, something_new: 7, momentum_failed: 0 },
  });
  assert.match(calls[0].body.text, /100 token checks: trend ✗ 60 · something_new 7 · no candles 5$/);
});

test('send reports whether the alert was handled', async () => {
  assert.equal(await notify.send('a'), true, 'delivered');
  nextStatuses = [500];
  assert.equal(await notify.send('b'), false, 'Telegram refused');
  assert.equal(await notify.send('c', { key: 'k14', everyMs: 60_000 }), true);
  assert.equal(await notify.send('c', { key: 'k14', everyMs: 60_000 }), true, 'throttled on purpose counts as handled');
  const token = process.env.TELEGRAM_BOT_TOKEN;
  delete process.env.TELEGRAM_BOT_TOKEN;
  try {
    assert.equal(await notify.send('d'), true, 'not configured: nothing to retry');
  } finally {
    process.env.TELEGRAM_BOT_TOKEN = token;
  }
});

// ─── Lifecycle ────────────────────────────────────────────────────────────

test('started is silent; stopped is silent when flat and loud with open positions', async () => {
  await notify.started({ portfolio_usd: 9.68, open_positions: 0 });
  await notify.stopped({ signal: 'SIGTERM', open_positions: 0 });
  await notify.stopped({ signal: 'SIGTERM', open_positions: 2 });
  assert.deepEqual(calls.map(c => c.body.disable_notification), [true, true, false]);
  assert.match(calls[0].body.text, /okx-bot started<\/b> · DRY RUN\nPortfolio \$9\.68 · open positions 0/);
  assert.match(calls[2].body.text, /2 open positions — stops are NOT enforced until it runs again/);
});

test('cannotStart is loud and repeats at most every 6h, even across restarts', async () => {
  await notify.cannotStart('cli_not_logged_in', 'the onchainos CLI is not logged in', 're-login');
  await notify.cannotStart('cli_not_logged_in', 'the onchainos CLI is not logged in', 're-login');
  assert.equal(calls.length, 1);
  assert.equal(calls[0].body.disable_notification, false);
  assert.match(calls[0].body.text, /okx-bot DOWN<\/b> — can't start: the onchainos CLI is not logged in/);
  assert.match(calls[0].body.text, /Fix: re-login/);
  const saved = JSON.parse(fs.readFileSync(sentFile, 'utf-8'));
  assert.equal(typeof saved['cannot_start:cli_not_logged_in'], 'number', 'persisted for the next process');
});

test('crashed and unhandled are loud and throttled per message', async () => {
  await notify.crashed('boom');
  await notify.crashed('boom');
  await notify.unhandled('oops');
  assert.equal(calls.length, 2);
  assert.match(calls[0].body.text, /crashed<\/b> — restarting\n<code>boom<\/code>/);
  assert.equal(calls[1].body.disable_notification, false);
});

// ─── Trades ───────────────────────────────────────────────────────────────

test('buy: size, share of portfolio, readable price, setup and exit plan; DRY run shows no tx', async () => {
  await notify.buy({
    symbol: 'BONK', size_usd: 12.4, pct_of_portfolio: 25, entry_price_usd: 0.0000213456,
    setup_id: 'smart_money__rs', hard_stop_pct: 10, trailing_pct: 8, scale_out_pcts: [15, 30, 50],
    tx_id: 'dry-entry-123',
  });
  const { text, disable_notification } = calls[0].body;
  assert.equal(disable_notification, false);
  assert.match(text, /BUY BONK<\/b> \$12\.40 \(25% of portfolio\) · DRY/);
  assert.match(text, /Entry \$0\.00002135 · setup: smart money · RS boost/);
  assert.match(text, /stop \$0\.00001921 \(−10%\) · trail 8% · scale-outs at \+15%\/\+30%\/\+50%/);
  assert.doesNotMatch(text, /Solscan|tx:/);
});

test('buy: LIVE links a Solana signature to Solscan and drops the DRY tag', async () => {
  process.env.DRY_RUN = 'false';
  try {
    const sig = '5'.repeat(88);
    await notify.buy({
      symbol: 'JUP', size_usd: 20, pct_of_portfolio: 20, entry_price_usd: 0.41,
      setup_id: 'smart_money__no_rs', hard_stop_pct: 10, trailing_pct: 8, scale_out_pcts: [15, 30, 50],
      tx_id: sig,
    });
    assert.match(calls[0].body.text, new RegExp(`<a href="https://solscan\\.io/tx/${sig}">`));
    assert.doesNotMatch(calls[0].body.text, /DRY/);
  } finally {
    process.env.DRY_RUN = 'true';
  }
});

test('buy: LIVE with a non-signature tx id (order id) shows it as code, not a link', async () => {
  process.env.DRY_RUN = 'false';
  try {
    await notify.buy({
      symbol: 'JUP', size_usd: 20, pct_of_portfolio: 20, entry_price_usd: 0.41,
      setup_id: 'smart_money__no_rs', hard_stop_pct: 10, trailing_pct: 8, scale_out_pcts: [15, 30, 50],
      tx_id: 'order-123',
    });
    assert.match(calls[0].body.text, /\ntx: <code>order-123<\/code>$/);
    assert.doesNotMatch(calls[0].body.text, /Solscan/);
  } finally {
    process.env.DRY_RUN = 'true';
  }
});

test('buyBlocked is throttled per token for 6h and escapes CLI text', async () => {
  await notify.buyBlocked({ symbol: 'JUP', message: 'use <force> & retry_now_', next: 'a_b*c' });
  await notify.buyBlocked({ symbol: 'JUP', message: 'use <force> & retry_now_', next: 'a_b*c' });
  await notify.buyBlocked({ symbol: 'WIF', message: 'risk warning', next: null });
  assert.equal(calls.length, 2);
  assert.match(calls[0].body.text, /use &lt;force&gt; &amp; retry_now_/);
  assert.match(calls[1].body.text, /CLI next step: <code>see CLI output<\/code>/);
});

test('untracked is loud', async () => {
  await notify.untracked({ symbol: 'JUP', tx_id: 'dry-entry-1' });
  assert.equal(calls[0].body.disable_notification, false);
  assert.match(calls[0].body.text, /BUY JUP NOT tracked<\/b> · DRY/);
});

test('scaleOut is silent', async () => {
  await notify.scaleOut({ symbol: 'JUP', level_pct: 15, fraction: 0.2, proceeds_usd: 2.84, booked_usd: 0.37 });
  assert.equal(calls[0].body.disable_notification, true);
  assert.match(calls[0].body.text, /SCALE-OUT JUP<\/b> at \+15% · DRY\nSold 20% for \$2\.84 · booked \+\$0\.37/);
});

test('exit: PnL, reason in words, hold time, today and close notes in ONE message', async () => {
  await notify.exit({
    symbol: 'JUP', realized_pnl_pct: 12.4, realized_pnl_usd: 1.54, reason: 'trailing_stop_8pct',
    peak_pnl_pct: 20.1, exit_quality: 0.617, hold_ms: 30 * 3600_000,
    day: { realized_pnl_usd: 1.54, wins: 1, losses: 0 },
    close: {
      cooldown_until: '2026-09-30T21:40:00Z',
      setup_halt: { setup_id: 'smart_money__rs', until: '2026-10-01T19:40:00Z', wins: 1, trades: 6 },
    },
  });
  assert.equal(calls.length, 1, 'one message, not three');
  const { text, disable_notification } = calls[0].body;
  assert.equal(disable_notification, false);
  assert.match(text, /✅ <b>EXIT JUP<\/b> \+12\.40% \(\+\$1\.54\) · DRY/);
  assert.match(text, /Why: trailing stop \(−8% from peak\) · peak \+20\.10%/);
  assert.match(text, /Held 1d 6h · kept 62% of peak gain/);
  assert.match(text, /Today: \+\$1\.54 \(1W \/ 0L\)/);
  assert.match(text, /No new entries until .+ \(post-win cooldown\)/);
  assert.match(text, /Setup smart money · RS boost paused until .+ — 1\/6 wins/);
});

test('exit: a loss without a peak omits exit quality and notes', async () => {
  await notify.exit({
    symbol: 'WIF', realized_pnl_pct: -10.3, realized_pnl_usd: -2.06, reason: 'hard_stop',
    peak_pnl_pct: 0, exit_quality: null, hold_ms: 2 * 3600_000,
    day: { realized_pnl_usd: -2.06, wins: 0, losses: 1 },
    close: { cooldown_until: null, setup_halt: null },
  });
  const { text } = calls[0].body;
  assert.match(text, /❌ <b>EXIT WIF<\/b> −10\.30% \(−\$2\.06\)/);
  assert.match(text, /Why: hard stop/);
  assert.doesNotMatch(text, /kept|cooldown|paused/);
});

test('exitBlocked and exitFailing are loud and throttled per position', async () => {
  const blocked = { position_id: 'p1', symbol: 'JUP', reason: 'hard_stop', message: 'risk warning 81362', next: 'onchainos swap execute --force' };
  await notify.exitBlocked(blocked);
  await notify.exitBlocked(blocked);
  await notify.exitFailing({ position_id: 'p1', symbol: 'JUP', reason: 'hard_stop', pnl_pct: -10.3, error: 'slippage_too_high:3.1' });
  await notify.exitFailing({ position_id: 'p1', symbol: 'JUP', reason: 'hard_stop', pnl_pct: -10.4, error: 'slippage_too_high:3.2' });
  await notify.exitFailing({ position_id: 'p2', symbol: 'WIF', reason: 'hard_stop', pnl_pct: -11, error: 'x' });
  assert.equal(calls.length, 3, 'one per kind per position within the hour');
  assert.ok(calls.every(c => c.body.disable_notification === false));
  assert.match(calls[0].body.text, /EXIT JUP blocked<\/b> — OKX wants a manual confirmation/);
  assert.match(calls[1].body.text, /EXIT JUP failing<\/b> at −10\.30% · DRY\nExit reason: hard stop\nError: <code>slippage_too_high:3\.1<\/code>/);
});

// ─── Risk state ───────────────────────────────────────────────────────────

test('halted is loud with the reason in words; slow, normal and profit target are silent', async () => {
  await notify.halted({ reason: 'three_consecutive_losses', until: '2026-09-30T02:15:00Z', trailing_pct: 5 });
  await notify.slow({ reason: 'two_losses_today' });
  await notify.normal();
  await notify.profitTarget({ pct: 5.2 });
  assert.deepEqual(calls.map(c => c.body.disable_notification), [false, true, true, true]);
  assert.match(calls[0].body.text, /HALTED<\/b> — 3 losses in a row\nNo new entries until .+ tighter 5% trail/);
  assert.match(calls[1].body.text, /SLOW mode<\/b> — 2 losses today/);
  assert.match(calls[2].body.text, /Back to NORMAL/);
  assert.match(calls[3].body.text, /Daily profit target hit<\/b> \+5\.20%/);
});

test('the default export exposes the whole catalog', () => {
  for (const name of ['send', 'tickResult', 'dailyReport', 'weeklyHeartbeat', 'started', 'stopped',
    'crashed', 'unhandled', 'cannotStart', 'buy', 'buyBlocked', 'untracked', 'scaleOut', 'exit',
    'exitBlocked', 'exitFailing', 'halted', 'slow', 'normal', 'profitTarget']) {
    assert.equal(typeof notify.default[name], 'function', name);
  }
});

test('default export: a message that fails to build never rejects; a fallback alert goes out', async () => {
  await assert.doesNotReject(() => notify.default.buy({}));
  await assert.doesNotReject(() => notify.default.exit({ symbol: 'JUP' }));
  assert.equal(calls.length, 2);
  assert.match(calls[0].body.text, /the "buy" alert could not be built/);
  assert.match(calls[1].body.text, /the "exit" alert could not be built/);
  assert.equal(calls[0].body.disable_notification, false);
});

test('exit without close notes (caller passed none) still renders', async () => {
  await notify.exit({
    symbol: 'JUP', realized_pnl_pct: 1, realized_pnl_usd: 0.2, reason: 'catalyst_death',
    peak_pnl_pct: 2, exit_quality: 0.5, hold_ms: 3600_000,
    day: { realized_pnl_usd: 0.2, wins: 1, losses: 0 },
  });
  assert.match(calls[0].body.text, /Why: catalyst gone/);
  assert.match(calls[0].body.text, /kept 50% of peak gain/);
  assert.doesNotMatch(calls[0].body.text, /cooldown|paused/);
});

test('catalog throttle intervals: 6h for cannotStart and buyBlocked, 1h for the rest', async () => {
  const H = 3600_000;
  const cases = [
    ['cannot_start:cli_unrunnable', 6 * H, () => notify.cannotStart('cli_unrunnable', 'r', 'h')],
    ['buy_blocked:JUP', 6 * H, () => notify.buyBlocked({ symbol: 'JUP', message: 'm', next: 'n' })],
    ['crash:boom', H, () => notify.crashed('boom')],
    ['unhandled:boom', H, () => notify.unhandled('boom')],
    ['exit_blocked:p9', H, () => notify.exitBlocked({ position_id: 'p9', symbol: 'JUP', reason: 'hard_stop', message: 'm', next: 'n' })],
    ['exit_failing:p9', H, () => notify.exitFailing({ position_id: 'p9', symbol: 'JUP', reason: 'hard_stop', pnl_pct: -10, error: 'e' })],
  ];
  for (const [key, interval, fire] of cases) {
    seedSent({ [key]: Date.now() - interval + 60_000 });   // a minute before the window ends
    calls.length = 0;
    await fire();
    assert.equal(calls.length, 0, `${key} still suppressed just inside the window`);
    seedSent({ [key]: Date.now() - interval - 60_000 });   // a minute after it ended
    await fire();
    assert.equal(calls.length, 1, `${key} sends again just after the window`);
  }
});

test('crashed and unhandled with the same text use separate throttle keys', async () => {
  await notify.crashed('same');
  await notify.unhandled('same');
  assert.equal(calls.length, 2);
});

test('a successful start re-arms "can\'t start" alerts', async () => {
  await notify.cannotStart('cli_not_logged_in', 'r', 'h');
  await notify.started({ portfolio_usd: 1, open_positions: 0 });
  await notify.cannotStart('cli_not_logged_in', 'r', 'h');
  assert.equal(calls.length, 3, 'DOWN, started, DOWN again (the incident ended at the good start)');
});

test('crash keys ignore digits, so one recurring error is throttled as one', async () => {
  await notify.crashed('ETIMEDOUT after 5012 ms at 12:03:44');
  await notify.crashed('ETIMEDOUT after 5877 ms at 12:04:51');
  assert.equal(calls.length, 1);
});

test('clip scrubs credentials, token-shaped strings and control characters', () => {
  process.env.OKX_SECRET_KEY = 'super-secret-value-123';
  try {
    const s = notify.clip('auth failed: super-secret-value-123 via bot123456789:AAHdqTcvCH1vGWJxfSeofSAs0K5PALDsaw\u202e evil\r');
    assert.doesNotMatch(s, /super-secret|AAHdq|\u202e|\r/);
    assert.match(s, /auth failed: \[redacted\] via bot\[redacted\]/);
  } finally {
    delete process.env.OKX_SECRET_KEY;
  }
});

test('clip bounds huge input before splitting it into code points', () => {
  const s = notify.clip('x'.repeat(5_000_000));
  assert.equal(Array.from(s).length, 300);
});

test('a LIVE order id is clipped so the BUY message stays under Telegram\'s limit', async () => {
  process.env.DRY_RUN = 'false';
  try {
    await notify.buy({
      symbol: 'JUP', size_usd: 20, pct_of_portfolio: 20, entry_price_usd: 0.41,
      setup_id: 'smart_money__no_rs', hard_stop_pct: 10, trailing_pct: 8, scale_out_pcts: [15, 30, 50],
      tx_id: 'o'.repeat(5000),
    });
    assert.ok(calls[0].body.text.length < 1000);
  } finally {
    process.env.DRY_RUN = 'true';
  }
});

test('exit: a loss after a positive peak does not print "kept 0%"', async () => {
  await notify.exit({
    symbol: 'WIF', realized_pnl_pct: -10.3, realized_pnl_usd: -2.06, reason: 'hard_stop',
    peak_pnl_pct: 1.2, exit_quality: 0, hold_ms: 5 * 3600_000,
    day: { realized_pnl_usd: -2.06, wins: 0, losses: 1 },
    close: { cooldown_until: null, setup_halt: null },
  });
  assert.doesNotMatch(calls[0].body.text, /kept/);
  assert.match(calls[0].body.text, /\nHeld 5h\n/);
});

test('weeklyHeartbeat: inherited object keys are shown as-is, not as labels', async () => {
  await notify.weeklyHeartbeat({
    portfolio_usd: 1,
    week: { trades: 0, wins: 0, pnl_usd: 0 },
    funnel: { checked: 3, constructor: 3 },
  });
  assert.match(calls[0].body.text, /3 token checks: constructor 3$/);
});

test('default export passes arguments and results through on the happy path', async () => {
  assert.equal(await notify.default.send('hello'), true);
  await notify.default.scaleOut({ symbol: 'JUP', level_pct: 15, fraction: 0.2, proceeds_usd: 2.84, booked_usd: 0.37 });
  assert.equal(calls.length, 2);
  assert.equal(calls[0].body.text, 'hello');
  assert.match(calls[1].body.text, /Sold 20% for \$2\.84/);
});

test('default export: a non-Error throw still gives a fallback, throttled per builder', async () => {
  const bad = { get symbol() { throw 'plain string'; } };
  await assert.doesNotReject(() => notify.default.untracked(bad));
  await notify.default.untracked(bad);
  assert.equal(calls.length, 1, 'fallback throttled per builder');
  assert.match(calls[0].body.text, /the "untracked" alert could not be built \(<code>plain string<\/code>\)/);
});

test('tickResult: a clock stepped back does not stretch the BLIND window', async () => {
  const t0 = Date.parse('2026-09-30T18:00:00Z');
  await notify.tickResult(true, null, t0);
  for (let i = 0; i < 5; i++) await notify.tickResult(false, 'x', t0);   // BLIND at 18:00
  assert.equal(calls.length, 1);
  await notify.tickResult(true, null, t0 + 60_000);                        // recovered
  const back = t0 - 2 * 3600_000;                                         // NTP stepped back 2 h
  for (let i = 0; i < 5; i++) await notify.tickResult(false, 'x', back);
  assert.equal(calls.length, 3, 'BLIND again on the 5th failure, not ~2.5 h later');
  await notify.tickResult(true, null, back + 60_000);                      // clean slate
});

test('clip removes an invisible character spliced into a secret before matching it', () => {
  const zw = String.fromCharCode(0x200b);   // zero-width space
  process.env.OKX_SECRET_KEY = 'super-secret-value-123';
  try {
    const s = notify.clip(`a super-secret${zw}-value-123 and bot12345${zw}6789:AAHdqTcvCH1vGWJxfSeofSAs0K5PALDsaw`);
    assert.doesNotMatch(s, /super-secret|AAHdq/);
    assert.equal(s, 'a [redacted] and bot[redacted]');
  } finally {
    delete process.env.OKX_SECRET_KEY;
  }
});

test('a successful start clears only "can\'t start" throttles', async () => {
  seedSent({ 'crash:boom': Date.now() - 1000, 'cannot_start:x': Date.now() - 1000 });
  await notify.started({ portfolio_usd: 1, open_positions: 0 });
  const saved = JSON.parse(fs.readFileSync(sentFile, 'utf-8'));
  assert.equal(typeof saved['crash:boom'], 'number');
  assert.equal(saved['cannot_start:x'], undefined);
});

test('crash keys ignore long ids too', async () => {
  await notify.crashed('order 4Nd1mBQtrMJVYVfKf2PJy9NZUtM9ifhWfH2FqPk9mG3u failed');
  await notify.crashed('order 7Xe2nCRusNKWZWgLg3QKz8PAVuN8jgiXgH3GrQm8nH4v failed');
  assert.equal(calls.length, 1);
});

test('clip cuts before splitting into code points', (t) => {
  const from = t.mock.method(Array, 'from');   // spy, calls the real Array.from
  notify.clip('x'.repeat(100_000));
  assert.ok(from.mock.calls.length > 0);
  assert.ok(from.mock.calls.every(c => String(c.arguments[0]).length <= 1200));
});

test('a secret that itself contains an invisible character is still redacted', () => {
  const zw = String.fromCharCode(0x200b);   // zero-width space inside the secret
  process.env.OKX_SECRET_KEY = `abc${zw}defghij-1234`;
  try {
    assert.equal(notify.clip(`auth failed for key abc${zw}defghij-1234 end`), 'auth failed for key [redacted] end');
    assert.equal(notify.clip('auth failed for key abcdefghij-1234 end'), 'auth failed for key [redacted] end');
  } finally {
    delete process.env.OKX_SECRET_KEY;
  }
});
