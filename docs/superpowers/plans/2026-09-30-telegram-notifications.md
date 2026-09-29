# Telegram Notifications v2 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the bot's scattered Telegram alerts with one catalog that sends only what matters, in plain words:

- loud alerts when action is needed;
- trades with sound;
- everything else silent;
- a weekly heartbeat.

**Architecture:**

- New module `notify.js` owns all Telegram traffic:
  - transport (HTML with a plain-text retry on 400);
  - a per-key throttle persisted in `alerts_sent.json` next to the logs;
  - formatters;
  - a blind-tick detector;
  - one function per message.
- `logger.js` goes back to logging only.
- `risk.js`, `strategy.js` and `bot.js` call `notify.*` instead of building strings inline.
- The daily report is built from `state.rotateDaily()`'s return value. That fixes the race with the old 60 s summary timer.

**Tech Stack:** Node ≥ 20 ESM (`"type": "module"`), built-in `fetch`, `node:test` + `node:assert/strict`. No dependencies added.

**Spec:** `docs/superpowers/specs/2026-09-29-telegram-notifications-design.md`

## Global Constraints

**Environment**

- Node ≥ 20 (CI matrix 20 and 22). ESM imports with `.js` extensions. Tests use `node:test` + `node:assert/strict` and run with `npm test` from the repo root. Baseline: 48/48 pass.
- No new dependencies. Telegram is a raw `fetch` POST to `https://api.telegram.org/bot<TOKEN>/sendMessage`.

**Safety**

- **NEVER run `node bot.js`, `npm start` or `npm run dev`.** A local `.env` with real Telegram credentials exists; running the bot would message the owner's phone. The orchestrator does the manual `bot.js` checks.
- **NEVER open, read or print `.env`.** Never modify `deploy/docker-compose.yml`: the VPS carries a local patch to it.

**Copy and style**

- All code, comments and message copy are in English. Match the surrounding code style: 2-space indent, single quotes, `// ─── Section ───` dividers, short "why" comments.

**Git**

- Branch `feat/telegram-notifications` (already checked out). One commit per task. Every commit message ends with a blank line, then `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`.

**Transport values (verbatim from the spec)**

- `parse_mode: 'HTML'`, with every dynamic value passed through `esc()`.
- HTTP 400 → retry once as plain text.
- 5 s timeout.
- Dynamic text clipped to 300 chars.

**Throttle values (verbatim from the spec)**

- Persisted in `<OKX_BOT_LOG_DIR or ./logs>/alerts_sent.json`. Keys older than 7 days are pruned.
- Intervals:
  - `cannot_start:<id>` 6 h
  - `crash:<msg>` 1 h
  - `unhandled:<msg>` 1 h
  - `exit_blocked:<position id>` 1 h
  - `exit_failing:<position id>` 1 h
  - `buy_blocked:<symbol>` 6 h

**Tiers and reports (verbatim from the spec)**

- The blind alert fires on the **5th** consecutive failed tick. Recovery sends one silent note.
- Loud tier:
  - can't start
  - crashed
  - unhandled error
  - BLIND
  - EXIT BLOCKED
  - EXIT FAILING
  - BUY not tracked
  - HALTED
  - stopped **with** open positions
- Normal tier (with sound): BUY, EXIT, BUY BLOCKED.
- Silent tier:
  - started
  - stopped when flat
  - recovered
  - scale-out
  - SLOW
  - back to NORMAL
  - profit target
  - daily report
  - weekly heartbeat
- The daily report is sent only if the ended day had trades, open positions or failed ticks.
- The weekly heartbeat goes out on every Monday (UTC) rotation, whatever happened.

---

## File map

| File | Change | Responsibility after the change |
|---|---|---|
| `notify.js` | create | every Telegram message: transport, throttle, formatters, blind detector, catalog |
| `test/notify.test.js` | create | catalog + transport tests against a stubbed `fetch` |
| `test/dockerfile.test.js` | create | guard: every root module is copied into the image |
| `deploy/Dockerfile` | modify line 45 | add `notify.js` to the explicit COPY list |
| `state.js` | modify | `rotateDaily()` returns the ended day; drop `last_summary_date` |
| `risk.js` | modify | use `notify`; `onPositionClosed()` returns `{ cooldown_until, setup_halt }` |
| `strategy.js` | modify | use `notify`; delete veto; EXIT FAILING; entry funnel; last marks; scan counts |
| `bot.js` | rewrite | startup-failure alerts, tick health, reports at rotation, heartbeat |
| `logger.js` | modify | logging only (Telegram section + `alertWithVeto` removed) |
| `test/risk.test.js`, `test/strategy.test.js` | modify | cover the new return values and wiring |
| `README.md`, `SKILL.md`, `deploy/README.md`, `.env.example` | modify | describe tiers/heartbeat/TZ; remove veto claims |

---

### Task 1: `notify.js` transport and formatters (+ Dockerfile guard)

**Files:**
- Create: `notify.js`
- Create: `test/notify.test.js`
- Create: `test/dockerfile.test.js`
- Modify: `deploy/Dockerfile:45`

**Interfaces:**
- Consumes: `logger` from `./logger.js`: `logger.info/warn(msg, data)`.
- Produces (named exports):
  - `esc(v) → string`
  - `clip(v, n = 300) → string`
  - `fmtTime(ts) → string`
  - `fmtDuration(ms) → string`
  - `fmtPrice(usd) → string`
  - `fmtUsd(v) → string`
  - `fmtSigned(v, prefix = '', suffix = '') → string`
  - `fmtInt(n) → string`
  - `humanReason(code) → string`
  - `humanSetup(id) → string`
  - `send(html, { silent = false, key = null, everyMs = 0 } = {}) → Promise<void>`. It never rejects.
- Module-private helpers used by Tasks 2–3 (same file):
  - `isDryRun()`
  - `dryTag()`: `' · DRY'` or `''`
  - `modeLabel()`: `'DRY RUN'` or `'LIVE'`
  - `txLine(txId)`
  - constant `HOUR = 3600_000`

- [ ] **Step 1: Write the Dockerfile guard test**

Create `test/dockerfile.test.js`:

```js
// Guard: the Docker image copies an explicit list of modules
// (deploy/Dockerfile). A root-level module missing from that list only
// shows up on the VPS, as a crash-restart loop. Run: npm test

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs';

test('deploy/Dockerfile copies every root-level module', () => {
  const dockerfile = fs.readFileSync('deploy/Dockerfile', 'utf-8');
  const copyLine = dockerfile.split('\n').find(l => l.startsWith('COPY') && l.includes('bot.js'));
  assert.ok(copyLine, 'COPY line with bot.js not found');
  const modules = fs.readdirSync('.').filter(f => f.endsWith('.js'));
  for (const m of modules) {
    assert.ok(copyLine.split(/\s+/).includes(m), `${m} missing from the deploy/Dockerfile COPY line`);
  }
});
```

- [ ] **Step 2: Run it. It passes on the current tree.**

Run: `npm test -- test/dockerfile.test.js`. If the npm arg passthrough doesn't work on this shell, use `node --test test/dockerfile.test.js`.
Expected: PASS (1 test).

- [ ] **Step 3: Write the failing transport/formatter tests**

Create `test/notify.test.js`:

```js
// notify.js — every Telegram message, tested against a stubbed fetch.
// Run: npm test

import { test, before, beforeEach } from 'node:test';
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
    calls.push({ url, body: JSON.parse(opts.body) });
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
```

- [ ] **Step 4: Run it and confirm it fails**

Run: `node --test test/notify.test.js`
Expected: FAIL: `Cannot find module '.../notify.js'`.

- [ ] **Step 5: Create `notify.js` (transport + formatters)**

```js
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
```

- [ ] **Step 6: Run the tests. `notify` passes; the Dockerfile guard now fails.**

Run: `npm test`
Expected: all `test/notify.test.js` tests PASS. `deploy/Dockerfile copies every root-level module` FAILS with `notify.js missing from the deploy/Dockerfile COPY line`.

- [ ] **Step 7: Add `notify.js` to the Dockerfile COPY list**

In `deploy/Dockerfile`, replace line 45:

```dockerfile
COPY --chown=okxbot:okxbot bot.js execution.js logger.js risk.js signals.js state.js strategy.js tokens.json package.json ./
```

with:

```dockerfile
COPY --chown=okxbot:okxbot bot.js execution.js logger.js notify.js risk.js signals.js state.js strategy.js tokens.json package.json ./
```

- [ ] **Step 8: Run the full suite**

Run: `npm test`
Expected: PASS, 0 failures (48 existing + the new ones).

- [ ] **Step 9: Commit**

```bash
git add notify.js test/notify.test.js test/dockerfile.test.js deploy/Dockerfile
git commit -F - <<'EOF'
feat: notify.js transport — HTML, plain-text retry, persisted throttle

Single home for Telegram traffic. parse_mode HTML with esc() on dynamic
values replaces legacy Markdown (unpaired _ or * made Telegram drop the
message); a 400 is retried once as plain text. Per-key throttle persisted
in alerts_sent.json so a crash-restart loop cannot spam. Dockerfile COPY
gains notify.js, guarded by a test.

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>
EOF
```

---

### Task 2: Blind-tick detector and periodic reports

**Files:**
- Modify: `notify.js` (append after the Transport section)
- Modify: `test/notify.test.js` (append)

