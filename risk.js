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

// ─── State machine evaluation ──────────────────────────────────────────────

// Call at start of every tick. Reconciles current state with live conditions.
export function evaluateState(portfolio_usd) {
  const s = state.loadState();
  const now = new Date();

  // Auto-recover from Halted if cooldown expired → transition to Slow
  if (s.machine_state === 'Halted' && s.halt_until && new Date(s.halt_until) <= now) {
    state.setMachineState('Slow');
    logger.info('halt_cooldown_expired_to_slow');
  }

  // Check Halted triggers
  const haltReason = checkHaltTriggers(portfolio_usd);
  if (haltReason) {
    if (s.machine_state !== 'Halted') {
      const until = new Date(now.getTime() + HALT_DURATION_MS).toISOString();
      state.setMachineState('Halted', until);
      alert(`🔴 *HALTED*\nReason: \`${haltReason}\`\nCooldown until: ${until}`);
    }
    return { state: 'Halted', reason: haltReason };
  }

  // Check Slow triggers (only if not already Halted)
  const slowReason = checkSlowTriggers(portfolio_usd);
  if (slowReason) {
    if (s.machine_state !== 'Slow' && s.machine_state !== 'Halted') {
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

function checkHaltTriggers(portfolio_usd) {
  const s = state.loadState();
  const daily = s.daily;

  // 3 losses in a row
  if (daily.consecutive_losses >= 3) return 'three_consecutive_losses';

  // Daily loss limit
  const dailyPnlPct = daily.starting_portfolio_usd > 0
    ? (daily.realized_pnl_usd / daily.starting_portfolio_usd) * 100
    : 0;
  if (dailyPnlPct <= -DAILY_LOSS_LIMIT_PCT) return 'daily_loss_limit';

  // Daily profit target (halts NEW entries only — existing positions OK)
  if (dailyPnlPct >= DAILY_PROFIT_TARGET_PCT) return 'daily_profit_target';

  return null;
}

function checkSlowTriggers(_portfolio_usd) {
  const s = state.loadState();
  const daily = s.daily;

  if (daily.losses >= 2) return 'two_losses_today';

  const dailyPnlPct = daily.starting_portfolio_usd > 0
    ? (daily.realized_pnl_usd / daily.starting_portfolio_usd) * 100
    : 0;
  if (dailyPnlPct <= -SLOW_TRIGGER_PNL_PCT) return 'half_daily_loss';

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
  const dailyPnlPct = s.daily.starting_portfolio_usd > 0
    ? (s.daily.realized_pnl_usd / s.daily.starting_portfolio_usd) * 100
    : 0;
  if (dailyPnlPct >= DAILY_PROFIT_TARGET_PCT) {
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

// Returns USD size for a new position, or 0 if no capacity / disallowed.
export function computePositionSize({
  portfolio_usd,
  cash_usd,
  token_config,
  rs_boost = false,
}) {
  const s = state.loadState();

  // Per-portfolio cap (25% per position default)
  const baseFractionOfPortfolio = 0.25;
  const slowFraction = 0.125;  // half in Slow
  const fraction = s.machine_state === 'Slow' ? slowFraction : baseFractionOfPortfolio;
  let size = portfolio_usd * fraction;

  // Per-token cap
  const tokenCap = token_config.max_position_usd || 50;
  size = Math.min(size, tokenCap);

  // Booster: +25% in Normal mode only
  if (rs_boost && s.machine_state === 'Normal') {
    size = size * 1.25;
  }

  // Don't blow cash buffer (always keep ~25% cash)
  const maxFromCash = cash_usd * 0.75;
  size = Math.min(size, maxFromCash);

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
  getTrailingStopPct,
  getHardStopPct,
  onPositionClosed,
};
