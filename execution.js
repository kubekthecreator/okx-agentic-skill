// execution.js — wraps the OKX OnchainOS CLI (`onchainos` v3+).
//
// The CLI handles auth (API key or email), TEE signing, and rate limits.
// We shell out, parse JSON envelopes ({ ok, data, notifications, msg }),
// and translate them into the shapes signals.js / strategy.js expect.
//
// In DRY_RUN mode (default), executeSwap returns a simulated fill from
// the live quote — state updates happen normally, no broadcast.

import { execFile } from 'child_process';
import { promisify } from 'util';
import fs from 'fs';
import path from 'path';
import { logger } from './logger.js';

const execFileP = promisify(execFile);

const CLI = process.env.ONCHAINOS_CLI || 'onchainos';
const CHAIN = process.env.OKX_CHAIN || 'solana';
const DRY_RUN = process.env.DRY_RUN !== 'false';

const HOLDERS_FILE = process.env.OKX_BOT_HOLDERS_FILE || path.join(process.cwd(), 'holders_history.json');

// ─── CLI shell-out ─────────────────────────────────────────────────────────

// Custom error class so callers can distinguish a confirming-required
// response (the CLI demanding human approval) from a hard CLI error.
export class CliConfirmingError extends Error {
  constructor(message, next) {
    super(message);
    this.name = 'CliConfirmingError';
    this.confirming = true;
    this.next = next;
  }
}

// Transient error codes worth retrying once. Stable backend errors (4xx-ish,
// confirming, signal-rejected) are NOT retried — retrying a deterministic
// "no" doesn't help and just doubles the latency.
const TRANSIENT_NODE_CODES = new Set(['ETIMEDOUT', 'ECONNRESET', 'EAI_AGAIN', 'ECONNREFUSED']);

function isTransient(err) {
  if (err instanceof CliConfirmingError) return false;
  if (err.code && TRANSIENT_NODE_CODES.has(err.code)) return true;
  // execFile timeout: err.killed=true, signal SIGTERM, code null
  if (err.killed && err.signal === 'SIGTERM') return true;
  return false;
}

async function cli(args, { timeout = 30_000, attempts = 2 } = {}) {
  let lastErr;
  for (let attempt = 1; attempt <= attempts; attempt++) {
    try {
      const { stdout } = await execFileP(CLI, args, {
        timeout,
        maxBuffer: 10 * 1024 * 1024,
        windowsHide: true,
      });
      const parsed = JSON.parse(stdout);
      // Exit code 0 + confirming flag = CLI wants human approval. Never auto-force.
      if (parsed.confirming) {
        throw new CliConfirmingError(parsed.message || 'confirming_required', parsed.next);
      }
      if (parsed.ok === false) {
        throw new Error(parsed.msg || `cli_not_ok:${parsed.code}`);
      }
      return parsed.data;
    } catch (err) {
      if (err instanceof CliConfirmingError) throw err;
      // CLI returns non-zero on errors but still prints JSON to stdout
      if (err.stdout) {
        try {
          const j = JSON.parse(err.stdout);
          // Exit code 2 + confirming:true is the documented CLI confirming path.
          if (j.confirming) {
            throw new CliConfirmingError(j.message || 'confirming_required', j.next);
          }
          const msg = j.msg || j.message || `cli_code_${j.code}`;
          logger.warn('cli_error_response', { cmd: args.slice(0, 2).join(' '), code: j.code, msg, attempt });
          throw new Error(msg);
        } catch (parseErr) {
          if (parseErr instanceof CliConfirmingError) throw parseErr;
          // fall through to retry logic
        }
      }
      lastErr = err;
      if (isTransient(err) && attempt < attempts) {
        logger.warn('cli_transient_retry', {
          cmd: args.slice(0, 2).join(' '), code: err.code, attempt,
        });
        await new Promise(r => setTimeout(r, 500 * attempt));
        continue;
      }
      logger.error('cli_call_failed', {
        cmd: args.slice(0, 2).join(' '), error: err.message, attempt,
      });
      throw err;
    }
  }
  throw lastErr;
}

// ─── Market data ───────────────────────────────────────────────────────────