**Interfaces:**
- Consumes (same file, Task 1): `send`, `esc`, `clip`, `fmtDuration`, `fmtTime`, `fmtUsd`, `fmtSigned`, `fmtInt`, `isDryRun`, `modeLabel`, `logger`.
- Produces (named exports):
  - `tickResult(ok, error = null, now = Date.now()) → Promise<void>`. Call it once per main tick. It also counts ticks for the reports.
  - `dailyReport({ day, portfolio_usd, open_positions }) → Promise<void>`
    - `day` = `{ date, starting_portfolio_usd, trades, wins, losses, realized_pnl_usd, ... }`. This is the object returned by `state.rotateDaily()` in Task 4.
    - `open_positions` = `[{ symbol: string, pnl_pct: number|null, held_ms: number }]`.
    - It resets the day counters on every call.
  - `weeklyHeartbeat({ portfolio_usd, week, funnel }) → Promise<void>`
    - `week` = `{ trades: number, wins: number, pnl_usd: number }`.
    - `funnel` = `{ checked?: number, [outcome]: number }`. This is what `strategy.takeFunnel()` returns in Task 5.
    - It resets the week counters on every call.

- [ ] **Step 1: Append the failing tests to `test/notify.test.js`**

```js
// ─── Tick health (blind detector) ─────────────────────────────────────────

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
  assert.match(text, /Open: JUP \+3\.20% \(held 5h 0m\)/);
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
```

- [ ] **Step 2: Run the tests and confirm they fail**

Run: `node --test test/notify.test.js`
Expected: the new tests FAIL with `notify.tickResult is not a function` (and likewise for `dailyReport` and `weeklyHeartbeat`).

- [ ] **Step 3: Append the implementation to `notify.js`**

```js
// ─── Tick health: blind detector + report counters ─────────────────────────

const BLIND_AFTER_TICKS = 5;   // ≈ 5.5 min at the ~65 s real tick

const health = {
  streak: 0,            // consecutive failed ticks
  streakSince: null,    // ts of the first failure in the streak
  alerted: false,       // BLIND already sent for this streak
  day: { ticks: 0, failed: 0 },
  week: { since: Date.now(), ticks: 0, failed: 0 },
};

// Call once per main tick. Edge-triggered: one loud alert on the 5th
// consecutive failure, one silent note on the first success after it.
export async function tickResult(ok, error = null, now = Date.now()) {
  health.day.ticks++;
  health.week.ticks++;
  if (ok) {
    if (health.alerted) {
      await send(
        `✅ <b>okx-bot recovered</b> after ${fmtDuration(now - health.streakSince)} of failed ticks`,
        { silent: true }
      );
    }
    health.streak = 0;
    health.streakSince = null;
    health.alerted = false;
    return;
  }
  health.day.failed++;
  health.week.failed++;
  if (health.streak === 0) health.streakSince = now;
  health.streak++;
  if (health.streak === BLIND_AFTER_TICKS) {
    health.alerted = true;
    await send(
      `🚨 <b>okx-bot BLIND</b> — ${BLIND_AFTER_TICKS} ticks failed in a row (${fmtDuration(now - health.streakSince)})\n` +
      `Last error: <code>${esc(clip(error))}</code>\n` +
      `It is running but can't read the market or wallet: no new entries, and stop checks are probably failing too.`
    );
  }
}

// ─── Reports ───────────────────────────────────────────────────────────────

const FUNNEL_LABELS = {
  no_data: 'no candles',
  trend_failed: 'trend ✗',
  momentum_failed: 'momentum ✗',
  valuation_failed: 'too extended ✗',
  catalyst_failed: 'catalyst ✗',
  slow_mode_requires_smart_money: 'slow mode needs smart money ✗',
  risk_gate: 'risk gate ✗',
  size_below_min: 'size below min ✗',
  no_gas: 'no SOL gas ✗',
  entry_failed: 'entry failed ✗',
  entered: 'entered ✓',
};

// day: stats of the UTC day that just ended (state.rotateDaily's return).
// open_positions: [{ symbol, pnl_pct (null when unknown), held_ms }].
// A quiet day — no trades, nothing open, no failed ticks — sends nothing.
export async function dailyReport({ day, portfolio_usd, open_positions }) {
  const { ticks, failed } = health.day;
  health.day = { ticks: 0, failed: 0 };
  if (day.trades === 0 && open_positions.length === 0 && failed === 0) {
    logger.info('daily_report_skipped_quiet', { date: day.date, ticks });
    return;
  }
  const lines = [
    `📊 <b>Day ${esc(day.date)}</b> (UTC) · ${modeLabel()}`,
    `Trades ${day.trades} (${day.wins}W / ${day.losses}L) · realized ${fmtSigned(day.realized_pnl_usd, '$')}`,
  ];
  // In DRY RUN the wallet does not move with the simulated trades, so a
  // wallet delta would read like bot PnL. LIVE only.
  let portfolio = `Portfolio ${fmtUsd(portfolio_usd)}`;
  if (!isDryRun() && day.starting_portfolio_usd > 0) {
    portfolio += ` (${fmtSigned(portfolio_usd - day.starting_portfolio_usd, '$')} since day start)`;
  }
  lines.push(portfolio);
  if (open_positions.length > 0) {
    lines.push('Open: ' + open_positions.map(p =>
      `${esc(p.symbol)} ${p.pnl_pct == null ? 'n/a' : fmtSigned(p.pnl_pct, '', '%')} (held ${fmtDuration(p.held_ms)})`
    ).join(' · '));
  }
  lines.push(`Health: ${fmtInt(ticks)} ticks, ${fmtInt(failed)} failed`);
  await send(lines.join('\n'), { silent: true });
}

// Sent on every Monday rotation whatever happened: its absence is the signal
// that the bot (or the VPS) is gone. week: { trades, wins, pnl_usd } over the
// last 7 days; funnel: strategy.takeFunnel().
export async function weeklyHeartbeat({ portfolio_usd, week, funnel }) {
  const { since, ticks, failed } = health.week;
  health.week = { since: Date.now(), ticks: 0, failed: 0 };
  const checks = funnel.checked || 0;
  const outcomes = Object.entries(funnel)
    .filter(([k, n]) => k !== 'checked' && n > 0)
    .sort((a, b) => b[1] - a[1])
    .map(([k, n]) => `${esc(FUNNEL_LABELS[k] || k)} ${fmtInt(n)}`)
    .join(' · ');
  await send(
    `💓 <b>okx-bot weekly</b> · ${modeLabel()} · since ${fmtTime(since)}\n` +
    `${fmtInt(ticks)} ticks, ${fmtInt(failed)} failed · portfolio ${fmtUsd(portfolio_usd)}\n` +
    `Trades ${week.trades} (${week.wins}W / ${week.trades - week.wins}L) · realized ${fmtSigned(week.pnl_usd, '$')}\n` +
    `Entry filter, ${fmtInt(checks)} token checks: ${outcomes || 'none'}`,
    { silent: true }
  );
}
```

- [ ] **Step 4: Run the full suite**

Run: `npm test`
Expected: PASS, 0 failures.

- [ ] **Step 5: Commit**

```bash
git add notify.js test/notify.test.js
git commit -F - <<'EOF'
feat: blind-tick detector, daily report and weekly heartbeat

One loud alert on the 5th consecutive failed tick, one silent note on
recovery. The daily report is skipped on quiet days; the Monday heartbeat
always goes out and explains how the entry filter rejected the week.

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>
EOF
```

---

### Task 3: Event message catalog

**Files:**
- Modify: `notify.js` (append after Reports; the default export goes at the very end)
- Modify: `test/notify.test.js` (append)

**Interfaces:**
- Consumes (same file): everything from Tasks 1–2, including `HOUR`, `dryTag`, `txLine`, `humanReason`, `humanSetup`.
- Produces: named exports, each an `async` function. **Callers in Tasks 4–6 use exactly these names and parameter objects.**
  - `started({ portfolio_usd, open_positions })`: silent.
  - `stopped({ signal, open_positions })`: silent if 0, loud if more than 0.
  - `crashed(message)`: loud, key `crash:<message>`, 1 h.
  - `unhandled(message)`: loud, key `unhandled:<message>`, 1 h.
  - `cannotStart(id, reason, hint)`: loud, key `cannot_start:<id>`, 6 h.
  - `buy({ symbol, size_usd, pct_of_portfolio, entry_price_usd, setup_id, hard_stop_pct, trailing_pct, scale_out_pcts, tx_id })`: normal.
  - `buyBlocked({ symbol, message, next })`: normal, key `buy_blocked:<symbol>`, 6 h.
  - `untracked({ symbol, tx_id })`: loud.
  - `scaleOut({ symbol, level_pct, fraction, proceeds_usd, booked_usd })`: silent.
  - `exit({ symbol, realized_pnl_pct, realized_pnl_usd, reason, peak_pnl_pct, exit_quality, hold_ms, day, close })`: normal.
    - `day` = `{ realized_pnl_usd, wins, losses }` (today's running totals).
    - `close` = `{ cooldown_until: ISO|null, setup_halt: { setup_id, until, wins, trades }|null }`.
  - `exitBlocked({ position_id, symbol, reason, message, next })`: loud, key `exit_blocked:<position_id>`, 1 h.
  - `exitFailing({ position_id, symbol, reason, pnl_pct, error })`: loud, key `exit_failing:<position_id>`, 1 h.
  - `halted({ reason, until, trailing_pct })`: loud.
  - `slow({ reason })`: silent.
  - `normal()`: silent.
  - `profitTarget({ pct })`: silent.
  - `export default { send, tickResult, dailyReport, weeklyHeartbeat, started, stopped, crashed, unhandled, cannotStart, buy, buyBlocked, untracked, scaleOut, exit, exitBlocked, exitFailing, halted, slow, normal, profitTarget }`

- [ ] **Step 1: Append the failing tests to `test/notify.test.js`**

```js
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
```

- [ ] **Step 2: Run the tests and confirm they fail**

Run: `node --test test/notify.test.js`
Expected: the new tests FAIL with `notify.started is not a function` and similar errors.

- [ ] **Step 3: Append the catalog and default export to the end of `notify.js`**

```js
// ─── Lifecycle ─────────────────────────────────────────────────────────────

