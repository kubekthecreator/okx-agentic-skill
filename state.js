// state.js — persistent state. Atomic writes, survives restarts.
//
// state.json schema:
// {
//   "machine_state": "Normal" | "Slow" | "Halted",
//   "halt_until": ISO timestamp | null,
//   "post_win_cooldown_until": ISO timestamp | null,
//   "positions": { [position_id]: Position },
//   "history": Trade[],          // closed positions, append-only
//   "daily": {
//     "date": "YYYY-MM-DD",       // UTC
//     "starting_portfolio_usd": number,
//     "trades": number,
//     "wins": number,
//     "losses": number,
//     "consecutive_losses": number,
//     "realized_pnl_usd": number
//   },
//   "setup_stats": { [setup_id]: { trades, wins, losses, halted_until } }
// }
//
// Position schema:
// {
//   id: uuid,
//   token: { symbol, mint, decimals },
//   entry_ts: ISO,
//   entry_price_usd: number,
//   entry_amount_token: number,
//   entry_value_usd: number,
//   peak_pnl_pct: number,
//   peak_pnl_ts: ISO,
//   entry_signals: { trend, momentum, valuation, catalyst_type, rs_boost },
//   kill_conditions: KillCondition[],
//   scale_outs_done: [0.15, 0.30, 0.50] subset,
//   current_amount_token: number,    // decreases on scale-outs
//   setup_id: string                 // for anti-pattern detector
// }

import fs from 'fs';
import path from 'path';
import { randomUUID } from 'crypto';
import { logger } from './logger.js';

const STATE_FILE = path.join(process.cwd(), 'state.json');
const TMP_FILE = STATE_FILE + '.tmp';

const DEFAULT_STATE = () => ({
  machine_state: 'Normal',
  halt_until: null,
  post_win_cooldown_until: null,
  positions: {},
  history: [],
  daily: newDailyStats(0),
  setup_stats: {},
});

function newDailyStats(starting_portfolio_usd) {
  return {
    date: utcDate(),
    starting_portfolio_usd,
    trades: 0,
    wins: 0,
    losses: 0,
    consecutive_losses: 0,
    realized_pnl_usd: 0,
  };
}

function utcDate() {
  return new Date().toISOString().slice(0, 10);
}

let cache = null;

export function loadState() {
  if (cache) return cache;
  try {
    if (fs.existsSync(STATE_FILE)) {
      cache = JSON.parse(fs.readFileSync(STATE_FILE, 'utf-8'));
      logger.info('state_loaded', {
        positions: Object.keys(cache.positions || {}).length,
        history_count: (cache.history || []).length,
      });
    } else {
      cache = DEFAULT_STATE();
      logger.info('state_initialized');
    }
  } catch (err) {
    // Preserve the bad file as evidence before falling back to defaults.
    // Without this, the next saveState() would overwrite the only record of
    // open positions / history.
    const backup = `${STATE_FILE}.corrupted-${Date.now()}`;
    try {
      fs.copyFileSync(STATE_FILE, backup);
      logger.error('state_load_failed_backup_saved', { error: err.message, backup });
    } catch (copyErr) {
      logger.error('state_load_failed_backup_failed', {
        error: err.message, backup_error: copyErr.message,
      });
    }
    cache = DEFAULT_STATE();
  }
  return cache;
}

export function saveState() {
  if (!cache) return;
  try {
    // Atomic: write to temp, rename
    fs.writeFileSync(TMP_FILE, JSON.stringify(cache, null, 2));
    fs.renameSync(TMP_FILE, STATE_FILE);
  } catch (err) {
    logger.error('state_save_failed', { error: err.message });
  }
}

// Rotate daily stats at UTC midnight. Call this on every tick — it's a no-op
// if the date hasn't changed.
export function rotateDaily(current_portfolio_usd) {
  const s = loadState();
  if (s.daily.date !== utcDate()) {
    logger.info('daily_rotation', {
      previous_date: s.daily.date,
      previous_realized_pnl_usd: s.daily.realized_pnl_usd,
      trades: s.daily.trades,
    });
    s.daily = newDailyStats(current_portfolio_usd);
    // Clear post-win cooldown at midnight (fresh start)
    s.post_win_cooldown_until = null;
    saveState();
  }
}

