// bot.js — main entry point.
//
// Spawns the main tick loop + background monitoring loops. Handles graceful
// shutdown so state is always flushed.

import 'dotenv/config';
import fs from 'fs';
import path from 'path';
import { execFile } from 'child_process';
import { promisify } from 'util';
import { logger, alert, setLogLevel } from './logger.js';
import state from './state.js';
import risk from './risk.js';
import strategy from './strategy.js';
import execution from './execution.js';

const execFileP = promisify(execFile);

const TICK_INTERVAL_MS = parseInt(process.env.TICK_INTERVAL_MS || '60000', 10);
const KILL_CHECK_INTERVAL_MS = 5 * 60 * 1000;
const CATALYST_REFRESH_INTERVAL_MS = 30 * 60 * 1000;

const TOKENS = JSON.parse(
  fs.readFileSync(path.join(process.cwd(), 'tokens.json'), 'utf-8')
);

setLogLevel(process.env.LOG_LEVEL || 'info');

// ─── Pre-flight ────────────────────────────────────────────────────────────

async function preflightConfig() {
  const cli = process.env.ONCHAINOS_CLI || 'onchainos';
  try {
    const { stdout } = await execFileP(cli, ['wallet', 'status'], { timeout: 10_000, windowsHide: true });
    const parsed = JSON.parse(stdout);
    if (!parsed?.data?.loggedIn) {
      console.error(`\n❌ onchainos CLI is not logged in.\nRun: \`onchainos wallet login <email>\` (or set up API Key login per dev-portal docs).\n`);
      process.exit(1);
    }
    logger.info('cli_auth_ok', {
      loginType: parsed.data.loginType,
      account: parsed.data.currentAccountName,
    });
  } catch (err) {
    logger.error('preflight_cli_failed', { error: err.message });
    console.error(`\n❌ Could not run \`${cli} wallet status\`. Is the onchainos CLI installed and on PATH?\n${err.message}\n`);
    process.exit(1);
  }
}

function printBanner() {
  const dryRun = process.env.DRY_RUN !== 'false';
  console.log(`
╔════════════════════════════════════════════════════════════════╗
║         OKX Agentic Wallet — Trend-Follower Skill v0.1         ║
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
    const portfolio_usd = await execution.getPortfolioValueUsd();
    const cash_usd = await execution.getCashUsd();

    // Rotate daily stats if needed
    state.rotateDaily(portfolio_usd);

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
    await strategy.evaluateNewEntries({
      tokens: TOKENS.tokens,
      baseToken: TOKENS.base_token,
      referenceMint: TOKENS.reference_token.mint,
      portfolio_usd,
      cash_usd,
    });
  } catch (err) {
    logger.error('tick_failed', { tick: tickCount, error: err.message, stack: err.stack });
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

async function tickRunner() {
  if (isShuttingDown) return;
  await tick();
  if (!isShuttingDown) setTimeout(tickRunner, TICK_INTERVAL_MS);
}

async function killCheckRunner() {
  if (isShuttingDown) return;
  await killCheckLoop();
  if (!isShuttingDown) setTimeout(killCheckRunner, KILL_CHECK_INTERVAL_MS);
}

async function dailySummary() {
  const s = state.loadState();
  const winRate = s.daily.trades > 0 ? (s.daily.wins / s.daily.trades) * 100 : 0;
  await alert(
    `📊 *Daily summary ${s.daily.date}*\n` +
    `Trades: ${s.daily.trades} (${s.daily.wins}W / ${s.daily.losses}L, ${winRate.toFixed(0)}% WR)\n` +
    `Realized PnL: $${s.daily.realized_pnl_usd.toFixed(2)}\n` +
    `State: ${s.machine_state}`,
    { silent: true }
  );
}

// Trigger daily summary at UTC midnight (within tick tolerance)
let lastSummaryDate = null;
function checkDailySummary() {
  const now = new Date();
  const today = now.toISOString().slice(0, 10);
  if (now.getUTCHours() === 0 && lastSummaryDate !== today) {
    lastSummaryDate = today;
    dailySummary().catch(err => logger.error('daily_summary_failed', { error: err.message }));
  }
}

// ─── Lifecycle ─────────────────────────────────────────────────────────────

async function shutdown(signal) {
  if (isShuttingDown) return;
  isShuttingDown = true;
  logger.info('shutdown_initiated', { signal });
  await alert(`⏹️ Bot shutting down: ${signal}\nOpen positions left intact for next start.`);
  state.saveState();
  process.exit(0);
}

process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('unhandledRejection', (err) => {
  logger.error('unhandled_rejection', { error: err.message, stack: err.stack });
});

async function main() {
  await preflightConfig();
  printBanner();
  state.loadState();

  // Initialize starting portfolio for daily PnL accounting
  const startingPortfolio = await execution.getPortfolioValueUsd();
  const s = state.loadState();
  if (s.daily.starting_portfolio_usd === 0) {
    s.daily.starting_portfolio_usd = startingPortfolio;
    state.saveState();
  }

  await alert(`🚀 Bot started\nMode: ${process.env.DRY_RUN === 'false' ? 'LIVE' : 'DRY RUN'}\nPortfolio: $${startingPortfolio.toFixed(2)}`);

  // Self-rescheduling loops — no setInterval, no overlap.
  tickRunner();
  setTimeout(killCheckRunner, KILL_CHECK_INTERVAL_MS);
  setInterval(checkDailySummary, 60_000);  // pure clock check, no IO; safe
}

main().catch(err => {
  logger.error('main_failed', { error: err.message, stack: err.stack });
  process.exit(1);
});
