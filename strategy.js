// strategy.js — orchestrates signals, risk, and execution to make decisions.
//
// Two main entry points called from bot.js:
//   - evaluateNewEntries(tokenList) — scans candidates, opens positions where eligible
//   - manageOpenPositions() — updates peaks, checks exits, executes scale-outs

import { randomUUID } from 'crypto';
import { logger, alert, alertWithVeto } from './logger.js';
import signals from './signals.js';
import risk from './risk.js';
import execution from './execution.js';
import state from './state.js';

const SCALE_OUT_LEVELS = [
  { pct: 15, fraction: 0.20 },
  { pct: 30, fraction: 0.30 },
  { pct: 50, fraction: 0.30 },
];
const TIME_STOP_MS = 5 * 24 * 60 * 60 * 1000;  // 5 days
const VOLUME_COLLAPSE_PCT = 70;
const VETO_THRESHOLD_FRACTION = 0.15;  // positions > 15% of portfolio need veto

// ─── New entries ───────────────────────────────────────────────────────────

export async function evaluateNewEntries({ tokens, baseToken, referenceMint, portfolio_usd, cash_usd }) {
  const machineState = state.loadState().machine_state;

  // Fetch reference candles once (SOL — used for relative strength)
  const refCandles = await execution.fetchCandles(referenceMint, 8);

  for (const token of tokens) {
    // Skip if already in this token
    if (state.getOpenPositionForToken(token.symbol)) continue;

    // Fetch data
    const candles = await execution.fetchCandles(token.mint, 48);
    if (candles.length < 24) {
      logger.debug('skip_insufficient_candles', { token: token.symbol });
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

    if (!eval_.passed) continue;

    // Risk gate
    const gate = risk.canOpenPosition(eval_.setup_id);
    if (!gate.allowed) {
      logger.info('entry_blocked', { token: token.symbol, reason: gate.reason });
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
      continue;
    }

    // Preflight
    const pf = await execution.preflightCheck();
    if (!pf.ok) {
      logger.warn('entry_blocked_preflight', { token: token.symbol, reason: pf.reason });
      continue;
    }

    // Veto for material positions
    if (size / portfolio_usd > VETO_THRESHOLD_FRACTION) {
      const vetoed = await alertWithVeto(
        `🟢 Plan: BUY ${token.symbol} for $${size.toFixed(2)} (${((size / portfolio_usd) * 100).toFixed(1)}% of portfolio)\nSetup: ${eval_.setup_id}`,
      );
      if (vetoed) {
        logger.info('entry_vetoed', { token: token.symbol });
        continue;
      }
    }

    // Execute
    await openPosition({ token, baseToken, size_usd: size, signals: eval_ });
    cash_usd -= size;
  }
}

async function openPosition({ token, baseToken, size_usd, signals: ev }) {
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
    logger.error('entry_swap_failed', { token: token.symbol, error: err.message });
    return;
  }

  const candles = await execution.fetchCandles(token.mint, 1);
  const entry_price_usd = candles.length > 0 ? candles[candles.length - 1].close : null;
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
  });

  await alert(
    `🟢 *BUY ${token.symbol}*\n` +
    `Size: $${size_usd.toFixed(2)}\n` +
    `Entry: $${entry_price_usd}\n` +
    `Setup: \`${ev.setup_id}\`\n` +
    `TX: \`${fill.tx_id}\`` +
    (fill.dry_run ? '\n_(dry run)_' : '')
  );
}

function buildKillConditions(ev, candles) {
  const peakVol = Math.max(...candles.map(c => c.volume_usd));
  return [
    {
      type: 'volume_collapse',
      reference_volume_usd: peakVol,
      drop_threshold_pct: VOLUME_COLLAPSE_PCT,
    },
    {
      type: 'time_stop',
      max_hold_ms: TIME_STOP_MS,
    },
    // Catalyst death is checked dynamically against current catalysts
    {
      type: 'catalyst_death',
      original_catalysts: ev.breakdown.catalyst.catalysts_active.map(c => c.type),
    },
  ];
}

// ─── Position management ───────────────────────────────────────────────────

export async function manageOpenPositions({ baseToken }) {
  const positions = state.getOpenPositions();
  for (const pos of positions) {
    try {
      await managePosition(pos, baseToken);
    } catch (err) {
      logger.error('manage_position_failed', {
        position_id: pos.id, token: pos.token.symbol, error: err.message,
      });
    }
  }
}