// ─── Position operations ──────────────────────────────────────────────────

export function openPosition(data) {
  const s = loadState();
  const position = {
    id: randomUUID(),
    ...data,
    peak_pnl_pct: 0,
    peak_pnl_ts: data.entry_ts,
    scale_outs_done: [],
    current_amount_token: data.entry_amount_token,
  };
  s.positions[position.id] = position;
  saveState();
  return position;
}

export function updatePosition(positionId, updates) {
  const s = loadState();
  const pos = s.positions[positionId];
  if (!pos) return null;
  Object.assign(pos, updates);
  saveState();
  return pos;
}

export function closePosition(positionId, exitData) {
  const s = loadState();
  const pos = s.positions[positionId];
  if (!pos) return null;

  const trade = {
    ...pos,
    exit_ts: exitData.exit_ts,
    exit_price_usd: exitData.exit_price_usd,
    exit_reason: exitData.exit_reason,
    realized_pnl_usd: exitData.realized_pnl_usd,
    realized_pnl_pct: exitData.realized_pnl_pct,
    exit_quality: pos.peak_pnl_pct > 0
      ? Math.max(0, exitData.realized_pnl_pct / pos.peak_pnl_pct)
      : null,
    hold_duration_ms: new Date(exitData.exit_ts) - new Date(pos.entry_ts),
  };

  s.history.push(trade);
  delete s.positions[positionId];

  // Daily stats
  s.daily.trades += 1;
  s.daily.realized_pnl_usd += trade.realized_pnl_usd;
  if (trade.realized_pnl_usd > 0) {
    s.daily.wins += 1;
    s.daily.consecutive_losses = 0;
  } else {
    s.daily.losses += 1;
    s.daily.consecutive_losses += 1;
  }

  // Setup stats (for anti-pattern detector)
  const setupId = pos.setup_id;
  if (!s.setup_stats[setupId]) {
    s.setup_stats[setupId] = { trades: 0, wins: 0, losses: 0, halted_until: null };
  }
  s.setup_stats[setupId].trades += 1;
  if (trade.realized_pnl_usd > 0) s.setup_stats[setupId].wins += 1;
  else s.setup_stats[setupId].losses += 1;

  saveState();
  return trade;
}

export function getOpenPositions() {
  const s = loadState();
  return Object.values(s.positions);
}

export function getOpenPositionForToken(symbol) {
  return getOpenPositions().find(p => p.token.symbol === symbol);
}

// ─── Machine state ─────────────────────────────────────────────────────────

export function setMachineState(state, haltUntil = null) {
  const s = loadState();
  const previous = s.machine_state;
  s.machine_state = state;
  s.halt_until = haltUntil;
  saveState();
  if (previous !== state) {
    logger.info('state_transition', { from: previous, to: state, halt_until: haltUntil });
  }
}

export function setPostWinCooldown(untilTs) {
  const s = loadState();
  s.post_win_cooldown_until = untilTs;
  saveState();
}

// ─── Setup tracking (anti-pattern) ─────────────────────────────────────────

export function haltSetup(setupId, untilTs) {
  const s = loadState();
  if (!s.setup_stats[setupId]) return;
  s.setup_stats[setupId].halted_until = untilTs;
  saveState();
  logger.warn('setup_halted', { setup_id: setupId, until: untilTs });
}

export function isSetupHalted(setupId) {
  const s = loadState();
  const stats = s.setup_stats[setupId];
  if (!stats || !stats.halted_until) return false;
  return new Date(stats.halted_until) > new Date();
}

// ─── Recent history helpers ────────────────────────────────────────────────

export function getRecentTrades(count) {
  const s = loadState();
  return s.history.slice(-count);
}

export function getRecentExitQuality(count = 5) {
  const recent = getRecentTrades(count)
    .filter(t => t.exit_quality !== null);
  if (recent.length === 0) return null;
  const sum = recent.reduce((acc, t) => acc + t.exit_quality, 0);
  return sum / recent.length;
}

export default {
  loadState,
  saveState,
  rotateDaily,
  openPosition,
  updatePosition,
  closePosition,
  getOpenPositions,
  getOpenPositionForToken,
  setMachineState,
  setPostWinCooldown,
  haltSetup,
  isSetupHalted,
  getRecentTrades,
  getRecentExitQuality,
};