export async function started({ portfolio_usd, open_positions }) {
  await send(
    `🚀 <b>okx-bot started</b> · ${modeLabel()}\n` +
    `Portfolio ${fmtUsd(portfolio_usd)} · open positions ${open_positions}`,
    { silent: true }
  );
}

export async function stopped({ signal, open_positions }) {
  if (open_positions > 0) {
    await send(
      `⏹️ <b>okx-bot stopped</b> (${esc(signal)})\n` +
      `⚠️ ${open_positions} open position${open_positions === 1 ? '' : 's'} — stops are NOT enforced until it runs again.`
    );
    return;
  }
  await send(`⏹️ <b>okx-bot stopped</b> (${esc(signal)}) · no open positions`, { silent: true });
}

export async function crashed(message) {
  await send(
    `🚨 <b>okx-bot crashed</b> — restarting\n<code>${esc(clip(message))}</code>`,
    { key: `crash:${clip(message, 100)}`, everyMs: HOUR }
  );
}

export async function unhandled(message) {
  await send(
    `🚨 <b>Unhandled error</b> (the bot keeps running)\n<code>${esc(clip(message))}</code>`,
    { key: `unhandled:${clip(message, 100)}`, everyMs: HOUR }
  );
}

// id: stable per failure kind (cli_not_logged_in, cli_unrunnable,
// balance_unreadable, startup_crash) so a crash loop repeats at most every 6h.
export async function cannotStart(id, reason, hint) {
  await send(
    `🚨 <b>okx-bot DOWN</b> — can't start: ${esc(clip(reason))}\n` +
    `Docker keeps restarting it; nothing is traded or managed.\n` +
    `Fix: ${esc(hint)}\n` +
    `<i>Repeats at most every 6h while it keeps failing.</i>`,
    { key: `cannot_start:${id}`, everyMs: 6 * HOUR }
  );
}

// ─── Trades ────────────────────────────────────────────────────────────────

export async function buy({ symbol, size_usd, pct_of_portfolio, entry_price_usd, setup_id,
  hard_stop_pct, trailing_pct, scale_out_pcts, tx_id }) {
  const stopPrice = entry_price_usd * (1 - hard_stop_pct / 100);
  await send(
    `🟢 <b>BUY ${esc(symbol)}</b> ${fmtUsd(size_usd)} (${pct_of_portfolio.toFixed(0)}% of portfolio)${dryTag()}\n` +
    `Entry ${fmtPrice(entry_price_usd)} · setup: ${esc(humanSetup(setup_id))}\n` +
    `Exits: stop ${fmtPrice(stopPrice)} (−${hard_stop_pct}%) · trail ${trailing_pct}% · ` +
    `scale-outs at ${scale_out_pcts.map(p => `+${p}%`).join('/')}` +
    txLine(tx_id)
  );
}

export async function buyBlocked({ symbol, message, next }) {
  await send(
    `🟡 <b>BUY ${esc(symbol)} blocked</b> — OKX wants a manual confirmation\n` +
    `${esc(clip(message))}\n` +
    `CLI next step: <code>${esc(clip(next || 'see CLI output'))}</code>\n` +
    `The bot will not force it. <i>Repeats at most every 6h.</i>`,
    { key: `buy_blocked:${symbol}`, everyMs: 6 * HOUR }
  );
}

export async function untracked({ symbol, tx_id }) {
  await send(
    `🚨 <b>BUY ${esc(symbol)} NOT tracked</b>${dryTag()} — the swap fired but the entry price is unknown\n` +
    `The bot will NOT manage stops for it. Close it manually via the CLI.` +
    txLine(tx_id)
  );
}

export async function scaleOut({ symbol, level_pct, fraction, proceeds_usd, booked_usd }) {
  await send(
    `📤 <b>SCALE-OUT ${esc(symbol)}</b> at +${level_pct}%${dryTag()}\n` +
    `Sold ${(fraction * 100).toFixed(0)}% for ${fmtUsd(proceeds_usd)} · booked ${fmtSigned(booked_usd, '$')}`,
    { silent: true }
  );
}

// day: state.daily right after this close (today's running totals).
// close: risk.onPositionClosed()'s return — { cooldown_until, setup_halt }.
export async function exit({ symbol, realized_pnl_pct, realized_pnl_usd, reason, peak_pnl_pct,
  exit_quality, hold_ms, day, close = {} }) {
  const lines = [
    `${realized_pnl_usd > 0 ? '✅' : '❌'} <b>EXIT ${esc(symbol)}</b> ` +
      `${fmtSigned(realized_pnl_pct, '', '%')} (${fmtSigned(realized_pnl_usd, '$')})${dryTag()}`,
    `Why: ${esc(humanReason(reason))} · peak ${fmtSigned(peak_pnl_pct, '', '%')}`,
    `Held ${fmtDuration(hold_ms)}` +
      (exit_quality != null ? ` · kept ${(exit_quality * 100).toFixed(0)}% of peak gain` : ''),
    `Today: ${fmtSigned(day.realized_pnl_usd, '$')} (${day.wins}W / ${day.losses}L)`,
  ];
  if (close.cooldown_until) {
    lines.push(`⏸ No new entries until ${fmtTime(close.cooldown_until)} (post-win cooldown)`);
  }
  if (close.setup_halt) {
    const h = close.setup_halt;
    lines.push(`⛔ Setup ${esc(humanSetup(h.setup_id))} paused until ${fmtTime(h.until)} — ${h.wins}/${h.trades} wins`);
  }
  await send(lines.join('\n'));
}

export async function exitBlocked({ position_id, symbol, reason, message, next }) {
  await send(
    `🚨 <b>EXIT ${esc(symbol)} blocked</b> — OKX wants a manual confirmation\n` +
    `Exit reason: ${esc(humanReason(reason))}\n` +
    `${esc(clip(message))}\n` +
    `CLI next step: <code>${esc(clip(next || 'see CLI output'))}</code>\n` +
    `The position is still open; the bot retries about every 10 min. <i>Reminder at most hourly.</i>`,
    { key: `exit_blocked:${position_id}`, everyMs: HOUR }
  );
}

export async function exitFailing({ position_id, symbol, reason, pnl_pct, error }) {
  await send(
    `🚨 <b>EXIT ${esc(symbol)} failing</b> at ${fmtSigned(pnl_pct, '', '%')}${dryTag()}\n` +
    `Exit reason: ${esc(humanReason(reason))}\n` +
    `Error: <code>${esc(clip(error))}</code>\n` +
    `The position is still open; the bot retries every tick. <i>Reminder at most hourly.</i>`,
    { key: `exit_failing:${position_id}`, everyMs: HOUR }
  );
}

// ─── Risk state ────────────────────────────────────────────────────────────

export async function halted({ reason, until, trailing_pct }) {
  await send(
    `🔴 <b>HALTED</b> — ${esc(humanReason(reason))}\n` +
    `No new entries until ${fmtTime(until)}. Open positions stay managed on a tighter ${trailing_pct}% trail; ` +
    `after that the bot resumes in Slow mode.`
  );
}

export async function slow({ reason }) {
  await send(
    `🟡 <b>SLOW mode</b> — ${esc(humanReason(reason))} (smaller positions, tighter stops)`,
    { silent: true }
  );
}

export async function normal() {
  await send('🟢 <b>Back to NORMAL</b> — standard sizing and stops', { silent: true });
}

export async function profitTarget({ pct }) {
  const nextUtcMidnight = new Date();
  nextUtcMidnight.setUTCHours(24, 0, 0, 0);
  await send(
    `🎯 <b>Daily profit target hit</b> ${fmtSigned(pct, '', '%')}\n` +
    `No new entries until ${fmtTime(nextUtcMidnight)}; open positions keep running.`,
    { silent: true }
  );
}

export default {
  send,
  tickResult,
  dailyReport,
  weeklyHeartbeat,
  started,
  stopped,
  crashed,
  unhandled,
  cannotStart,
  buy,
  buyBlocked,
  untracked,
  scaleOut,
  exit,
  exitBlocked,
  exitFailing,
  halted,
  slow,
  normal,
  profitTarget,
};
```

- [ ] **Step 4: Run the full suite**

Run: `npm test`
Expected: PASS, 0 failures.

- [ ] **Step 5: Commit**

```bash
git add notify.js test/notify.test.js
git commit -F - <<'EOF'
feat: notify.js message catalog with loud/normal/silent tiers

One function per Telegram message. Reasons and setups in words, readable
prices, local times, DRY tag on every trade message, post-win cooldown
and setup pause folded into the EXIT message, per-position/per-token
throttles on the blocked/failing paths.

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>
EOF
```

---

### Task 4: `state.rotateDaily` returns the ended day; `risk.js` uses notify

**Files:**
- Modify: `state.js` (DEFAULT_STATE at lines 51–60; `rotateDaily` at lines 122–137)
- Modify: `risk.js` (import at line 8; lines 62, 76, 84, 112–115; `onPositionClosed` at lines 239–264)
- Modify: `test/risk.test.js`

**Interfaces:**
- Consumes: `notify.halted`, `notify.slow`, `notify.normal`, `notify.profitTarget` (Task 3, default export).
- Produces:
  - `state.rotateDaily(current_portfolio_usd) → previousDaily | null`. `previousDaily` is the full object the day ended with: `{ date, starting_portfolio_usd, trades, wins, losses, consecutive_losses, realized_pnl_usd, ... }`.
  - `risk.onPositionClosed(trade) → { cooldown_until: string|null, setup_halt: { setup_id, until, wins, trades }|null }`. It no longer sends Telegram messages itself.

- [ ] **Step 1: Write the failing tests**

In `test/risk.test.js`, delete the line `    last_summary_date: null,` from `resetState` (currently line 30). Then append at the end of the file:

```js
// ─── Daily rotation ───────────────────────────────────────────────────────