async function managePosition(pos, baseToken) {
  const candles = await execution.fetchCandles(pos.token.mint, 6);
  if (candles.length === 0) return;
  const current_price = signals.lastPrice(candles);
  const pnl_pct = ((current_price - pos.entry_price_usd) / pos.entry_price_usd) * 100;

  // Update peak
  if (pnl_pct > pos.peak_pnl_pct) {
    state.updatePosition(pos.id, {
      peak_pnl_pct: pnl_pct,
      peak_pnl_ts: new Date().toISOString(),
    });
    pos.peak_pnl_pct = pnl_pct;
  }

  // ── Exit checks (first match wins) ──

  // 1. Hard stop
  if (pnl_pct <= -risk.getHardStopPct()) {
    return closeAll(pos, baseToken, current_price, 'hard_stop');
  }

  // 2. Trailing stop
  const trailing = risk.getTrailingStopPct();
  if (pos.peak_pnl_pct > 0 && (pos.peak_pnl_pct - pnl_pct) >= trailing) {
    return closeAll(pos, baseToken, current_price, `trailing_stop_${trailing}pct`);
  }

  // 3. Time stop
  const heldMs = Date.now() - new Date(pos.entry_ts).getTime();
  if (heldMs > TIME_STOP_MS) {
    return closeAll(pos, baseToken, current_price, 'time_stop_5d');
  }

  // 4. Volume collapse (kill condition)
  const volKill = pos.kill_conditions.find(k => k.type === 'volume_collapse');
  if (volKill) {
    const recentVol = candles[candles.length - 1].volume_usd;
    const dropPct = ((volKill.reference_volume_usd - recentVol) / volKill.reference_volume_usd) * 100;
    if (dropPct >= volKill.drop_threshold_pct) {
      return closeAll(pos, baseToken, current_price, `volume_collapse_${dropPct.toFixed(0)}pct`);
    }
  }

  // 5. Catalyst death — re-fetch and check
  const catKill = pos.kill_conditions.find(k => k.type === 'catalyst_death');
  if (catKill) {
    const currentCatalysts = await execution.fetchCatalysts(pos.token.mint);
    const sig = signals.signalCatalyst(currentCatalysts);
    if (!sig.passed) {
      return closeAll(pos, baseToken, current_price, 'catalyst_death');
    }
  }

  // 6. Scale-outs (don't close, just partial)
  await checkScaleOuts(pos, baseToken, pnl_pct, current_price);
}

async function checkScaleOuts(pos, baseToken, pnl_pct, current_price) {
  for (const level of SCALE_OUT_LEVELS) {
    if (pos.scale_outs_done.includes(level.pct)) continue;
    if (pnl_pct < level.pct) continue;

    const amount_to_sell = pos.entry_amount_token * level.fraction;
    if (amount_to_sell <= 0) continue;

    const clientOrderId = `scaleout-${pos.id}-${level.pct}`;
    try {
      const fill = await execution.executeSwap({
        fromMint: pos.token.mint,
        toMint: baseToken.mint,
        amount: String(Math.floor(amount_to_sell * Math.pow(10, pos.token.decimals))),
        clientOrderId,
      });
      const remaining = pos.current_amount_token - amount_to_sell;
      state.updatePosition(pos.id, {
        scale_outs_done: [...pos.scale_outs_done, level.pct],
        current_amount_token: remaining,
      });
      pos.scale_outs_done.push(level.pct);
      pos.current_amount_token = remaining;
      await alert(
        `📤 *SCALE-OUT ${pos.token.symbol} @ +${level.pct}%*\n` +
        `Sold ${(level.fraction * 100).toFixed(0)}% (${amount_to_sell.toFixed(4)})\n` +
        `TX: \`${fill.tx_id}\``
      );
    } catch (err) {
      logger.warn('scale_out_failed', { position_id: pos.id, level: level.pct, error: err.message });
    }
  }
}

async function closeAll(pos, baseToken, current_price, reason) {
  const clientOrderId = `exit-${pos.id}`;
  const amount = pos.current_amount_token;
  if (amount <= 0) {
    // Already fully scaled out; just mark closed
    return finalizeClose(pos, current_price, reason);
  }

  try {
    const fill = await execution.executeSwap({
      fromMint: pos.token.mint,
      toMint: baseToken.mint,
      amount: String(Math.floor(amount * Math.pow(10, pos.token.decimals))),
      clientOrderId,
    });
    return finalizeClose(pos, current_price, reason, fill);
  } catch (err) {
    logger.error('close_swap_failed', { position_id: pos.id, error: err.message });
  }
}

async function finalizeClose(pos, current_price, reason, fill = null) {
  const realized_pnl_pct = ((current_price - pos.entry_price_usd) / pos.entry_price_usd) * 100;
  const realized_pnl_usd = pos.entry_value_usd * (realized_pnl_pct / 100);

  const portfolio_usd = await execution.getPortfolioValueUsd();
  const trade = state.closePosition(pos.id, {
    exit_ts: new Date().toISOString(),
    exit_price_usd: current_price,
    exit_reason: reason,
    realized_pnl_usd,
    realized_pnl_pct,
  });

  // For post-trade hooks
  trade.daily_portfolio_at_close = portfolio_usd;
  risk.onPositionClosed(trade);

  const emoji = realized_pnl_usd > 0 ? '✅' : '❌';
  await alert(
    `${emoji} *EXIT ${pos.token.symbol}* @ +${realized_pnl_pct.toFixed(2)}%\n` +
    `Reason: \`${reason}\`\n` +
    `PnL: $${realized_pnl_usd.toFixed(2)}\n` +
    `Peak was: +${pos.peak_pnl_pct.toFixed(2)}%\n` +
    `Exit quality: ${trade.exit_quality !== null ? (trade.exit_quality * 100).toFixed(0) + '%' : 'n/a'}`
  );
}

export default {
  evaluateNewEntries,
  manageOpenPositions,
};
