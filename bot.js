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

// previousDate: the UTC date we're summarising (the one that just ended).
// When omitted, falls back to the daily-stats date currently in state.
async function dailySummary(previousDate) {
  const s = state.loadState();
  const winRate = s.daily.trades > 0 ? (s.daily.wins / s.daily.trades) * 100 : 0;
  await alert(
    `📊 *Daily summary ${previousDate || s.daily.date}*\n` +
    `Trades: ${s.daily.trades} (${s.daily.wins}W / ${s.daily.losses}L, ${winRate.toFixed(0)}% WR)\n` +
    `Realized PnL: $${s.daily.realized_pnl_usd.toFixed(2)}\n` +
    `State: ${s.machine_state}`,
    { silent: true }
  );
}

// Trigger daily summary once per UTC day. The previous version only fired
// during the 00:00 UTC hour, which silently skipped the report whenever the
// bot was started later in the day. Now we persist last_summary_date in
// state and fire whenever the date has rolled over since the last send.
function checkDailySummary() {
  const s = state.loadState();
  const today = new Date().toISOString().slice(0, 10);
  // First run after startup: anchor to today without emitting a report for
  // an unknown prior day.
  if (!s.last_summary_date) {
    s.last_summary_date = today;
    state.saveState();
    return;
  }
  if (s.last_summary_date !== today) {
    const previous = s.last_summary_date;
    s.last_summary_date = today;
    state.saveState();
    dailySummary(previous).catch(err =>
      logger.error('daily_summary_failed', { previous, error: err.message })
    );
  }
}

// ─── Lifecycle ─────────────────────────────────────────────────────────────

async function shutdown(signal) {
  if (isShuttingDown) return;
  isShuttingDown = true;
  logger.info('shutdown_initiated', { signal });
  await alert(`⏹️ Bot shutting down: ${signal}\nOpen positions left intact for next start.`);
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
  alert(`🔥 *Unhandled rejection*\n\`${msg}\``).catch(() => {});
});

process.on('uncaughtException', (err) => {
  // Same idea, plus we don't trust the process state anymore — let systemd /
  // docker restart us cleanly.
  logger.error('uncaught_exception', { error: err.message, stack: err.stack });
  alert(`🔥 *Uncaught exception — restarting*\n\`${err.message}\``)
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
      process.exit(1);
    }
  }

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