test('rotateDaily returns the day that just ended, then null until the next rollover', () => {
  const s = resetState({ date: '2026-09-28', trades: 2, wins: 1, losses: 1, realized_pnl_usd: 1.5 });
  const ended = state.rotateDaily(123);
  assert.equal(ended.date, '2026-09-28');
  assert.equal(ended.trades, 2);
  assert.equal(ended.realized_pnl_usd, 1.5);
  assert.equal(s.daily.trades, 0, 'the new day starts empty');
  assert.equal(s.daily.starting_portfolio_usd, 123);
  assert.equal(state.rotateDaily(123), null, 'same day → no rotation');
});

// ─── Post-trade hooks feed the EXIT message ───────────────────────────────

test('onPositionClosed: a win above 3% of portfolio returns the post-win cooldown', () => {
  resetState();
  const r = risk.onPositionClosed({ realized_pnl_usd: 4, daily_portfolio_at_close: 100, setup_id: 'smart_money__rs' });
  assert.ok(Date.parse(r.cooldown_until) > Date.now());
  assert.equal(state.loadState().post_win_cooldown_until, r.cooldown_until);
  assert.equal(r.setup_halt, null);
});

test('onPositionClosed: a small win returns no cooldown', () => {
  resetState();
  const r = risk.onPositionClosed({ realized_pnl_usd: 1, daily_portfolio_at_close: 100, setup_id: 'smart_money__rs' });
  assert.deepEqual(r, { cooldown_until: null, setup_halt: null });
});

test('onPositionClosed: 5 losses on a setup returns the setup pause', () => {
  const s = resetState();
  s.setup_stats['smart_money__no_rs'] = { trades: 6, wins: 1, losses: 5, halted_until: null };
  const r = risk.onPositionClosed({ realized_pnl_usd: -1, daily_portfolio_at_close: 100, setup_id: 'smart_money__no_rs' });
  assert.equal(r.cooldown_until, null);
  assert.equal(r.setup_halt.setup_id, 'smart_money__no_rs');
  assert.equal(r.setup_halt.wins, 1);
  assert.equal(r.setup_halt.trades, 6);
  assert.ok(Date.parse(r.setup_halt.until) > Date.now());
  assert.ok(state.isSetupHalted('smart_money__no_rs'));
});
```

- [ ] **Step 2: Run the tests and confirm they fail**

Run: `node --test test/risk.test.js`
Expected: `rotateDaily returns the day that just ended…` FAILS (`ended` is `undefined`). The three `onPositionClosed` tests FAIL (`r` is `undefined`).

- [ ] **Step 3: Update `state.js`**

In `DEFAULT_STATE`, delete this line:

```js
  last_summary_date: null,  // anchored on first tick; daily summary fires on rollover
```

Replace the whole `rotateDaily` function (the comment above it plus the function) with:

```js
// Rotate daily stats at UTC midnight. Call this on every tick — it's a no-op
// if the date hasn't changed. Returns the stats of the day that just ended
// (the daily report is built from them), or null when nothing rotated.
export function rotateDaily(current_portfolio_usd) {
  const s = loadState();
  if (s.daily.date === utcDate()) return null;
  const ended = s.daily;
  logger.info('daily_rotation', {
    previous_date: ended.date,
    previous_realized_pnl_usd: ended.realized_pnl_usd,
    trades: ended.trades,
  });
  s.daily = newDailyStats(current_portfolio_usd);
  // Clear post-win cooldown at midnight (fresh start)
  s.post_win_cooldown_until = null;
  saveState();
  return ended;
}
```

- [ ] **Step 4: Update `risk.js`**

Replace line 8:

```js
import { logger, alert } from './logger.js';
```

with:

```js
import { logger } from './logger.js';
import notify from './notify.js';
```

Replace this line (in `evaluateState`, Halted branch):

```js
    alert(`🔴 *HALTED*\nReason: \`${haltReason}\`\nCooldown until: ${until}`);
```

with:

```js
    notify.halted({ reason: haltReason, until, trailing_pct: SLOW_TRAILING_PCT });
```

Replace:

```js
      alert(`🟡 *SLOW MODE*\nReason: \`${slowReason}\``);
```

with:

```js
      notify.slow({ reason: slowReason });
```

Replace:

```js
    alert(`🟢 *NORMAL*\nResumed standard operation`);
```

with:

```js
    notify.normal();
```

In `notifyProfitTargetOnce`, replace:

```js
    alert(
      `🎯 *DAILY PROFIT TARGET* ${pct >= 0 ? '+' : ''}${pct.toFixed(2)}%\n` +
      `No new entries until UTC midnight. Open positions keep being managed.`
    );
```

with:

```js
    notify.profitTarget({ pct });
```

Replace the whole `onPositionClosed` function, including its comment block (from `// Called after a position closes. Handles:` through the function's closing brace), with:

```js
// Called after a position closes. Handles:
//   - post-win cooldown
//   - anti-pattern detection
// Returns what it decided so the EXIT message can say it in one place:
//   { cooldown_until: ISO|null, setup_halt: { setup_id, until, wins, trades }|null }
export function onPositionClosed(trade) {
  const result = { cooldown_until: null, setup_halt: null };
  const realizedPctOfPortfolio = trade.daily_portfolio_at_close > 0
    ? (trade.realized_pnl_usd / trade.daily_portfolio_at_close) * 100
    : 0;

  // Post-win cooldown after profitable close > 3% of portfolio
  if (realizedPctOfPortfolio > POST_WIN_THRESHOLD_PCT) {
    const until = new Date(Date.now() + POST_WIN_COOLDOWN_MS).toISOString();
    state.setPostWinCooldown(until);
    result.cooldown_until = until;
  }

  // Anti-pattern: 5 losses on same setup → halt that setup 24h
  const s = state.loadState();
  const setupStats = s.setup_stats[trade.setup_id];
  if (setupStats && setupStats.losses >= 5 && setupStats.wins / setupStats.trades < 0.3) {
    const until = new Date(Date.now() + SETUP_HALT_MS).toISOString();
    state.haltSetup(trade.setup_id, until);
    result.setup_halt = { setup_id: trade.setup_id, until, wins: setupStats.wins, trades: setupStats.trades };
  }

  return result;
}
```

- [ ] **Step 5: Run the full suite**

Run: `npm test`
Expected: PASS, 0 failures.

Then run: `grep -n "alert" risk.js state.js`
Expected: the only matches are the historical comment in `risk.js` (`Telegram got a fresh HALTED alert every cooldown`) and the `profit_target_alerted` flag. No `alert(` calls.

- [ ] **Step 6: Commit**

```bash
git add state.js risk.js test/risk.test.js
git commit -F - <<'EOF'
refactor: risk alerts via notify; rotateDaily returns the ended day

The daily report can now be built from the day that actually ended
(the old 60 s timer read state.daily after rotation ~half the time).
onPositionClosed returns cooldown/setup-pause so EXIT carries them
instead of two extra messages in the same second.

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>
EOF
```

---

### Task 5: `strategy.js`: notify calls, veto removal, EXIT FAILING, funnel, last marks

**Files:**
- Modify: `strategy.js`
- Modify: `test/strategy.test.js`

**Interfaces:**
- Consumes:
  - `notify.buy`, `notify.buyBlocked`, `notify.untracked`, `notify.scaleOut`, `notify.exit`, `notify.exitBlocked`, `notify.exitFailing` (Task 3).
  - `risk.onPositionClosed(trade) → { cooldown_until, setup_halt }` (Task 4).
  - `risk.getHardStopPct()`, `risk.getTrailingStopPct()` (existing).
- Produces:
  - `evaluateNewEntries(args) → Promise<{ evaluated: number, withData: number }>`. `evaluated` counts tokens scanned (already-held tokens are skipped and not counted). `withData` counts tokens that had ≥ 25 completed candles.
  - `takeFunnel() → { [outcome]: number }`. It returns the counts since the last call and resets them. Outcome keys:
    - `checked`
    - `no_data`
    - `trend_failed`
    - `momentum_failed`
    - `valuation_failed`
    - `catalyst_failed`
    - `slow_mode_requires_smart_money`
    - `risk_gate`
    - `size_below_min`
    - `no_gas`
    - `entered`
    - `entry_failed`
    - plus any other reason string the signal code returns.
  - `getLastMark(positionId) → number|null`: the latest unrealized PnL % seen by `managePosition`.
  - The default export gains `takeFunnel` and `getLastMark`.

- [ ] **Step 1: Write the failing tests**

Append to `test/strategy.test.js`:

