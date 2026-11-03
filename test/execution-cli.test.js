// execution.js against a fake `onchainos` CLI (DRY_RUN=true): argv, envelopes, parsing, retry rules.
// The fake is test/helpers/fake-onchainos.mjs; no network, no real CLI.
// Run: npm test

import { test, before } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { useFakeOnchainos } from './helpers/fake-onchainos.mjs';

let execution;
let CliConfirmingError;
let state;
let strategy;
let fake;
let holdersFile;

before(async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'okx-exec-cli-test-'));
  holdersFile = path.join(dir, 'holders_history.json');
  process.env.DRY_RUN = 'true';
  process.env.OKX_BOT_STATE_FILE = path.join(dir, 'state.json');
  process.env.OKX_BOT_HOLDERS_FILE = holdersFile;
  process.env.OKX_BOT_LOG_DIR = path.join(dir, 'logs');
  delete process.env.TELEGRAM_BOT_TOKEN;
  delete process.env.TELEGRAM_CHAT_ID;
  globalThis.fetch = () => { throw new Error('network is off in unit tests'); };
  fake = useFakeOnchainos(dir);
  const mod = await import('../execution.js');
  execution = mod.default;
  CliConfirmingError = mod.CliConfirmingError;
  state = (await import('../state.js')).default;
  strategy = (await import('../strategy.js')).default;
  (await import('../logger.js')).setLogLevel('error');
});

const quote = (over = {}) => ({
  ok: true,
  data: [{ toTokenAmount: '2500000', toToken: { decimal: '6', tokenUnitPrice: '0.4' }, priceImpactPercent: '0.1', ...over }],
});
const swap = { fromMint: 'usdc', toMint: 'jup', amount: '1000000', clientOrderId: 'c1' };
const joined = () => fake.calls().map(a => a.join(' '));
const H = 3600_000;

// ─── executeSwap (dry run) ─────────────────────────────────────────────────

test('dry-run executeSwap quotes once and returns a simulated fill without executing', async () => {
  fake.scenario({ 'swap quote': [{ stdout: quote() }] });
  const fill = await execution.executeSwap(swap);
  assert.deepEqual(fill, { tx_id: 'dry-c1', filled_amount: 2.5, to_token_unit_price_usd: 0.4, dry_run: true });
  assert.deepEqual(joined(), ['swap quote --chain solana --from usdc --to jup --amount 1000000']);
});

test('executeSwap rejects slippage above the max after only the quote call', async (t) => {
  t.mock.method(console, 'log', () => {});
  fake.scenario({ 'swap quote': [{ stdout: quote({ priceImpactPercent: '2.5' }) }] });
  await assert.rejects(execution.executeSwap(swap), /slippage_too_high:2.5/);
  assert.deepEqual(joined(), ['swap quote --chain solana --from usdc --to jup --amount 1000000']);
});

test('executeSwap accepts slippage exactly equal to the max', async () => {
  fake.scenario({ 'swap quote': [{ stdout: quote({ priceImpactPercent: '2' }) }] });
  const fill = await execution.executeSwap(swap);
  assert.equal(fill.dry_run, true);
});

// ─── getSwapQuote ──────────────────────────────────────────────────────────

test('getSwapQuote accepts data as a plain object and scales by toToken.decimal', async () => {
  fake.scenario({ 'swap quote': [{ stdout: { ok: true, data: quote().data[0] } }] });
  const q = await execution.getSwapQuote(swap);
  assert.equal(q.to_amount, 2.5);
  assert.equal(q.to_token_unit_price_usd, 0.4);
});

test('getSwapQuote gives a null unit price when tokenUnitPrice is missing', async () => {
  fake.scenario({ 'swap quote': [{ stdout: quote({ toToken: { decimal: '6' } }) }] });
  const q = await execution.getSwapQuote(swap);
  assert.equal(q.to_token_unit_price_usd, null);
});

// ─── CLI envelope handling (via fetchBalances) ─────────────────────────────

test('exit 0 with ok:false rejects with the backend msg', async (t) => {
  t.mock.method(console, 'log', () => {});
  fake.scenario({ 'wallet balance': [{ stdout: { ok: false, msg: 'x' } }] });
  await assert.rejects(execution.fetchBalances(), { message: 'x' });
});