// Hourly candles. Returns newest-last (matches signals.js convention).
export async function fetchCandles(tokenMint, n = 48) {
  try {
    const rows = await cli([
      'market', 'kline',
      '--chain', CHAIN,
      '--address', tokenMint,
      '--bar', '1H',
      '--limit', String(n),
    ]);
    // CLI returns newest-first; reverse for newest-last.
    // `confirm` ("1" = bar closed, "0" = in progress) is passed through as
    // `complete`; signals.completedCandles() uses it to keep volume maths
    // off the in-progress bar. Left undefined when the source omits it.
    return (rows || []).slice().reverse().map(r => ({
      ts: new Date(parseInt(r.ts, 10)).toISOString(),
      open: parseFloat(r.o),
      high: parseFloat(r.h),
      low: parseFloat(r.l),
      close: parseFloat(r.c),
      volume_usd: parseFloat(r.volUsd || 0),
      complete: r.confirm === undefined || r.confirm === null ? undefined : String(r.confirm) === '1',
    }));
  } catch (err) {
    logger.warn('candles_fallback', { token: tokenMint, error: err.message });
    return [];
  }
}

// ─── Catalysts (smart money + on-chain) ────────────────────────────────────

export async function fetchCatalysts(tokenMint) {
  const [smartMoney, onChain] = await Promise.all([
    fetchSmartMoneyActivity(tokenMint).catch(() => null),
    fetchOnChainActivity(tokenMint).catch(() => null),
  ]);

  return {
    smart_money_buyers_6h: smartMoney?.buyers_6h ?? 0,
    smart_money_volume_6h_usd: smartMoney?.volume_6h_usd ?? 0,
    holder_growth_24h_pct: onChain?.holder_growth_24h_pct ?? 0,
    news_mentions_24h: 0,  // v0.1: stub
  };
}

async function fetchSmartMoneyActivity(tokenMint) {
  // Aggregated smart-money buy signals for this token. Each item has
  // timestamp (ms), triggerWalletCount, amountUsd. Filter to last 6h.
  const items = await cli([
    'signal', 'list',
    '--chain', CHAIN,
    '--token-address', tokenMint,
    '--wallet-type', '1',          // 1 = Smart Money
    '--limit', '100',
  ]);
  const cutoff = Date.now() - 6 * 3600_000;
  const recent = (items || []).filter(s => parseInt(s.timestamp, 10) >= cutoff);

  return {
    buyers_6h: recent.reduce((acc, s) => acc + parseInt(s.triggerWalletCount || '0', 10), 0),
    volume_6h_usd: recent.reduce((acc, s) => acc + parseFloat(s.amountUsd || 0), 0),
  };
}

// ─── Holder growth (on-chain spike catalyst) ───────────────────────────────
//
// The CLI has no historical-holders endpoint, so the bot keeps its own series
// of hourly holder-count snapshots per token in holders_history.json:
//   { [mint]: [{ ts, holders }, ...] }   oldest-first, ~26h retained
// bot.js refreshes the snapshots on an hourly loop (refreshHolderSnapshots);
// fetchOnChainActivity only READS the series, so evaluating a catalyst costs
// no CLI call. v0.1 kept a two-point {ts, holders, prev_ts, prev_holders}
// record that rolled forward hourly and therefore never aged past ~1h — the
// 24h baseline was never established and the catalyst could never fire.

const HOLDER_SNAPSHOT_MIN_GAP_MS = 55 * 60 * 1000;   // one snapshot per hour per token
const HOLDER_HISTORY_KEEP_MS = 26 * 3600_000;
const HOLDER_BASELINE_MIN_AGE_MS = 20 * 3600_000;    // tolerate restarts / missed hours
const HOLDER_SELF_HEAL_AGE_MS = 2 * 3600_000;

// Accepts both the current array shape and the legacy v0.1 record.
export function normalizeHolderSeries(entry) {
  if (Array.isArray(entry)) return entry.filter(p => p && p.ts && p.holders);
  if (entry && typeof entry === 'object') {
    const out = [];
    if (entry.prev_ts && entry.prev_holders) out.push({ ts: entry.prev_ts, holders: entry.prev_holders });
    if (entry.ts && entry.holders) out.push({ ts: entry.ts, holders: entry.holders });
    return out;
  }
  return [];
}

// Pure. Growth (%) from the snapshot closest to 24h ago (≥20h old) to the
// newest one. null until a baseline exists.
export function holderGrowthPct(series, now = Date.now()) {
  if (!Array.isArray(series) || series.length < 2) return null;
  const newest = series[series.length - 1];
  const eligible = series.filter(p => now - p.ts >= HOLDER_BASELINE_MIN_AGE_MS);
  if (eligible.length === 0) return null;
  const target = now - 24 * 3600_000;
  const baseline = eligible.reduce((best, p) =>
    Math.abs(p.ts - target) < Math.abs(best.ts - target) ? p : best
  );
  if (!baseline.holders || baseline === newest) return null;
  return ((newest.holders - baseline.holders) / baseline.holders) * 100;
}