```js
// ─── Wiring: blind scan + failing exit ────────────────────────────────────

test('evaluateNewEntries: no candles for any token → withData 0 (blind tick) and the funnel counts it', async () => {
  const execution = (await import('../execution.js')).default;
  const realFetchCandles = execution.fetchCandles;
  execution.fetchCandles = async () => [];
  try {
    strategy.takeFunnel();   // reset
    const scan = await strategy.evaluateNewEntries({
      tokens: [{ symbol: 'AAA', mint: 'a' }, { symbol: 'BBB', mint: 'b' }],
      baseToken: { mint: 'usdc', decimals: 6 },
      referenceMint: 'sol',
      portfolio_usd: 100,
      cash_usd: 100,
    });
    assert.deepEqual(scan, { evaluated: 2, withData: 0 });
    assert.deepEqual(strategy.takeFunnel(), { checked: 2, no_data: 2 });
    assert.deepEqual(strategy.takeFunnel(), {}, 'takeFunnel resets');
  } finally {
    execution.fetchCandles = realFetchCandles;
  }
});

test('a failing exit swap raises EXIT FAILING and leaves the position retryable', async () => {
  const execution = (await import('../execution.js')).default;
  const state = (await import('../state.js')).default;
  const real = { fetchCandles: execution.fetchCandles, executeSwap: execution.executeSwap };
  const pos = state.openPosition({
    token: { symbol: 'JUP', mint: 'jup', decimals: 6 },
    entry_ts: new Date().toISOString(),
    entry_price_usd: 1.0,
    entry_amount_token: 100,
    entry_value_usd: 100,
    setup_id: 'smart_money__rs',
    kill_conditions: [],
    scale_out_proceeds_usd: 0,
    scale_out_cost_usd: 0,
  });
  // −15% → hard stop fires; the swap then fails (e.g. slippage on a crash).
  execution.fetchCandles = async () => [{ ts: '', open: 0.85, high: 0.85, low: 0.85, close: 0.85, volume_usd: 1, complete: true }];
  execution.executeSwap = async () => { throw new Error('slippage_too_high:3.1'); };
  try {
    await strategy.manageOpenPositions({ baseToken: { mint: 'usdc', decimals: 6 } });
    const still = state.getOpenPositions().find(p => p.id === pos.id);
    assert.ok(still, 'position stays open');
    assert.equal(still.exit_pending, null, 'exit_pending cleared so the next tick retries');
    assert.equal(strategy.getLastMark(pos.id).toFixed(2), '-15.00');
    const sent = JSON.parse(fs.readFileSync(path.join(process.env.OKX_BOT_LOG_DIR, 'alerts_sent.json'), 'utf-8'));
    assert.equal(typeof sent[`exit_failing:${pos.id}`], 'number', 'EXIT FAILING alert raised (throttle key recorded)');
  } finally {
    Object.assign(execution, real);
  }
});
```

(`fs` and `path` are already imported at the top of `test/strategy.test.js`. The throttle file is written even without Telegram env, which is what makes the second assertion observable.)

- [ ] **Step 2: Run the tests and confirm they fail**

Run: `node --test test/strategy.test.js`
Expected: FAIL with `strategy.takeFunnel is not a function` and `strategy.getLastMark is not a function`.

- [ ] **Step 3: Update the imports and constants in `strategy.js`**

Replace lines 7–12:

```js
import { randomUUID } from 'crypto';
import { logger, alert, alertWithVeto } from './logger.js';
import signals from './signals.js';
import risk from './risk.js';
import execution, { CliConfirmingError } from './execution.js';
import state from './state.js';
```

with:

```js
import { randomUUID } from 'crypto';
import { logger } from './logger.js';
import notify from './notify.js';
import signals from './signals.js';
import risk from './risk.js';
import execution, { CliConfirmingError } from './execution.js';
import state from './state.js';
```

Delete this line from the constants block:

```js
const VETO_THRESHOLD_FRACTION = 0.15;  // positions > 15% of portfolio need veto
```

Insert this block directly after the constants (after `const MIN_COMPLETED_CANDLES = 25;  // momentum needs 1h + 24h of closed bars`) and before `// ─── New entries ───`:

```js

// ─── Entry funnel + last marks (in memory, reset on restart) ───────────────
//
// funnel: how each token check of the entry scan ended — the weekly
// heartbeat's "why no entries" line. lastMarks: latest unrealized PnL % per
// open position, for the daily report.
const funnel = {};
const lastMarks = new Map();

function count(outcome) {
  funnel[outcome] = (funnel[outcome] || 0) + 1;
}

// Returns the counts since the last call and resets them.
export function takeFunnel() {
  const out = { ...funnel };
  for (const k of Object.keys(funnel)) delete funnel[k];
  return out;
}

export function getLastMark(positionId) {
  return lastMarks.get(positionId) ?? null;
}
```

- [ ] **Step 4: Replace `evaluateNewEntries` (the whole function) with:**

```js
// Returns { evaluated, withData }: tokens scanned vs tokens with enough
// candles. bot.js treats evaluated > 0 && withData === 0 as a blind tick
// (market data down, e.g. an exhausted Market API quota).
export async function evaluateNewEntries({ tokens, baseToken, referenceMint, portfolio_usd, cash_usd }) {
  const machineState = state.loadState().machine_state;
  let evaluated = 0;
  let withData = 0;

  // Fetch reference candles once (SOL — used for relative strength)
  const refCandles = await execution.fetchCandles(referenceMint, 8);

  for (const token of tokens) {
    // Skip if already in this token
    if (state.getOpenPositionForToken(token.symbol)) continue;
    evaluated++;
    count('checked');

    // Fetch data
    const candles = await execution.fetchCandles(token.mint, 48);
    if (signals.completedCandles(candles).length < MIN_COMPLETED_CANDLES) {
      logger.debug('skip_insufficient_candles', { token: token.symbol, candles: candles.length });
      count('no_data');
      continue;
    }
    withData++;

    // Chart-only signals first: pure and already paid for. Catalyst data is
    // another CLI call per token, so only fetch it once the chart qualifies.
    // (In the May-2026 dry run the chart gate rejected ~all tokens on every
    // tick, so this roughly halves per-tick CLI traffic.)
    const price = signals.evaluatePriceSignals(candles);
    if (!price.passed) {
      logger.debug('signal_eval', { token: token.symbol, passed: false, reason: price.reason });
      count(price.reason);
      continue;
    }

    const catalysts = await execution.fetchCatalysts(token.mint);

    // Evaluate
    const eval_ = signals.evaluateEntry({
      candles,
      refCandles,
      catalysts,
      machineState,
    });

    logger.debug('signal_eval', {
      token: token.symbol,
      passed: eval_.passed,
      reason: eval_.reason,
    });

    if (!eval_.passed) {
      count(eval_.reason);
      continue;
    }

    // Risk gate
    const gate = risk.canOpenPosition(eval_.setup_id);
    if (!gate.allowed) {
      logger.info('entry_blocked', { token: token.symbol, reason: gate.reason });
      count('risk_gate');
      continue;
    }

    // Sizing
    const size = risk.computePositionSize({
      portfolio_usd,
      cash_usd,
      token_config: token,
      rs_boost: eval_.booster_active,
    });
    if (size === 0) {
      logger.info('entry_zero_size', { token: token.symbol });
      count('size_below_min');
      continue;
    }

    // Preflight
    const pf = await execution.preflightCheck();
    if (!pf.ok) {
      logger.warn('entry_blocked_preflight', { token: token.symbol, reason: pf.reason });
      count('no_gas');
      continue;
    }

    // Execute
    const position = await openPosition({ token, baseToken, size_usd: size, portfolio_usd, signals: eval_, candles });
    count(position ? 'entered' : 'entry_failed');
    cash_usd -= size;
  }

  return { evaluated, withData };
}
```

- [ ] **Step 5: Replace `openPosition` (the whole function) with:**

```js
// Returns the new position, or null when the entry did not happen.
async function openPosition({ token, baseToken, size_usd, portfolio_usd, signals: ev, candles }) {
  const clientOrderId = `entry-${randomUUID()}`;
  const fromAmount = String(Math.floor(size_usd * Math.pow(10, baseToken.decimals)));

  let fill;
  try {
    fill = await execution.executeSwap({
      fromMint: baseToken.mint,
      toMint: token.mint,
      amount: fromAmount,
      clientOrderId,
    });
  } catch (err) {
    if (err instanceof CliConfirmingError) {
      await notify.buyBlocked({ symbol: token.symbol, message: err.message, next: err.next });
      logger.warn('entry_swap_confirming', { token: token.symbol, message: err.message });
      return null;
    }
    logger.error('entry_swap_failed', { token: token.symbol, error: err.message });
    return null;
  }

  // Resolve entry price. Prefer the quote-derived unit price (already paid
  // for); fall back to the latest close of the candles this entry was
  // evaluated on (seconds old). If both fail, the position would be
  // untrackable (NaN pnl_pct disables all exit logic) — abort and alert.
  const candle_price = signals.lastPrice(candles);
  const entry_price_usd = fill.to_token_unit_price_usd ?? candle_price;

  if (!entry_price_usd || !Number.isFinite(entry_price_usd)) {
    logger.error('entry_price_unavailable', {
      token: token.symbol,
      tx: fill.tx_id,
      dry_run: fill.dry_run,
    });
    await notify.untracked({ symbol: token.symbol, tx_id: fill.tx_id });
    return null;
  }

  const entry_amount_token = fill.filled_amount;

  const position = state.openPosition({
    token: { symbol: token.symbol, mint: token.mint, decimals: token.decimals },
    entry_ts: new Date().toISOString(),
    entry_price_usd,
    entry_amount_token,
    entry_value_usd: size_usd,
    entry_signals: ev.breakdown,
    setup_id: ev.setup_id,
    kill_conditions: buildKillConditions(ev, candles),
    entry_tx_id: fill.tx_id,
    // Running totals for partial exits, so the final close can compute the
    // true blended PnL (see computeRealizedPnl).
    scale_out_proceeds_usd: 0,
    scale_out_cost_usd: 0,
  });

  await notify.buy({
    symbol: token.symbol,
    size_usd,
    pct_of_portfolio: portfolio_usd > 0 ? (size_usd / portfolio_usd) * 100 : 0,
    entry_price_usd,
    setup_id: ev.setup_id,
    hard_stop_pct: risk.getHardStopPct(),
    trailing_pct: risk.getTrailingStopPct(),
    scale_out_pcts: SCALE_OUT_LEVELS.map(l => l.pct),
    tx_id: fill.tx_id,
  });
  return position;
}
```

- [ ] **Step 6: Record the last mark in `managePosition`**

Replace:

```js
  const current_price = signals.lastPrice(candles);
  const pnl_pct = ((current_price - pos.entry_price_usd) / pos.entry_price_usd) * 100;
```

