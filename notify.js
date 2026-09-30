// notify.js — every Telegram message the bot can send, in one place.
//
// To know what can land on your phone, read this file top to bottom.
//
// Tiers:
//   loud   — act now: can't start, crashed, unhandled error, blind,
//            exit blocked/failing, untracked position, HALTED,
//            stopped with open positions, a message that failed to build
//   normal — trades: BUY, EXIT, BUY blocked
//   silent — FYI, no sound: started, stopped flat, recovered, scale-out,
//            SLOW, back to NORMAL, profit target, daily report, weekly heartbeat
//
// Transport: Bot API sendMessage with parse_mode HTML; every dynamic value
// goes through esc(). If Telegram still rejects the markup (HTTP 400) the
// message is re-sent once as plain text — a formatting slip must never eat
// an alert. Repeating alerts are throttled per key, and the last-sent map is
// persisted next to the logs so a Docker crash-restart loop can't spam.
// Dynamic text is clipped and scrubbed of credentials before it leaves.

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

// Credentials this process holds (OKX keys, the Telegram token) must never
// be echoed into Telegram by some CLI error text: Telegram history is cloud
// storage. Also drops control and bidi-override characters.
const SECRET_ENV = /KEY|SECRET|TOKEN|PASSPHRASE|PASSWORD/i;
function scrub(s) {
  for (const [k, v] of Object.entries(process.env)) {
    if (SECRET_ENV.test(k) && typeof v === 'string' && v.length >= 8) s = s.split(v).join('[redacted]');
  }
  return s
    .replace(/bot\d{6,}:[\w-]{20,}/g, 'bot[redacted]')
    .replace(/[\u0000-\u0008\u000b-\u001f\u007f\u200b-\u200f\u202a-\u202e\u2066-\u2069]/g, '');
}

export function clip(v, n = MAX_DYNAMIC_CHARS) {
  // Cut before splitting into code points: a 10 MB stderr must not cost
  // ~100 MB of heap in a 256 MB container.
  const chars = Array.from(scrub(String(v ?? '').slice(0, n * 4)));   // code points: never split an emoji
  return chars.length > n ? chars.slice(0, n - 1).join('') + '…' : chars.join('');
}

// "29 Sept, 23:40 CEST" in the process time zone — set TZ (e.g.
// Europe/Warsaw) in .env; unset means the host's zone (UTC in the Docker
// image). n/a for a missing or bad time.
export function fmtTime(ts) {
  const d = new Date(ts ?? NaN);   // new Date(null) would be 1970, not "missing"
  if (Number.isNaN(d.getTime())) return 'n/a';
  return d.toLocaleString('en-GB', {
    day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit', timeZoneName: 'short',
  });
}

export function fmtDuration(ms) {
  if (!Number.isFinite(ms)) return 'n/a';
  const m = Math.max(0, Math.round(ms / 60_000));
  if (m < 60) return `${m}m`;
  const h = Math.floor(m / 60);
  if (h < 24) return m % 60 ? `${h}h ${m % 60}m` : `${h}h`;
  const d = Math.floor(h / 24);
  return h % 24 ? `${d}d ${h % 24}h` : `${d}d`;
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
  return `\ntx: <code>${esc(clip(txId, 100))}</code>`;
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

// Atomic (temp file + rename, like state.js): a kill mid-write must not
// leave a truncated file behind.
function writeSent(sent) {
  const file = sentFile();
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(`${file}.tmp`, JSON.stringify(sent));
    fs.renameSync(`${file}.tmp`, file);
  } catch (err) {
    logger.warn('alerts_sent_write_failed', { error: err.message });
  }
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
  writeSent(sent);
}

// Drops the throttle entries whose key starts with `prefix`.
function forgetSent(prefix) {
  const sent = readSent();
  const stale = Object.keys(sent).filter(k => k.startsWith(prefix));
  if (stale.length === 0) return;
  for (const k of stale) delete sent[k];
  writeSent(sent);
}

// Digits and long ids vary per occurrence ("… 5012 ms at 12:03:44"): keep
// them out of the throttle key so one recurring error counts as one.
function errorKey(kind, message) {
  return `${kind}:${clip(message, 100).replace(/\d+|[1-9A-HJ-NP-Za-km-z]{32,}/g, '#')}`;
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
// Returns false only when Telegram is configured but did not accept the
// message, so a caller with its own retry logic (tickResult) can try again.
// Delivered, deliberately suppressed and not-configured all return true.
export async function send(html, opts) {
  try {
    const { silent = false, key = null, everyMs = 0 } = opts ?? {};
    if (key && (inFlight.has(key) || isThrottled(key, everyMs))) {
      logger.info('alert_throttled', { key });
      return true;
    }
    logger.info('alert', { message: html, silent });

    const token = process.env.TELEGRAM_BOT_TOKEN;
    const chat = process.env.TELEGRAM_CHAT_ID;
    if (!token || !chat) return true;

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
      return status === 200;
    } finally {
      if (key) inFlight.delete(key);
    }
  } catch (err) {
    logger.warn('alert_failed', { error: err.message });
    return false;
  }
}

// ─── Tick health: blind detector + report counters ─────────────────────────

