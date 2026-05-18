// scripts/status.js — read-only snapshot of bot state.
// Usage: npm run status

import 'dotenv/config';
import state from '../state.js';
import execution from '../execution.js';

async function main() {
  const s = state.loadState();
  const portfolio = await execution.getPortfolioValueUsd().catch(() => null);
  const cash = await execution.getCashUsd().catch(() => null);
  const sol = await execution.getSolGasBalance().catch(() => null);

  console.log('\n═══════════ OKX Trend-Follower — Status ═══════════\n');
  console.log(`State:           ${stateEmoji(s.machine_state)} ${s.machine_state}`);
  if (s.halt_until) console.log(`Halt until:      ${s.halt_until}`);
  if (s.post_win_cooldown_until) console.log(`Post-win cd:     ${s.post_win_cooldown_until}`);

  console.log(`\nPortfolio:       ${formatUsd(portfolio)}`);
  console.log(`Cash (USDC):     ${formatUsd(cash)}`);
  console.log(`SOL (gas):       ${sol !== null ? sol.toFixed(4) : 'n/a'}`);

  console.log(`\nDaily (${s.daily.date}):`);
  console.log(`  Started at:    ${formatUsd(s.daily.starting_portfolio_usd)}`);
  console.log(`  Trades today:  ${s.daily.trades} (${s.daily.wins}W / ${s.daily.losses}L)`);
  console.log(`  Realized PnL:  ${formatUsd(s.daily.realized_pnl_usd)}`);
  console.log(`  Streak losses: ${s.daily.consecutive_losses}`);

  const positions = state.getOpenPositions();
  console.log(`\nOpen positions:  ${positions.length}`);
  for (const pos of positions) {
    const heldMs = Date.now() - new Date(pos.entry_ts).getTime();
    const heldH = (heldMs / 1000 / 3600).toFixed(1);
    console.log(`  ${pos.token.symbol.padEnd(6)} entry $${pos.entry_price_usd?.toFixed(6) || 'n/a'} peak +${pos.peak_pnl_pct.toFixed(2)}% scale-outs:${pos.scale_outs_done.length}/3 held ${heldH}h`);
  }

  const eq = state.getRecentExitQuality(5);
  if (eq !== null) {
    console.log(`\nExit quality (5-trade avg): ${(eq * 100).toFixed(0)}%`);
  }

  console.log('\n══════════════════════════════════════════════════\n');
}

function stateEmoji(state) {
  return { Normal: '🟢', Slow: '🟡', Halted: '🔴' }[state] || '⚪';
}

function formatUsd(v) {
  return v !== null && v !== undefined ? `$${v.toFixed(2)}` : 'n/a';
}

main().catch(err => {
  console.error('Status error:', err.message);
  process.exit(1);
});