with:

```js
  const current_price = signals.lastPrice(candles);
  const pnl_pct = ((current_price - pos.entry_price_usd) / pos.entry_price_usd) * 100;
  lastMarks.set(pos.id, pnl_pct);
```

- [ ] **Step 7: Replace the scale-out alert in `checkScaleOuts`**

Replace:

```js
      await alert(
        `📤 *SCALE-OUT ${pos.token.symbol} @ +${level.pct}%*\n` +
        `Sold ${(level.fraction * 100).toFixed(0)}% (${amount_to_sell.toFixed(4)}) for $${proceeds_usd.toFixed(2)}\n` +
        `Booked: ${fmtSigned(proceeds_usd - cost_usd, '$')}\n` +
        `TX: \`${fill.tx_id}\``
      );
```

with:

```js
      await notify.scaleOut({
        symbol: pos.token.symbol,
        level_pct: level.pct,
        fraction: level.fraction,
        proceeds_usd,
        booked_usd: proceeds_usd - cost_usd,
      });
```

- [ ] **Step 8: Replace the `catch (err)` block of `closeAll` (the whole block) with:**

```js
  } catch (err) {
    if (err instanceof CliConfirmingError) {
      // Position stays open with exit_pending set. Stale-clear will reset
      // after 10min so a real exit attempt can happen on a later tick after
      // the user (or CLI policy) clears the confirming gate.
      await notify.exitBlocked({
        position_id: pos.id,
        symbol: pos.token.symbol,
        reason,
        message: err.message,
        next: err.next,
      });
      logger.warn('close_swap_confirming', {
        position_id: pos.id, token: pos.token.symbol, reason, message: err.message,
      });
      return;
    }
    logger.error('close_swap_failed', {
      position_id: pos.id, token: pos.token.symbol, reason, error: err.message,
    });
    // Clear the flag so the next tick can retry. Without this, the stale-clear
    // would only fire after EXIT_PENDING_STALE_MS, locking the position.
    state.updatePosition(pos.id, { exit_pending: null });
    // A stop that cannot execute is money at risk — loud, hourly per position.
    await notify.exitFailing({
      position_id: pos.id,
      symbol: pos.token.symbol,
      reason,
      pnl_pct: ((current_price - pos.entry_price_usd) / pos.entry_price_usd) * 100,
      error: err.message,
    });
  }
```

- [ ] **Step 9: Replace `finalizeClose` (the whole function) and delete `fmtSigned`**

Replace `finalizeClose` with:

```js
async function finalizeClose(pos, current_price, reason, fill = null) {
  const { realized_pnl_usd, realized_pnl_pct } = computeRealizedPnl(pos, {
    exit_proceeds_usd: fill?.filled_amount ?? null,
    current_price,
  });

  // The close itself must always finalize even if the post-close balance
  // read blips. Post-win cooldown is just a derived behavior; losing it for
  // one trade is acceptable, losing the close record is not.
  let portfolio_usd = 0;
  try {
    portfolio_usd = await execution.getPortfolioValueUsd();
  } catch (err) {
    logger.warn('post_close_balance_failed', { position_id: pos.id, error: err.message });
  }

  const trade = state.closePosition(pos.id, {
    exit_ts: new Date().toISOString(),
    exit_price_usd: current_price,
    exit_reason: reason,
    realized_pnl_usd,
    realized_pnl_pct,
  });

  // For post-trade hooks
  trade.daily_portfolio_at_close = portfolio_usd;
  const close = risk.onPositionClosed(trade);
  lastMarks.delete(pos.id);

  await notify.exit({
    symbol: pos.token.symbol,
    realized_pnl_pct,
    realized_pnl_usd,
    reason,
    peak_pnl_pct: pos.peak_pnl_pct,
    exit_quality: trade.exit_quality,
    hold_ms: trade.hold_duration_ms,
    day: state.loadState().daily,
    close,
  });
}
```

Delete the whole `fmtSigned` function at the bottom of `strategy.js`. It now lives in `notify.js` and nothing in `strategy.js` uses it.

Replace the default export at the bottom with:

```js
export default {
  evaluateNewEntries,
  manageOpenPositions,
  computeRealizedPnl,
  buildKillConditions,
  takeFunnel,
  getLastMark,
};
```

- [ ] **Step 10: Run the full suite and the grep checks**

Run: `npm test`
Expected: PASS, 0 failures.

Run: `grep -n "alert(\|alertWithVeto\|VETO\|fmtSigned" strategy.js`
Expected: no output. The comment `— abort and alert.` in `openPosition` stays and does not match.

- [ ] **Step 11: Commit**

```bash
git add strategy.js test/strategy.test.js
git commit -F - <<'EOF'
feat: strategy alerts via notify; drop veto; alert on failing exits

- remove alertWithVeto: it could not veto, duplicated BUY and embedded an
  unescaped setup_id; the share of portfolio moves into the BUY message
- close_swap_failed now raises a loud EXIT FAILING (hourly per position)
  instead of only logging while a stop silently fails
- count every entry-scan outcome (funnel) and keep the last PnL mark per
  position for the weekly heartbeat and daily report
- evaluateNewEntries returns { evaluated, withData } for blind detection

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>
EOF
```

---

### Task 6: `bot.js` wiring and `logger.js` cleanup

**Files:**
- Rewrite: `bot.js` (full file below)
- Modify: `logger.js` (header comment at lines 1–8; delete lines 90–149)

**Interfaces:**
- Consumes:
  - `notify.cannotStart`, `notify.started`, `notify.stopped`, `notify.crashed`, `notify.unhandled`, `notify.tickResult`, `notify.dailyReport`, `notify.weeklyHeartbeat` (Tasks 2–3).
  - `state.rotateDaily` (Task 4).
  - `strategy.evaluateNewEntries → { evaluated, withData }`, `strategy.takeFunnel`, `strategy.getLastMark` (Task 5).
- Produces: nothing new for other modules. After this task, `logger.js` exports only `logger`, `setLogLevel` and the default `logger`.

- [ ] **Step 1: Replace `bot.js` with:**

```js
// bot.js — main entry point.
//
// Spawns the main tick loop + background monitoring loops. Handles graceful
// shutdown so state is always flushed.

import 'dotenv/config';
import fs from 'fs';
import path from 'path';
import { execFile } from 'child_process';
import { promisify } from 'util';
import { logger, setLogLevel } from './logger.js';
import notify from './notify.js';
import state from './state.js';
import risk from './risk.js';
import strategy from './strategy.js';
import execution from './execution.js';

const execFileP = promisify(execFile);

const TICK_INTERVAL_MS = parseInt(process.env.TICK_INTERVAL_MS || '60000', 10);
const KILL_CHECK_INTERVAL_MS = 5 * 60 * 1000;
const HOLDER_SNAPSHOT_INTERVAL_MS = 60 * 60 * 1000;
const WEEK_MS = 7 * 24 * 60 * 60 * 1000;

const TOKENS = JSON.parse(
  fs.readFileSync(path.join(process.cwd(), 'tokens.json'), 'utf-8')
);

setLogLevel(process.env.LOG_LEVEL || 'info');

// ─── Pre-flight ────────────────────────────────────────────────────────────
//
// Every startup failure alerts before exiting. Docker restarts the bot in a
// loop, and without an alert that loop is silent (21→22 Sep 2026 it went
// unnoticed for about a day). notify throttles each kind to once per 6h.

async function preflightConfig() {
  const cli = process.env.ONCHAINOS_CLI || 'onchainos';
  let parsed;
  try {
    const { stdout } = await execFileP(cli, ['wallet', 'status'], { timeout: 10_000, windowsHide: true });
    parsed = JSON.parse(stdout);
  } catch (err) {
    logger.error('preflight_cli_failed', { error: err.message });
    console.error(`\n❌ Could not run \`${cli} wallet status\`. Is the onchainos CLI installed and on PATH?\n${err.message}\n`);
    await notify.cannotStart('cli_unrunnable', `can't run the onchainos CLI (${err.message})`,
      'check the CLI binary and its mount (deploy/README.md, Troubleshooting)');
    process.exit(1);
  }
  if (!parsed?.data?.loggedIn) {
    logger.error('preflight_not_logged_in');
    console.error(`\n❌ onchainos CLI is not logged in.\nRun: \`onchainos wallet login <email>\` (or set up API Key login per dev-portal docs).\n`);
    await notify.cannotStart('cli_not_logged_in', 'the onchainos CLI is not logged in',
      're-login the CLI for the bot (deploy/README.md, step 3)');
    process.exit(1);
  }
  logger.info('cli_auth_ok', {
    loginType: parsed.data.loginType,
    account: parsed.data.currentAccountName,
  });
}

function printBanner() {
  const dryRun = process.env.DRY_RUN !== 'false';
  console.log(`
╔════════════════════════════════════════════════════════════════╗
║         OKX Agentic Wallet — Trend-Follower Skill v0.2         ║
║                                                                ║
║  Mode:        ${(dryRun ? 'DRY RUN (no real trades)' : 'LIVE TRADING').padEnd(48)}    ║
║  Tick:        ${(TICK_INTERVAL_MS / 1000 + 's').padEnd(48)}    ║
║  Whitelist:   ${(TOKENS.tokens.length + ' tokens').padEnd(48)}    ║
║                                                                ║
║  ⚠️  This skill executes real on-chain trades when LIVE.        ║
║  ⚠️  Trading can result in total loss of deployed capital.      ║
║  ⚠️  This is not financial advice.                              ║
╚════════════════════════════════════════════════════════════════╝
`);
}

// ─── Main tick ─────────────────────────────────────────────────────────────

let tickCount = 0;
let isShuttingDown = false;