test('exit 0 with confirming:true rejects with CliConfirmingError keeping next', async (t) => {
  t.mock.method(console, 'log', () => {});
  fake.scenario({ 'wallet balance': [{ stdout: { confirming: true, message: 'needs approval', next: 'run X' } }] });
  await assert.rejects(execution.fetchBalances(), (err) => {
    assert.ok(err instanceof CliConfirmingError);
    assert.equal(err.message, 'needs approval');
    assert.equal(err.next, 'run X');
    return true;
  });
});

test('exit 2 with confirming:true rejects with CliConfirmingError keeping next', async (t) => {
  t.mock.method(console, 'log', () => {});
  fake.scenario({ 'wallet balance': [{ exit: 2, stdout: { confirming: true, message: 'needs approval', next: 'run X' } }] });
  await assert.rejects(execution.fetchBalances(), (err) => {
    assert.ok(err instanceof CliConfirmingError);
    assert.equal(err.next, 'run X');
    return true;
  });
});

test('non-JSON stdout on exit 0 rejects', async (t) => {
  t.mock.method(console, 'log', () => {});
  fake.scenario({ 'wallet balance': [{ stdout: 'not json' }] });
  await assert.rejects(execution.fetchBalances());
});

test('a non-transient CLI failure is called once and not retried', async (t) => {
  t.mock.method(console, 'log', () => {});
  fake.scenario({ 'wallet balance': [{ exit: 1, stdout: { ok: false, code: 50011, msg: 'backend_reason' } }] });
  await assert.rejects(execution.fetchBalances());
  assert.equal(fake.calls().length, 1);
});

// ─── fetchBalances ─────────────────────────────────────────────────────────

test('fetchBalances flattens tokenAssets across details into numeric rows', async () => {
  fake.scenario({
    'wallet balance': [{
      stdout: {
        ok: true,
        data: {
          details: [
            { tokenAssets: [{ symbol: 'SOL', tokenAddress: '', balance: '0.5', usdValue: '75.5' }] },
            { tokenAssets: [{ symbol: 'USDC', tokenAddress: 'usdc', balance: '100', usdValue: '99.9' }] },
          ],
        },
      },
    }],
  });
  assert.deepEqual(await execution.fetchBalances(), [
    { symbol: 'SOL', mint: '', balance: 0.5, value_usd: 75.5 },
    { symbol: 'USDC', mint: 'usdc', balance: 100, value_usd: 99.9 },
  ]);
});

test('fetchBalances rejects instead of returning [] when the CLI fails', async (t) => {
  t.mock.method(console, 'log', () => {});
  fake.scenario({ 'wallet balance': [{ exit: 1, stdout: { ok: false, msg: 'down' } }] });
  await assert.rejects(execution.fetchBalances());
});

// ─── preflightCheck ────────────────────────────────────────────────────────

const solBalance = (balance) => ({
  'wallet balance': [{ stdout: { ok: true, data: { details: [{ tokenAssets: [{ symbol: 'SOL', balance, usdValue: '1' }] }] } } }],
});

test('preflightCheck fails with the balance in the reason when SOL is below 0.003', async () => {
  fake.scenario(solBalance('0.002'));
  assert.deepEqual(await execution.preflightCheck(), { ok: false, reason: 'insufficient_sol_gas:0.002' });
});

test('preflightCheck passes when SOL is exactly 0.003', async () => {
  fake.scenario(solBalance('0.003'));
  assert.equal((await execution.preflightCheck()).ok, true);
});

test('preflightCheck fails when the wallet holds no SOL asset', async () => {
  fake.scenario({ 'wallet balance': [{ stdout: { ok: true, data: { details: [] } } }] });
  assert.equal((await execution.preflightCheck()).ok, false);
});

// ─── fetchCandles ──────────────────────────────────────────────────────────

test('fetchCandles reverses newest-first rows to newest-last numbers and passes --limit', async () => {
  fake.scenario({
    'market kline': [{
      stdout: {
        ok: true,
        data: [
          { ts: '2000000', o: '2', h: '3', l: '1', c: '2.5', volUsd: '50', confirm: '1' },
          { ts: '1000000', o: '1', h: '2', l: '0.5', c: '1.5', volUsd: '40', confirm: '1' },
        ],
      },
    }],
  });
  const candles = await execution.fetchCandles('jup', 2);
  assert.deepEqual(candles.map(c => c.close), [1.5, 2.5]);
  assert.deepEqual(candles[0], {
    ts: new Date(1000000).toISOString(), open: 1, high: 2, low: 0.5, close: 1.5, volume_usd: 40, complete: true,
  });
  assert.ok(joined()[0].endsWith('--bar 1H --limit 2'));
});