// Take a fresh holder-count snapshot for each mint that doesn't have one from
// the last ~hour. Called hourly from bot.js; `force` bypasses the gap check.
export async function refreshHolderSnapshots(mints, { force = false } = {}) {
  const history = readHoldersHistory();
  const now = Date.now();
  let changed = false;

  for (const mint of mints) {
    const series = normalizeHolderSeries(history[mint]);
    const newest = series[series.length - 1];
    if (!force && newest && now - newest.ts < HOLDER_SNAPSHOT_MIN_GAP_MS) continue;
    try {
      const rows = await cli(['token', 'price-info', '--chain', CHAIN, '--address', mint]);
      const holders = parseInt(rows?.[0]?.holders || '0', 10);
      if (!holders) continue;
      series.push({ ts: now, holders });
      history[mint] = series.filter(p => now - p.ts <= HOLDER_HISTORY_KEEP_MS);
      changed = true;
    } catch (err) {
      logger.warn('holder_snapshot_failed', { token: mint, error: err.message });
    }
  }

  if (changed) writeHoldersHistory(history);
  return changed;
}

async function fetchOnChainActivity(tokenMint) {
  let series = normalizeHolderSeries(readHoldersHistory()[tokenMint]);
  const newest = series[series.length - 1];

  // Self-heal: if the hourly loop hasn't covered this token recently (first
  // run, loop failure), snapshot now so the series keeps building.
  if (!newest || Date.now() - newest.ts > HOLDER_SELF_HEAL_AGE_MS) {
    await refreshHolderSnapshots([tokenMint], { force: true });
    series = normalizeHolderSeries(readHoldersHistory()[tokenMint]);
  }

  const growth = holderGrowthPct(series);
  return { holder_growth_24h_pct: growth ?? 0 };
}

function readHoldersHistory() {
  try { return JSON.parse(fs.readFileSync(HOLDERS_FILE, 'utf-8')); }
  catch { return {}; }
}
function writeHoldersHistory(h) {
  try { fs.writeFileSync(HOLDERS_FILE, JSON.stringify(h, null, 2)); }
  catch (e) { logger.warn('holders_history_write_failed', { error: e.message }); }
}

// ─── Balance ───────────────────────────────────────────────────────────────

// fetchBalances throws on CLI error. Callers MUST handle, because silently
// returning [] (= portfolio_usd 0) makes every daily-PnL guard in risk.js
// divide by zero and quietly disable itself — the bot would keep trading
// with no governance. The tick try/catch in bot.js handles transient
// failures; startup-time callers should hard-fail.
export async function fetchBalances() {
  const data = await cli(['wallet', 'balance', '--chain', CHAIN]);
  const assets = (data?.details || []).flatMap(d => d.tokenAssets || []);
  return assets.map(a => ({
    symbol: a.symbol,
    mint: a.tokenAddress || '',
    balance: parseFloat(a.balance || 0),
    value_usd: parseFloat(a.usdValue || 0),
  }));
}

// Pure helpers so a caller holding one balance snapshot (the main tick) can
// derive every figure it needs without a second `wallet balance` call.
export function portfolioValueFromBalances(balances) {
  return balances.reduce((acc, b) => acc + b.value_usd, 0);
}

export function cashFromBalances(balances) {
  const usdc = balances.find(b => b.symbol === 'USDC');
  return usdc?.value_usd || 0;
}

export async function getPortfolioValueUsd() {
  return portfolioValueFromBalances(await fetchBalances());
}

export async function getCashUsd() {
  return cashFromBalances(await fetchBalances());
}

export async function getSolGasBalance() {
  const balances = await fetchBalances();
  const sol = balances.find(b => b.symbol === 'SOL');
  return sol?.balance || 0;
}

// ─── Swap ──────────────────────────────────────────────────────────────────

