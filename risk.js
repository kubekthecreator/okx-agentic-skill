// risk.js — the bot's discipline layer.
//
// Three responsibilities:
//   1. State machine (Normal | Slow | Halted) with transition logic
//   2. Position sizing (capital allocation rules)
//   3. Anti-pattern detector (halt setups that consistently lose)

import { logger, alert } from './logger.js';
import state from './state.js';

const SLOW_TRAILING_PCT = 5;
const NORMAL_TRAILING_PCT = 8;
const HARD_STOP_PCT = 10;

const HALT_DURATION_MS = 4 * 60 * 60 * 1000;     // 4 hours
const POST_WIN_COOLDOWN_MS = 2 * 60 * 60 * 1000; // 2 hours
const SETUP_HALT_MS = 24 * 60 * 60 * 1000;       // 24 hours

const DAILY_LOSS_LIMIT_PCT = 3;
const SLOW_TRIGGER_PNL_PCT = 1.5;
const DAILY_PROFIT_TARGET_PCT = 5;

const POST_WIN_THRESHOLD_PCT = 3;  // PnL above this triggers cooldown

function dailyPnlPct(daily) {
  return daily.starting_portfolio_usd > 0
    ? (daily.realized_pnl_usd / daily.starting_portfolio_usd) * 100
    : 0;
}

// ─── State machine evaluation ──────────────────────────────────────────────

// Call at start of every tick. Reconciles current state with live conditions.
//
// Halt triggers are LEVELS (consecutive_losses stays ≥3 until a win or
// midnight) but a halt is an EDGE: serve the 4h cooldown once, drop to Slow,
// and only halt again if a new trade closes and the condition still holds.
// v0.1 re-evaluated the level right after expiry and re-entered Halted
// every 4h until midnight — the documented "after 4h → Slow" never happened
// and Telegram got a fresh HALTED alert every cooldown.
export function evaluateState(_portfolio_usd) {
  const s = state.loadState();
  const now = new Date();

  if (s.machine_state === 'Halted') {
    if (s.halt_until && new Date(s.halt_until) <= now) {
      state.setMachineState('Slow');
      logger.info('halt_cooldown_expired_to_slow');
    } else {
      return { state: 'Halted', reason: s.halt_trigger?.reason || 'halted' };
    }
  }

  // Check Halted triggers
  const haltReason = checkHaltTriggers();
  if (haltReason) {
    const until = new Date(now.getTime() + HALT_DURATION_MS).toISOString();
    // Snapshot what tripped this halt (persisted by setMachineState below)
    // so the same still-true level doesn't re-halt once the cooldown ends.
    s.halt_trigger = { reason: haltReason, date: s.daily.date, trades: s.daily.trades };
    state.setMachineState('Halted', until);
    alert(`🔴 *HALTED*\nReason: \`${haltReason}\`\nCooldown until: ${until}`);
    return { state: 'Halted', reason: haltReason };
  }

  // Daily profit target blocks NEW entries only (enforced in canOpenPosition).
  // It deliberately does not enter Halted: that would tighten trailing stops
  // on the very winners that hit the target. Alert once per UTC day.
  notifyProfitTargetOnce(s);

  // Check Slow triggers
  const slowReason = checkSlowTriggers();
  if (slowReason) {
    if (s.machine_state !== 'Slow') {
      state.setMachineState('Slow');
      alert(`🟡 *SLOW MODE*\nReason: \`${slowReason}\``);
    }
    return { state: 'Slow', reason: slowReason };
  }

  // Otherwise Normal
  if (s.machine_state !== 'Normal') {
    state.setMachineState('Normal');
    alert(`🟢 *NORMAL*\nResumed standard operation`);
  }
  return { state: 'Normal' };
}

function checkHaltTriggers() {
  const s = state.loadState();
  const daily = s.daily;

  let reason = null;
  if (daily.consecutive_losses >= 3) reason = 'three_consecutive_losses';            // 3 losses in a row
  else if (dailyPnlPct(daily) <= -DAILY_LOSS_LIMIT_PCT) reason = 'daily_loss_limit';  // daily loss limit
  if (!reason) return null;

  // A halt was already served today and no trade has closed since — the
  // level is stale, not a new event.
  const t = s.halt_trigger;
  if (t && t.date === daily.date && t.trades === daily.trades) return null;

  return reason;
}

function notifyProfitTargetOnce(s) {
  const pct = dailyPnlPct(s.daily);
  if (pct >= DAILY_PROFIT_TARGET_PCT && !s.daily.profit_target_alerted) {
    s.daily.profit_target_alerted = true;   // reset naturally by daily rotation
    state.saveState();
    logger.info('daily_profit_target_hit', { daily_pnl_pct: pct });
    alert(
      `🎯 *DAILY PROFIT TARGET* ${pct >= 0 ? '+' : ''}${pct.toFixed(2)}%\n` +
      `No new entries until UTC midnight. Open positions keep being managed.`
    );
  }
}

function checkSlowTriggers() {
  const s = state.loadState();
  const daily = s.daily;

  if (daily.losses >= 2) return 'two_losses_today';

  if (dailyPnlPct(daily) <= -SLOW_TRIGGER_PNL_PCT) return 'half_daily_loss';

  const eq = state.getRecentExitQuality(5);
  if (eq !== null && eq < 0.4) return 'low_exit_quality';

  return null;
}

// ─── Entry gate ────────────────────────────────────────────────────────────