const BLIND_AFTER_TICKS = 5;           // ≈ 5.5 min at the ~65 s real tick
const BLIND_REPEAT_MS = 30 * 60_000;   // a flapping upstream: at most one BLIND per 30 min

const health = {
  streak: 0,            // consecutive failed ticks
  streakSince: null,    // ts of the first failure in the streak
  alerted: false,       // BLIND delivered (or in flight) for this streak
  lastBlindAt: null,    // when the last BLIND was delivered
  day: { ticks: 0, failed: 0 },
  week: { since: Date.now(), ticks: 0, failed: 0 },
};

// Call once per main tick. Edge-triggered: one loud alert per streak of
// failed ticks — from the 5th on, retried on the next failed tick if
// Telegram didn't take it — and one silent note on the first success after.
export async function tickResult(ok, error = null, now = Date.now()) {
  health.day.ticks++;
  health.week.ticks++;
  if (ok) {
    const { alerted, streakSince } = health;
    health.streak = 0;
    health.streakSince = null;
    health.alerted = false;
    if (alerted) {
      await send(
        `✅ <b>okx-bot recovered</b> after ${fmtDuration(now - streakSince)} of failed ticks`,
        { silent: true }
      );
    }
    return;
  }
  health.day.failed++;
  health.week.failed++;
  if (health.streak === 0) health.streakSince = now;
  health.streak++;
  if (health.streak >= BLIND_AFTER_TICKS && !health.alerted) {
    // Flapping: blind again soon after a BLIND went out. Stay quiet until the
    // window passes; a streak that is still running then alerts.
    if (health.lastBlindAt !== null && now - health.lastBlindAt < BLIND_REPEAT_MS) return;
    health.alerted = true;   // before the await: an overlapping call can't double-send
    const delivered = await send(
      `🚨 <b>okx-bot BLIND</b> — ${health.streak} ticks failed in a row (${fmtDuration(now - health.streakSince)})\n` +
      `Last error: <code>${esc(clip(error || 'unknown'))}</code>\n` +
      `It is running but can't read the market or wallet: no new entries, and stop checks are probably failing too.`
    );
    if (health.streak > 0) health.alerted = delivered;   // not delivered → retry next failure
    if (delivered) health.lastBlindAt = now;
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
    .map(([k, n]) => `${esc(Object.hasOwn(FUNNEL_LABELS, k) ? FUNNEL_LABELS[k] : k)} ${fmtInt(n)}`)
    .join(' · ');
  await send(
    `💓 <b>okx-bot weekly</b> · ${modeLabel()} · since ${fmtTime(since)}\n` +
    `${fmtInt(ticks)} ticks, ${fmtInt(failed)} failed · portfolio ${fmtUsd(portfolio_usd)}\n` +
    `Trades ${week.trades} (${week.wins}W / ${week.trades - week.wins}L) · realized ${fmtSigned(week.pnl_usd, '$')}\n` +
    `Entry filter, ${fmtInt(checks)} token checks: ${outcomes || 'none'}`,
    { silent: true }
  );
}

// ─── Lifecycle ─────────────────────────────────────────────────────────────

export async function started({ portfolio_usd, open_positions }) {
  // A good start ends every "can't start" incident: the next failure, even
  // an hour later, must alert again instead of waiting out the 6h window.
  forgetSent('cannot_start:');
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
    { key: errorKey('crash', message), everyMs: HOUR }
  );
}

export async function unhandled(message) {
  await send(
    `🚨 <b>Unhandled error</b> (the bot keeps running)\n<code>${esc(clip(message))}</code>`,
    { key: errorKey('unhandled', message), everyMs: HOUR }
  );
}

// id: stable per failure kind (tokens_unreadable, cli_not_logged_in,
// cli_unrunnable, balance_unreadable, startup_crash) so a crash loop repeats
// at most every 6h. A successful start re-arms it (see started).
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
    `🟢 <b>BUY ${esc(symbol)}</b> ${fmtUsd(size_usd)} (${fmtInt(pct_of_portfolio)}% of portfolio)${dryTag()}\n` +
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
    `Sold ${fmtInt(fraction * 100)}% for ${fmtUsd(proceeds_usd)} · booked ${fmtSigned(booked_usd, '$')}`,
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
      (exit_quality != null && realized_pnl_pct > 0 ? ` · kept ${fmtInt(exit_quality * 100)}% of peak gain` : ''),
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

// Callers use the default export, where every function runs through
// `guarded`: a message that fails to build (a missing field) must not
// reject into a trade path, and must not vanish silently either — a short
// fallback alert goes out instead.
function guarded(name, fn) {
  return async (...args) => {
    try {
      return await fn(...args);
    } catch (err) {
      const msg = String(err?.message ?? err);   // a non-Error throw must not reject here
      logger.warn('alert_build_failed', { name, error: msg });
      return send(
        `⚠️ <b>okx-bot</b>: the "${name}" alert could not be built ` +
        `(<code>${esc(clip(msg))}</code>) — see the logs.`,
        { key: `alert_build_failed:${name}`, everyMs: HOUR }
      );
    }
  };
}

const catalog = {
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

export default Object.fromEntries(
  Object.entries(catalog).map(([name, fn]) => [name, guarded(name, fn)])
);
