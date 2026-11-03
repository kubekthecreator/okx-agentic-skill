// execution.js live branch (DRY_RUN=false) against the fake `onchainos` CLI. Money path: nothing may reach the real CLI.
// The guard in before() throws unless ONCHAINOS_CLI is node and the fake preload is in NODE_OPTIONS.
// Tests run in declaration order: getActiveWalletAddress caches the address module-wide after its first success.
// Run: npm test

import { test, before } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { useFakeOnchainos } from './helpers/fake-onchainos.mjs';

let execution;
let CliConfirmingError;
let fake;

before(async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'okx-exec-live-test-'));
  process.env.OKX_BOT_STATE_FILE = path.join(dir, 'state.json');
  process.env.OKX_BOT_HOLDERS_FILE = path.join(dir, 'holders_history.json');
  process.env.OKX_BOT_LOG_DIR = path.join(dir, 'logs');
  delete process.env.TELEGRAM_BOT_TOKEN;
  delete process.env.TELEGRAM_CHAT_ID;
  globalThis.fetch = () => { throw new Error('network is off in unit tests'); };
  fake = useFakeOnchainos(dir);
  process.env.DRY_RUN = 'false';
  const preload = pathToFileURL(fileURLToPath(new URL('./helpers/fake-onchainos.mjs', import.meta.url))).href;
  if (process.env.ONCHAINOS_CLI !== process.execPath || !process.env.NODE_OPTIONS?.includes(preload)) {
    throw new Error('fake onchainos is not installed; refusing to run the live branch');
  }
  const mod = await import('../execution.js');
  execution = mod.default;
  CliConfirmingError = mod.CliConfirmingError;
  (await import('../logger.js')).setLogLevel('error');
});

const quote = (over = {}) => ({
  ok: true,
  data: [{ toTokenAmount: '2500000', toToken: { decimal: '6', tokenUnitPrice: '0.4' }, priceImpactPercent: '0.1', ...over }],
});
const swap = { fromMint: 'usdc', toMint: 'jup', amount: '1000000', clientOrderId: 'c1' };
const joined = () => fake.calls().map(a => a.join(' '));
const count = (prefix) => joined().filter(a => a.startsWith(prefix)).length;
const wallet = { 'wallet addresses': [{ stdout: { ok: true, data: { addresses: [{ address: 'WALLET1' }] } } }] };

test('live executeSwap rejects no_active_wallet_address and never calls swap execute', async (t) => {
  t.mock.method(console, 'log', () => {});
  fake.scenario({ 'swap quote': [{ stdout: quote() }], 'wallet addresses': [{ stdout: { ok: true, data: { addresses: [] } } }] });
  await assert.rejects(execution.executeSwap(swap), /no_active_wallet_address/);
  assert.equal(count('swap execute'), 0);
});

test('live executeSwap quotes, resolves the wallet, then executes and returns the real fill', async () => {
  fake.scenario({
    'swap quote': [{ stdout: quote() }],
    ...wallet,
    'swap execute': [{ stdout: { ok: true, data: { txHash: 'TX1', toTokenAmount: '2500000', toToken: { decimal: '6', tokenUnitPrice: '0.41' } } } }],
  });
  const fill = await execution.executeSwap(swap);
  assert.deepEqual(fill, { tx_id: 'TX1', filled_amount: 2.5, to_token_unit_price_usd: 0.41, dry_run: false });
  assert.deepEqual(joined(), [
    'swap quote --chain solana --from usdc --to jup --amount 1000000',
    'wallet addresses --chain solana',
    'swap execute --chain solana --from usdc --to jup --amount 1000000 --wallet WALLET1 --slippage 0.5',
  ]);
});

test('live executeSwap reuses the cached wallet address on the next swap', async () => {
  fake.scenario({
    'swap quote': [{ stdout: quote() }],
    ...wallet,
    'swap execute': [{ stdout: { ok: true, data: { txHash: 'TX1' } } }],
  });
  await execution.executeSwap(swap);
  await execution.executeSwap(swap);
  assert.equal(count('wallet addresses'), 0);
  assert.equal(count('swap execute'), 2);
});

// `attempts: 1` on swap execute guards against a TRANSIENT failure (execFile timeout: killed + SIGTERM)
// being retried into a double buy. The swap timeout is a hard-coded 90 s, so that case can't be produced
// offline; this only pins that a non-transient execute failure surfaces after exactly one call.
test('live executeSwap surfaces a failed swap execute after a single call', async (t) => {
  t.mock.method(console, 'log', () => {});
  fake.scenario({
    'swap quote': [{ stdout: quote() }],
    ...wallet,
    'swap execute': [{ exit: 1, stdout: { ok: false, msg: 'broadcast_failed' } }],
  });
  // The backend msg; only the execute step's scenario produces it.
  await assert.rejects(execution.executeSwap(swap), /broadcast_failed/);
  assert.equal(count('swap execute'), 1);
});

test('live executeSwap rethrows CliConfirmingError with next after a single execute call', async (t) => {
  t.mock.method(console, 'log', () => {});
  fake.scenario({
    'swap quote': [{ stdout: quote() }],
    'swap execute': [{ exit: 2, stdout: { confirming: true, message: 'needs approval', next: 'run X' } }],
  });
  await assert.rejects(execution.executeSwap(swap), (err) => {
    assert.ok(err instanceof CliConfirmingError);
    assert.equal(err.next, 'run X');
    return true;
  });
  assert.equal(count('swap execute'), 1);
});

test('live executeSwap rejects excess slippage before any wallet or execute call', async (t) => {
  t.mock.method(console, 'log', () => {});
  fake.scenario({ 'swap quote': [{ stdout: quote({ priceImpactPercent: '2.5' }) }], ...wallet });
  await assert.rejects(execution.executeSwap(swap), /slippage_too_high:2.5/);
  assert.deepEqual(joined(), ['swap quote --chain solana --from usdc --to jup --amount 1000000']);
});

test('live executeSwap falls back to the quote amount, clientOrderId and quote price when execute omits them', async () => {
  fake.scenario({ 'swap quote': [{ stdout: quote() }], 'swap execute': [{ stdout: { ok: true, data: {} } }] });
  const fill = await execution.executeSwap(swap);
  assert.deepEqual(fill, { tx_id: 'c1', filled_amount: 2.5, to_token_unit_price_usd: 0.4, dry_run: false });
});