// Can the bot open a new position right now? Returns { allowed, reason }.
export function canOpenPosition(setupId) {
  const s = state.loadState();
  const now = new Date();

  // Hard halts
  if (s.machine_state === 'Halted') {
    return { allowed: false, reason: `state_halted_until_${s.halt_until}` };
  }

  // Post-win cooldown
  if (s.post_win_cooldown_until && new Date(s.post_win_cooldown_until) > now) {
    return { allowed: false, reason: 'post_win_cooldown' };
  }

  // Daily profit target → no new entries today
  if (dailyPnlPct(s.daily) >= DAILY_PROFIT_TARGET_PCT) {
    return { allowed: false, reason: 'daily_profit_target_hit' };
  }

  // Setup-specific halt (anti-pattern)
  if (setupId && state.isSetupHalted(setupId)) {
    return { allowed: false, reason: 'setup_anti_pattern_halt' };
  }

  // Concurrent position limit
  const openCount = state.getOpenPositions().length;
  const maxConcurrent = s.machine_state === 'Slow' ? 1 : 3;
  if (openCount >= maxConcurrent) {
    return { allowed: false, reason: `max_concurrent_${maxConcurrent}` };
  }

  return { allowed: true };
}

// ─── Position sizing ───────────────────────────────────────────────────────

// Entry cost basis still held across all open positions (scale-outs release
// their share). This is what MAX_PORTFOLIO_USD caps.
export function deployedCostBasisUsd() {
  return state.getOpenPositions().reduce((acc, p) => {
    const entryAmt = p.entry_amount_token || 0;
    const curAmt = p.current_amount_token ?? entryAmt;
    const frac = entryAmt > 0 ? Math.max(0, Math.min(1, curAmt / entryAmt)) : 1;
    return acc + (p.entry_value_usd || 0) * frac;
  }, 0);
}

// Returns USD size for a new position, or 0 if no capacity / disallowed.
export function computePositionSize({
  portfolio_usd,
  cash_usd,
  token_config,
  rs_boost = false,
}) {
  const s = state.loadState();

  // Per-portfolio fraction (25% per position default, half in Slow)
  const baseFractionOfPortfolio = 0.25;
  const slowFraction = 0.125;
  const fraction = s.machine_state === 'Slow' ? slowFraction : baseFractionOfPortfolio;
  let size = portfolio_usd * fraction;

  // Booster: +25% in Normal mode only. Applied BEFORE the caps so a boosted
  // entry can never exceed the per-token or global ceilings.
  if (rs_boost && s.machine_state === 'Normal') {
    size = size * 1.25;
  }

  // Per-token cap
  const tokenCap = token_config.max_position_usd || 50;
  size = Math.min(size, tokenCap);

  // Don't blow cash buffer (always keep ~25% cash)
  const maxFromCash = cash_usd * 0.75;
  size = Math.min(size, maxFromCash);

  // Global deployment ceiling: MAX_PORTFOLIO_USD (.env). Cost basis held +
  // this entry must stay under it. Unset / 0 = no global cap.
  const maxDeploy = parseFloat(process.env.MAX_PORTFOLIO_USD || '0');
  if (maxDeploy > 0) {
    size = Math.min(size, maxDeploy - deployedCostBasisUsd());
  }

  // Min trade
  const minSize = parseFloat(process.env.MIN_TRADE_SIZE_USD || '5');
  if (size < minSize) return 0;

  return size;
}

// ─── Exit thresholds (state-aware) ─────────────────────────────────────────

export function getTrailingStopPct() {
  const s = state.loadState();
  return s.machine_state === 'Slow' || s.machine_state === 'Halted'
    ? SLOW_TRAILING_PCT
    : NORMAL_TRAILING_PCT;
}

export function getHardStopPct() {
  return HARD_STOP_PCT;
}

// ─── Post-trade hooks ──────────────────────────────────────────────────────

// Called after a position closes. Handles:
//   - post-win cooldown
//   - anti-pattern detection
export function onPositionClosed(trade) {
  const realizedPctOfPortfolio = trade.daily_portfolio_at_close > 0
    ? (trade.realized_pnl_usd / trade.daily_portfolio_at_close) * 100
    : 0;

  // Post-win cooldown after profitable close > 3% of portfolio
  if (realizedPctOfPortfolio > POST_WIN_THRESHOLD_PCT) {
    const until = new Date(Date.now() + POST_WIN_COOLDOWN_MS).toISOString();
    state.setPostWinCooldown(until);
    alert(`✅ *WIN +${realizedPctOfPortfolio.toFixed(2)}%* — cooldown 2h until ${until}`);
  }

  // Anti-pattern: 5 losses on same setup → halt that setup 24h
  const s = state.loadState();
  const setupStats = s.setup_stats[trade.setup_id];
  if (setupStats && setupStats.losses >= 5 && setupStats.wins / setupStats.trades < 0.3) {
    const until = new Date(Date.now() + SETUP_HALT_MS).toISOString();
    state.haltSetup(trade.setup_id, until);
    alert(`⚠️ *ANTI-PATTERN* Setup \`${trade.setup_id}\` halted 24h\n${setupStats.wins}/${setupStats.trades} winrate`);
  }
}

export default {
  evaluateState,
  canOpenPosition,
  computePositionSize,
  deployedCostBasisUsd,
  getTrailingStopPct,
  getHardStopPct,
  onPositionClosed,
};