async function tick() {
  if (isShuttingDown) return;
  tickCount++;

  try {
    // One `wallet balance` call per tick; derive both figures from it.
    const balances = await execution.fetchBalances();
    const portfolio_usd = execution.portfolioValueFromBalances(balances);
    const cash_usd = execution.cashFromBalances(balances);

    // Rotate daily stats if needed. The ended day is reported from its own
    // numbers — v0.2 read state.daily from a separate timer and, about half
    // the time, after this rotation had already reset it.
    const endedDay = state.rotateDaily(portfolio_usd);
    if (endedDay) sendPeriodicReports(endedDay, portfolio_usd);

    // Evaluate state machine
    const stateInfo = risk.evaluateState(portfolio_usd);

    // Per-tick log
    const s = state.loadState();
    logger.info('tick', {
      tick: tickCount,
      state: stateInfo.state,
      portfolio_usd: portfolio_usd.toFixed(2),
      cash_usd: cash_usd.toFixed(2),
      open_positions: Object.keys(s.positions).length,
      daily_pnl_usd: s.daily.realized_pnl_usd.toFixed(2),
      daily_trades: s.daily.trades,
    });

    // Manage existing positions (priority over new entries)
    await strategy.manageOpenPositions({
      baseToken: TOKENS.base_token,
    });

    // Scan for new entries
    const scan = await strategy.evaluateNewEntries({
      tokens: TOKENS.tokens,
      baseToken: TOKENS.base_token,
      referenceMint: TOKENS.reference_token.mint,
      portfolio_usd,
      cash_usd,
    });
    // No candles for any token = the market-data source is down (e.g. an
    // exhausted Market API quota): the bot is blind even though nothing threw.
    if (scan.evaluated > 0 && scan.withData === 0) {
      throw new Error(`no market data: 0 of ${scan.evaluated} tokens returned candles`);
    }
    await notify.tickResult(true);
  } catch (err) {
    logger.error('tick_failed', { tick: tickCount, error: err.message, stack: err.stack });
    await notify.tickResult(false, err.message);
  }
}

// Daily report for the day that just ended (sent only if something happened)
// and, on the Monday rollover, the weekly heartbeat. Fire-and-forget: reports
// must never delay or break a tick.
function sendPeriodicReports(endedDay, portfolio_usd) {
  const s = state.loadState();
  const now = Date.now();
  const open_positions = Object.values(s.positions).map(p => ({
    symbol: p.token.symbol,
    pnl_pct: strategy.getLastMark(p.id),
    held_ms: now - new Date(p.entry_ts).getTime(),
  }));
  notify.dailyReport({ day: endedDay, portfolio_usd, open_positions })
    .catch(err => logger.error('daily_report_failed', { error: err.message }));

  if (new Date(now).getUTCDay() === 1) {
    const week = s.history.filter(t => now - new Date(t.exit_ts).getTime() <= WEEK_MS);
    notify.weeklyHeartbeat({
      portfolio_usd,
      week: {
        trades: week.length,
        wins: week.filter(t => t.realized_pnl_usd > 0).length,
        pnl_usd: week.reduce((acc, t) => acc + t.realized_pnl_usd, 0),
      },
      funnel: strategy.takeFunnel(),
    }).catch(err => logger.error('weekly_heartbeat_failed', { error: err.message }));
  }
}

// ─── Background monitoring loops ───────────────────────────────────────────
//
// Both loops self-reschedule via setTimeout AFTER the previous run finishes,
// so a slow tick can never overlap itself. Concurrency between the two loops
// is bounded by the per-position mutex inside strategy.manageOpenPositions.

async function killCheckLoop() {
  if (isShuttingDown) return;
  try {
    await strategy.manageOpenPositions({ baseToken: TOKENS.base_token });
  } catch (err) {
    logger.error('kill_check_failed', { error: err.message });
  }
}

// Hourly holder-count snapshot per whitelisted token. This is what feeds the
// "on-chain spike" catalyst (holders +5% / 24h): the CLI has no historical
// holders endpoint, so the bot has to build the 24h baseline itself.
async function holderSnapshotLoop() {
  if (isShuttingDown) return;
  try {
    await execution.refreshHolderSnapshots(TOKENS.tokens.map(t => t.mint));
  } catch (err) {
    logger.error('holder_snapshot_loop_failed', { error: err.message });
  }
}

async function tickRunner() {
  if (isShuttingDown) return;
  await tick();
  if (!isShuttingDown) setTimeout(tickRunner, TICK_INTERVAL_MS);
}

async function holderSnapshotRunner() {
  if (isShuttingDown) return;
  await holderSnapshotLoop();
  if (!isShuttingDown) setTimeout(holderSnapshotRunner, HOLDER_SNAPSHOT_INTERVAL_MS);
}

async function killCheckRunner() {
  if (isShuttingDown) return;
  await killCheckLoop();
  if (!isShuttingDown) setTimeout(killCheckRunner, KILL_CHECK_INTERVAL_MS);
}

// ─── Lifecycle ─────────────────────────────────────────────────────────────

async function shutdown(signal) {
  if (isShuttingDown) return;
  isShuttingDown = true;
  logger.info('shutdown_initiated', { signal });
  await notify.stopped({ signal, open_positions: state.getOpenPositions().length });
  state.saveState();
  // Flush the log stream so the last few lines (including this shutdown
  // sequence) hit disk before exit. Without this they can be lost on a
  // fast SIGTERM.
  try { logger.flush && logger.flush(); } catch (_) { /* best effort */ }
  process.exit(0);
}

process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));

// Loud failure surface — silence here is what makes production bots quietly
// stop working without anyone noticing.
process.on('unhandledRejection', (err) => {
  const msg = err && err.message ? err.message : String(err);
  const stack = err && err.stack ? err.stack : '';
  logger.error('unhandled_rejection', { error: msg, stack });
  notify.unhandled(msg).catch(() => {});
});

process.on('uncaughtException', (err) => {
  // Same idea, plus we don't trust the process state anymore — let systemd /
  // docker restart us cleanly.
  logger.error('uncaught_exception', { error: err.message, stack: err.stack });
  notify.crashed(err.message)
    .catch(() => {})
    .finally(() => process.exit(1));
});

async function main() {
  await preflightConfig();
  printBanner();
  state.loadState();

  // Initialize starting portfolio for daily PnL accounting.
  // Hard-fail on persistent balance errors — without a real number here, all
  // daily PnL guards in risk.js divide by zero and silently disable themselves.
  let startingPortfolio;
  try {
    startingPortfolio = await execution.getPortfolioValueUsd();
  } catch (err) {
    logger.warn('startup_balance_failed_retrying', { error: err.message });
    await new Promise(r => setTimeout(r, 5000));
    try {
      startingPortfolio = await execution.getPortfolioValueUsd();
    } catch (err2) {
      logger.error('startup_balance_failed', { error: err2.message });
      console.error(`\n❌ Could not read wallet balance twice in a row.\nRun \`onchainos wallet balance --chain solana\` manually to debug.\n${err2.message}\n`);
      await notify.cannotStart('balance_unreadable', `can't read the wallet balance (${err2.message})`,
        'run `onchainos wallet balance --chain solana` on the VPS to see why');
      process.exit(1);
    }
  }

  const s = state.loadState();
  if (s.daily.starting_portfolio_usd === 0) {
    s.daily.starting_portfolio_usd = startingPortfolio;
    state.saveState();
  }

  await notify.started({ portfolio_usd: startingPortfolio, open_positions: Object.keys(s.positions).length });

  // Self-rescheduling loops — no setInterval, no overlap.
  // Holder snapshots first so the very first tick already has a data point.
  await holderSnapshotLoop();
  tickRunner();
  setTimeout(killCheckRunner, KILL_CHECK_INTERVAL_MS);
  setTimeout(holderSnapshotRunner, HOLDER_SNAPSHOT_INTERVAL_MS);
}

main().catch(async err => {
  logger.error('main_failed', { error: err.message, stack: err.stack });
  await notify.cannotStart('startup_crash', `startup crashed: ${err.message}`, 'see `docker logs okx-bot`');
  process.exit(1);
});
```

- [ ] **Step 2: Strip Telegram from `logger.js`**

Replace the header comment (lines 1–8):

```js
// logger.js — structured logging with Telegram alerts
//
// Every decision the bot makes goes through here. Logs go to:
//   1. Console (colored, human-readable)
//   2. logs/bot-YYYY-MM-DD.log (structured JSON, one line per event)
//   3. Telegram (for material events only — entries, exits, state changes)
//
// The JSON log is the source of truth — sufficient to replay every decision.
```

with:

```js
// logger.js — structured logging.
//
// Every decision the bot makes goes through here. Logs go to:
//   1. Console (colored, human-readable)
//   2. logs/bot-YYYY-MM-DD.log (structured JSON, one line per event)
// Telegram alerts live in notify.js.
//
// The JSON log is the source of truth — sufficient to replay every decision.
```

Delete everything from the line `// ─── Telegram ───…` down to and including the closing `}` of `alertWithVeto` (currently lines 90–149). Keep the final `export default logger;`.

- [ ] **Step 3: Run the full suite, syntax checks and leftover checks**

Run: `npm test`
Expected: PASS, 0 failures.

Run: `for f in *.js scripts/*.js; do node --check "$f" || echo "SYNTAX FAIL $f"; done`
Expected: no output.

Run: `grep -n "alertWithVeto\|checkDailySummary\|last_summary_date\|import { logger, alert" *.js scripts/*.js test/*.js`
Expected: no output.

**Do NOT run `node bot.js`.** The orchestrator does the manual startup check.

- [ ] **Step 4: Commit**