test('fetchCandles maps confirm 1, 0 and absent to complete true, false and undefined', async () => {
  const row = (confirm) => ({ ts: '1', o: '1', h: '1', l: '1', c: '1', volUsd: '1', ...(confirm === undefined ? {} : { confirm }) });
  fake.scenario({ 'market kline': [{ stdout: { ok: true, data: [row('1'), row('0'), row(undefined)] } }] });
  const candles = await execution.fetchCandles('jup');
  assert.deepEqual(candles.map(c => c.complete), [undefined, false, true]);
});

test('fetchCandles returns [] when the CLI fails', async (t) => {
  t.mock.method(console, 'log', () => {});
  fake.scenario({ 'market kline': [{ exit: 1, stdout: { ok: false, msg: 'down' } }] });
  assert.deepEqual(await execution.fetchCandles('jup'), []);
});

// ─── fetchCatalysts ────────────────────────────────────────────────────────

test('fetchCatalysts sums smart-money signals from the last 6h and drops older ones', async () => {
  const now = Date.now();
  fs.writeFileSync(holdersFile, JSON.stringify({ jup: [{ ts: now - 60_000, holders: 1000 }] }));
  fake.scenario({
    'signal list': [{
      stdout: {
        ok: true,
        data: [
          { timestamp: String(now - H), triggerWalletCount: '3', amountUsd: '1000.5' },
          { timestamp: String(now - 5 * H), triggerWalletCount: '2', amountUsd: '200' },
          { timestamp: String(now - 7 * H), triggerWalletCount: '9', amountUsd: '9999' },
        ],
      },
    }],
  });
  const c = await execution.fetchCatalysts('jup');
  assert.equal(c.smart_money_buyers_6h, 5);
  assert.equal(c.smart_money_volume_6h_usd, 1200.5);
  assert.ok(!joined().some(a => a.startsWith('token price-info')));
});

// ─── regressions (fixed bugs) ───────────────────────────────────────────────

test('cli surfaces the backend msg when the CLI exits non-zero',
  async (t) => {
    t.mock.method(console, 'log', () => {});
    fake.scenario({ 'wallet balance': [{ exit: 1, stdout: { ok: false, msg: 'backend_reason' } }] });
    await assert.rejects(execution.fetchBalances(), { message: 'backend_reason' });
  });

test('a failed signal list call does not sell the position as catalyst_death',
  { todo: 'bug: a failed signal list call sells the position as catalyst_death' },
  async (t) => {
    t.mock.method(console, 'log', () => {});
    const now = Date.now();
    fs.writeFileSync(holdersFile, JSON.stringify({ jup: [{ ts: now - 60_000, holders: 1000 }] }));
    const kline = Array.from({ length: 6 }, (_, i) => ({
      ts: String(now - i * H), o: '1', h: '1', l: '1', c: '1', volUsd: '1000', confirm: '1',
    }));
    fake.scenario({
      'market kline': [{ stdout: { ok: true, data: kline } }],
      'signal list': [{ exit: 1, stdout: { ok: false, msg: 'rate_limited' } }],
      'swap quote': [{ stdout: quote({ toTokenAmount: '100000000', toToken: { decimal: '6', tokenUnitPrice: '1' } }) }],
      'wallet balance': [{ stdout: { ok: true, data: { details: [] } } }],
    });
    const pos = state.openPosition({
      token: { symbol: 'JUP', mint: 'jup', decimals: 6 },
      entry_ts: new Date().toISOString(),
      entry_price_usd: 1,
      entry_amount_token: 100,
      entry_value_usd: 100,
      setup_id: 'smart_money',
      kill_conditions: [{ type: 'catalyst_death', original_catalysts: ['smart_money'] }],
      scale_out_proceeds_usd: 0,
      scale_out_cost_usd: 0,
    });
    await strategy.manageOpenPositions({ baseToken: { mint: 'usdc', decimals: 6 } });
    assert.ok(state.getOpenPositions().some(p => p.id === pos.id), 'position must stay open');
    assert.ok(!joined().some(a => a.startsWith('swap ')), 'no swap call may be made');
  });
