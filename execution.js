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

const HOLDERS_FILE = path.join(process.cwd(), 'holders_history.json');

// ─── CLI shell-out ─────────────────────────────────────────────────────────

async function cli(args, { timeout = 30_000 } = {}) {
  try {
    const { stdout } = await execFileP(CLI, args, {
      timeout,
      maxBuffer: 10 * 1024 * 1024,
      windowsHide: true,
    });
    const parsed = JSON.parse(stdout);
    if (parsed.ok === false) {
      throw new Error(parsed.msg || `cli_not_ok:${parsed.code}`);
    }
    return parsed.data;
  } catch (err) {
    // CLI returns non-zero on errors but still prints JSON to stdout
    if (err.stdout) {
      try {
        const j = JSON.parse(err.stdout);
        const msg = j.msg || j.message || `cli_code_${j.code}`;
        logger.warn('cli_error_response', { cmd: args.slice(0, 2).join(' '), code: j.code, msg });
        throw new Error(msg);
      } catch (parseErr) {
        // fall through
      }
    }
    logger.error('cli_call_failed', { cmd: args.slice(0, 2).join(' '), error: err.message });
    throw err;
  }
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
    // CLI returns newest-first; reverse for newest-last
    return (rows || []).slice().reverse().map(r => ({
      ts: new Date(parseInt(r.ts, 10)).toISOString(),
      open: parseFloat(r.o),
      high: parseFloat(r.h),
      low: parseFloat(r.l),
      close: parseFloat(r.c),
      volume_usd: parseFloat(r.volUsd || 0),
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

async function fetchOnChainActivity(tokenMint) {
  // The CLI has no historical-holders endpoint, so we snapshot to
  // holders_history.json each tick and compare against a ~24h-old snapshot.
  const rows = await cli([
    'token', 'price-info',
    '--chain', CHAIN,
    '--address', tokenMint,
  ]);
  const current = parseInt(rows?.[0]?.holders || '0', 10);
  if (!current) return { holder_growth_24h_pct: 0 };

  const history = readHoldersHistory();
  const past = history[tokenMint];
  const now = Date.now();

  if (!past) {
    history[tokenMint] = { ts: now, holders: current, prev_ts: null, prev_holders: null };
    writeHoldersHistory(history);
    return { holder_growth_24h_pct: 0 };
  }

  const ageH = (now - past.ts) / 3600_000;
  let baseline = null;
  if (past.prev_holders && past.prev_ts && (now - past.prev_ts) >= 23 * 3600_000) {
    baseline = past.prev_holders;
  } else if (ageH >= 23) {
    baseline = past.holders;
  }

  // Roll forward at most once per hour to keep file small.
  if (ageH >= 1) {
    const promote = ageH >= 23;
    history[tokenMint] = {
      ts: now,
      holders: current,
      prev_ts: promote ? past.ts : past.prev_ts,
      prev_holders: promote ? past.holders : past.prev_holders,
    };
    writeHoldersHistory(history);
  }

  if (!baseline) return { holder_growth_24h_pct: 0 };
  const growth = ((current - baseline) / baseline) * 100;
  return { holder_growth_24h_pct: growth };
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

export async function fetchBalances() {
  try {
    const data = await cli(['wallet', 'balance', '--chain', CHAIN]);
    const assets = (data?.details || []).flatMap(d => d.tokenAssets || []);
    return assets.map(a => ({
      symbol: a.symbol,
      mint: a.tokenAddress || '',
      balance: parseFloat(a.balance || 0),
      value_usd: parseFloat(a.usdValue || 0),
    }));
  } catch (err) {
    logger.error('fetch_balances_failed', { error: err.message });
    return [];
  }
}

export async function getPortfolioValueUsd() {
  const balances = await fetchBalances();
  return balances.reduce((acc, b) => acc + b.value_usd, 0);
}

export async function getCashUsd() {
  const balances = await fetchBalances();
  const usdc = balances.find(b => b.symbol === 'USDC');
  return usdc?.value_usd || 0;
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
    ], { timeout: 90_000 });

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
  fetchBalances,
  getPortfolioValueUsd,
  getCashUsd,
  getSolGasBalance,
  getSwapQuote,
  executeSwap,
  preflightCheck,
};