```bash
git add bot.js logger.js
git commit -F - <<'EOF'
feat: alert before every startup exit; blind ticks; reports at rotation

- preflight / balance / main failures now alert (throttled 6h per kind)
  before process.exit — the Docker restart loop of 21-22 Sep was silent
- each tick reports to notify.tickResult; a tick with no candles for
  any token counts as failed (market data down)
- daily report built from state.rotateDaily()'s ended day; Monday
  rotation also sends the weekly heartbeat; checkDailySummary removed
- logger.js is logging only

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>
EOF
```

---

### Task 7: Documentation

**Files:**
- Modify: `README.md` (paragraphs quoted below)
- Modify: `SKILL.md` (lines 42 and 134)
- Modify: `deploy/README.md` (lines 83–85 and the troubleshooting table)
- Modify: `.env.example` (after `TELEGRAM_CHAT_ID=`)

**Interfaces:** docs only.

- [ ] **Step 1: README.md: confirming responses**

Replace:

```markdown
the bot does NOT pass `--force`. It alerts to Telegram with the CLI's
next-step hint and leaves the position state correct (no entry on a
blocked buy; `exit_pending` retained on a blocked exit until the operator
acts).
```

with:

```markdown
the bot does NOT pass `--force`. It alerts to Telegram with the CLI's
next-step hint and leaves the position state correct (no entry on a
blocked buy; `exit_pending` retained on a blocked exit until the operator
acts). Reminders are throttled: a blocked BUY at most every 6h per token,
a blocked EXIT at most hourly per position.
```

- [ ] **Step 2: README.md: replace the veto paragraph**

Replace:

```markdown
**Material decisions ping a human.** Any position > 15% of portfolio
dispatches a Telegram alert before execution. *Note:* full veto polling
(reply STOP to cancel) is a roadmap item — current v0.1 alerts and
proceeds; the alert is for visibility, not interactive approval. See
`alertWithVeto` in [logger.js](logger.js).
```

with:

```markdown
**Alerts are tiered, and loud only when you need to act.** Every Telegram
message lives in [notify.js](notify.js). Loud: the bot can't start (sent
before each exit of a Docker restart loop, at most every 6h), crashed, went
blind (5 failed ticks in a row — e.g. CLI session expired or Market API
quota exhausted), an exit is blocked or failing, a position is untracked,
HALTED, or the bot stopped with open positions. With sound: BUY and EXIT.
Silent: start/stop, scale-outs, Slow/Normal, profit target, the daily report
and the weekly heartbeat. Repeating alerts are throttled per key, and the
throttle survives restarts (`logs/alerts_sent.json`).
```

- [ ] **Step 3: README.md: daily summary → report + heartbeat**

Replace:

```markdown
**Daily summary** sent to Telegram on the first tick after UTC midnight:
trade count, win/loss split, realized PnL, current machine state.
```

with:

```markdown
**Daily report** on the first tick after UTC midnight, only if the day had
trades, open positions or failed ticks: trades W/L, realized PnL, portfolio,
open positions with their last PnL, tick health. **Weekly heartbeat** every
Monday whatever happened: ticks and failures, portfolio, the week's trades,
and how the entry filter rejected the week's token checks — if it stops
arriving, the bot or the VPS is down. Set `TZ` (e.g. `Europe/Warsaw`) in
`.env` for local times in alerts; unset means UTC.
```

- [ ] **Step 4: README.md: roadmap entry**

Replace:

```markdown
- **Telegram STOP polling.** `alertWithVeto` notifies but cannot yet read
  a reply; material entries proceed after the alert.
```

with:

```markdown
- **Telegram command channel.** Alerts are one-way; replying STOP or
  approve (getUpdates polling) is not implemented.
```

- [ ] **Step 4b: README.md: design principle, loop list, evidence note**

Replace:

```markdown
2. **AI as augmentation, not autonomy.** Material decisions can ping a human
   with a veto window. Routine execution is automatic.
```

with:

```markdown
2. **AI as augmentation, not autonomy.** Routine execution is automatic; a
   human is pinged loudly only when something needs a decision or is broken.
```

Replace:

```markdown
- **Every minute (clock only)** — daily-summary rollover check
```

with:

```markdown
- **Daily (first tick after UTC midnight)** — daily report if the day had
  trades, open positions or failed ticks; on Mondays also the weekly heartbeat
```

Replace:

```markdown
Flow: signal eval passes → veto alert (material-position threshold
hit at 25% of portfolio) → quote fetched live from OKX → dry_run_swap
```

with:

```markdown
Flow: signal eval passes → veto alert (material-position threshold
hit at 25% of portfolio; that separate alert was later removed and the
BUY message now carries the share of portfolio) → quote fetched live
from OKX → dry_run_swap
```

Leave the historical May-2026 log lines (`📊 Daily summary 2026-05-19 …`) as they are. They are evidence of past behaviour.

- [ ] **Step 5: SKILL.md**

Replace:

```markdown
It has no FOMO, no panic, no revenge trading. It surfaces patterns and executes
mechanically. For material decisions, alerts are dispatched to a human with a
veto window.
```

with:

```markdown
It has no FOMO, no panic, no revenge trading. It surfaces patterns and executes
mechanically, and alerts a human loudly only when something needs a decision or
is broken (see `notify.js`).
```

Replace:

```markdown
- Telegram alerts for all material events
```

with:

```markdown
- Tiered Telegram alerts: loud only when action is needed (can't start, blind, exit blocked/failing, Halted), trades with sound, everything else silent, plus a weekly heartbeat
```

Replace:

```markdown
- `logger.js` — structured logging + Telegram alerts
```

with:

```markdown
- `logger.js` — structured logging
- `notify.js` — every Telegram message: tiers, throttling, formatting
```

- [ ] **Step 6: deploy/README.md**

Replace:

```markdown
Required entries: `TELEGRAM_BOT_TOKEN`, `TELEGRAM_CHAT_ID` (optional but
strongly recommended), `MAX_PORTFOLIO_USD`, `MIN_TRADE_SIZE_USD`. Keep
`DRY_RUN=true` until you've watched it run for at least 24h.
```

with:

```markdown
Required entries: `TELEGRAM_BOT_TOKEN`, `TELEGRAM_CHAT_ID` (optional but
strongly recommended), `MAX_PORTFOLIO_USD`, `MIN_TRADE_SIZE_USD`. Keep
`DRY_RUN=true` until you've watched it run for at least 24h. Optional:
`TZ=Europe/Warsaw` (any IANA zone) so alert timestamps show local time;
unset means UTC.
```

In the troubleshooting table, replace the row:

```markdown
| `swap_confirming_required` alert | OKX backend wants human confirmation on a swap | Run the suggested CLI command manually OR ignore (position stays in `exit_pending` for 10min then retries) |
```

with these three rows:

```markdown
| `swap_confirming_required` alert | OKX backend wants human confirmation on a swap | Run the suggested CLI command manually OR ignore (position stays in `exit_pending` for 10min then retries; the Telegram reminder repeats at most hourly) |
| `telegram_send_failed` in logs | Telegram rejected the request — the log line carries Telegram's `description` (wrong token or chat id, bot blocked by the user) | Fix `TELEGRAM_BOT_TOKEN` / `TELEGRAM_CHAT_ID` in `.env`. A 400 on markup is retried once as plain text automatically |
| `alert_throttled` in logs | A repeating alert was suppressed on purpose (per-key throttle in `notify.js`) | Nothing to do. Delete `logs/alerts_sent.json` to reset all throttles |
```

- [ ] **Step 7: .env.example**

Replace:

```
TELEGRAM_BOT_TOKEN=
TELEGRAM_CHAT_ID=
```

with:

```
TELEGRAM_BOT_TOKEN=
TELEGRAM_CHAT_ID=

# Time zone for alert timestamps (any IANA name). Unset = UTC.
# TZ=Europe/Warsaw
```

- [ ] **Step 8: Check for stale claims**

Run: `grep -n "alertWithVeto\|Material decision\|veto window\|daily-summary\|15% of portfolio" README.md SKILL.md deploy/README.md`
Expected: no output. The historical `📊 Daily summary 2026-05-…` log lines and the annotated evidence paragraph are allowed.

- [ ] **Step 9: Commit**

```bash
git add README.md SKILL.md deploy/README.md .env.example
git commit -F - <<'EOF'
docs: tiered Telegram alerts, daily report + weekly heartbeat, TZ

Remove the "material decisions ping a human" claim (the veto alert is
gone) and describe what is loud, what has sound and what is silent.

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>
EOF
```

---

## Final verification (orchestrator, not the implementing worker)

1. Run `npm test`. All pass. Quote the summary lines.
2. Run `for f in *.js scripts/*.js; do node --check "$f"; done`. No output.
3. Manual startup-failure check with no Telegram and no `.env`:
   ```bash
   DOTENV_CONFIG_PATH=/nonexistent ONCHAINOS_CLI=definitely-not-a-cli OKX_BOT_LOG_DIR=<tmp>/logs OKX_BOT_STATE_FILE=<tmp>/state.json node bot.js
   ```
   - Expect exit code 1, and an `alert` line on the console containing `okx-bot DOWN`.
   - Run it a second time with the same `OKX_BOT_LOG_DIR`. Expect `alert_throttled` for `cannot_start:cli_unrunnable`.
4. Render every catalog message with sample data (a scratchpad script calling `notify.*` with a stubbed `fetch`) and show the owner the texts.
5. Independent review: a `code-reviewer` subagent (Sonnet) over `git diff master...feat/telegram-notifications`.
6. Deploy (only with the owner's consent):
   - PR, then merge.
   - On the VPS: `git stash` → `pull --ff-only` → `stash pop`.
   - Add `TZ=Europe/Warsaw` to `.env`.
   - `docker compose -f deploy/docker-compose.yml up -d --build`.
   - `docker logs okx-bot`: expect `cli_auth_ok` + `tick`, and one silent "okx-bot started".