export async function getSwapQuote({ fromMint, toMint, amount }) {
  const data = await cli([
    'swap', 'quote',
    '--chain', CHAIN,
    '--from', fromMint,
    '--to', toMint,
    '--amount', String(amount),
  ]);
  const q = Array.isArray(data) ? data[0] : data;
  const toDecimals = parseInt(q?.toToken?.decimal || '0', 10);
  const toAmountRaw = parseFloat(q?.toTokenAmount || 0);
  const to_amount = toDecimals > 0 ? toAmountRaw / Math.pow(10, toDecimals) : toAmountRaw;
  const unit_price = parseFloat(q?.toToken?.tokenUnitPrice || 0) || null;

  return {
    to_amount,
    price_impact_pct: parseFloat(q?.priceImpactPercent || 0),
    estimated_slippage_pct: parseFloat(q?.priceImpactPercent || 0),
    quote_id: q?.contextSlot,
    to_token_unit_price_usd: unit_price,  // entry price for the to-token
  };
}

export async function executeSwap({ fromMint, toMint, amount, clientOrderId, maxSlippagePct = 2 }) {
  const quote = await getSwapQuote({ fromMint, toMint, amount });

  if (quote.estimated_slippage_pct > maxSlippagePct) {
    logger.warn('swap_rejected_slippage', {
      estimated: quote.estimated_slippage_pct,
      max: maxSlippagePct,
    });
    throw new Error(`slippage_too_high:${quote.estimated_slippage_pct}`);
  }

  if (DRY_RUN) {
    logger.info('dry_run_swap', { fromMint, toMint, amount, expected_out: quote.to_amount });
    return {
      tx_id: `dry-${clientOrderId}`,
      filled_amount: quote.to_amount,
      to_token_unit_price_usd: quote.to_token_unit_price_usd,
      dry_run: true,
    };
  }

  // Live execution: one-shot quote→sign→broadcast via the CLI.
  // The CLI binds to the currently logged-in wallet (`wallet status`).
  //
  // attempts: 1 — a swap is NOT idempotent. If the CLI times out the
  // transaction may already be broadcast; the generic transient retry would
  // then submit it a second time (double buy / double sell). A timed-out
  // swap surfaces as an error and the caller reconciles on the next tick.
  const wallet = await getActiveWalletAddress();
  try {
    const data = await cli([
      'swap', 'execute',
      '--chain', CHAIN,
      '--from', fromMint,
      '--to', toMint,
      '--amount', String(amount),
      '--wallet', wallet,
      '--slippage', '0.5',
    ], { timeout: 90_000, attempts: 1 });

    const txHash = data?.txHash || data?.orderId || data?.txId;
    const toDecimals = parseInt(data?.toToken?.decimal || '0', 10);
    const filledRaw = parseFloat(data?.toTokenAmount || 0);
    const filled = toDecimals > 0 ? filledRaw / Math.pow(10, toDecimals) : quote.to_amount;

    return {
      tx_id: txHash || clientOrderId,
      filled_amount: filled,
      to_token_unit_price_usd: parseFloat(data?.toToken?.tokenUnitPrice || 0) || quote.to_token_unit_price_usd,
      dry_run: false,
    };
  } catch (err) {
    // Confirming response = CLI wants a human in the loop. Never auto-force;
    // bubble up with a distinct tag so the caller can surface to Telegram and
    // mark the position as pending manual review.
    if (err instanceof CliConfirmingError) {
      logger.warn('swap_confirming_required', {
        clientOrderId, message: err.message, next: err.next,
      });
      throw err;
    }
    logger.error('swap_execution_failed', { error: err.message, clientOrderId });
    throw err;
  }
}

async function getActiveWalletAddress() {
  // Cache the SOL address from `wallet addresses --chain solana`.
  if (getActiveWalletAddress._cached) return getActiveWalletAddress._cached;
  const data = await cli(['wallet', 'addresses', '--chain', CHAIN]);
  // data shape: { addresses: [{ chainIndex, address, ... }, ...] } — pick first
  const addr = Array.isArray(data?.addresses) ? data.addresses[0]?.address : data?.address;
  if (!addr) throw new Error('no_active_wallet_address');
  getActiveWalletAddress._cached = addr;
  return addr;
}

// ─── Pre-flight checks ─────────────────────────────────────────────────────

export async function preflightCheck() {
  const sol = await getSolGasBalance();
  const minSol = 0.003;
  if (sol < minSol) {
    return { ok: false, reason: `insufficient_sol_gas:${sol}` };
  }
  return { ok: true, sol };
}

export default {
  fetchCandles,
  fetchCatalysts,
  refreshHolderSnapshots,
  holderGrowthPct,
  normalizeHolderSeries,
  fetchBalances,
  portfolioValueFromBalances,
  cashFromBalances,
  getPortfolioValueUsd,
  getCashUsd,
  getSolGasBalance,
  getSwapQuote,
  executeSwap,
  preflightCheck,
};
