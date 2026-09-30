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

// Read at startup like the preflight steps below: a broken whitelist must
// alert too, or Docker's restart loop is silent.
let TOKENS;
try {
  TOKENS = JSON.parse(fs.readFileSync(path.join(process.cwd(), 'tokens.json'), 'utf-8'));
} catch (err) {
  console.error(`\n❌ Could not read tokens.json: ${err.message}\n`);
  await notify.cannotStart('tokens_unreadable', `can't read tokens.json (${err.message})`,
    'fix tokens.json (valid JSON with a "tokens" list) and redeploy');
  process.exit(1);
}

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
      're-login the CLI for the bot (deploy/README.md, "Checking that the CLI is still authenticated")');
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
  let ok = false;
  let error = null;

  try {
    // One `wallet balance` call per tick; derive both figures from it.
    const balances = await execution.fetchBalances();
    const portfolio_usd = execution.portfolioValueFromBalances(balances);
    const cash_usd = execution.cashFromBalances(balances);

    // Rotate daily stats if needed. The ended day is reported from its own
    // numbers — v0.2 read state.daily from a separate timer and, about half
    // the time, after this rotation had already reset it.
    const endedDay = state.rotateDaily(portfolio_usd);
    if (endedDay) {
      // A report must never break the tick (the rotation is already saved).
      try {
        sendPeriodicReports(endedDay, portfolio_usd);
      } catch (err) {
        logger.error('periodic_reports_failed', { error: err.message, stack: err.stack });
      }
    }

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
    ok = true;
  } catch (err) {
    logger.error('tick_failed', { tick: tickCount, error: err.message, stack: err.stack });
    error = err.message;
  }
  // Outside the try: exactly one health report per tick, whatever happened.
  await notify.tickResult(ok, error);
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
    notify.weeklyHeartbeat({
      portfolio_usd,
      week: state.getWeekSummary(now),
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
  try {
    await tick();
  } finally {
    // tick() handles its own errors; this keeps the loop alive even if the
    // health report itself ever throws (the rejection still surfaces).
    if (!isShuttingDown) setTimeout(tickRunner, TICK_INTERVAL_MS);
  }
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
  // Save first: Docker's stop grace is 10 s and the alert below may wait on
  // Telegram. Later signals are ignored, so nothing here may skip the exit.
  try {
    state.saveState();
    await Promise.race([
      notify.stopped({ signal, open_positions: state.getOpenPositions().length }),
      new Promise(resolve => setTimeout(resolve, 3_000)),
    ]);
  } finally {
    // Flush the log stream so the last few lines (including this shutdown
    // sequence) hit disk before exit. Without this they can be lost on a
    // fast SIGTERM.
    try { logger.flush && logger.flush(); } catch (_) { /* best effort */ }
    process.exit(0);
  }
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
