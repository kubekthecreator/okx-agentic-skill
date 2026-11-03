// Money-path tests for strategy.js: entry sizing/side, scale-outs, stops and
// double-execution guards. risk.js and state.js are REAL; every collaborator
// that would touch the network, the CLI or Telegram is stubbed.
// Run: npm test

import { test, before, beforeEach, describe } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs';
import os from 'os';
import path from 'path';

let strategy, execution, signals, notify, risk, state, CliConfirmingError;

before(async () => {
  // Unit tests must never reach Telegram, whatever the developer's shell exports.
  delete process.env.TELEGRAM_BOT_TOKEN;
  delete process.env.TELEGRAM_CHAT_ID;
  globalThis.fetch = () => { throw new Error('network is off in unit tests'); };
  process.env.DRY_RUN = 'true';
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'okx-strategy-trading-test-'));
  process.env.OKX_BOT_STATE_FILE = path.join(dir, 'state.json');
  process.env.OKX_BOT_HOLDERS_FILE = path.join(dir, 'holders_history.json');
  process.env.OKX_BOT_LOG_DIR = path.join(dir, 'logs');
  // Safety net: every execution call is mocked per test. If one is ever missed, the spawn fails with
  // ENOENT instead of reaching a real, logged-in `onchainos` from the developer's shell.
  process.env.ONCHAINOS_CLI = path.join(dir, 'no-real-onchainos');
  const { setLogLevel } = await import('../logger.js');
  setLogLevel('error');
  strategy = (await import('../strategy.js')).default;
  ({ default: execution, CliConfirmingError } = await import('../execution.js'));
  signals = (await import('../signals.js')).default;
  notify = (await import('../notify.js')).default;
  risk = (await import('../risk.js')).default;
  state = (await import('../state.js')).default;
});

// state.getOpenPositions() hands out live cache objects, so reset the cache in place.
beforeEach(() => {
  const s = state.loadState();
  s.positions = {};
  s.history = [];
  s.machine_state = 'Normal';
  s.halt_until = null;
  s.post_win_cooldown_until = null;
  s.daily = {
    date: new Date().toISOString().slice(0, 10),
    starting_portfolio_usd: 100,
    trades: 0,
    wins: 0,
    losses: 0,
    consecutive_losses: 0,
    realized_pnl_usd: 0,
  };
  s.setup_stats = {};
  delete process.env.MAX_PORTFOLIO_USD;
  delete process.env.MIN_TRADE_SIZE_USD;
  strategy.takeFunnel();
});

// ─── Builders ──────────────────────────────────────────────────────────────

const baseToken = { mint: 'usdc', decimals: 6 };
const JUP = { symbol: 'JUP', mint: 'jup', decimals: 6, max_position_usd: 50 };
const WIF = { symbol: 'WIF', mint: 'wif', decimals: 6, max_position_usd: 50 };
const PASS = {
  passed: true,
  setup_id: 'smart_money',
  booster_active: false,
  breakdown: { catalyst: { catalysts_active: [{ type: 'smart_money' }] } },
};
const ENTRY_FILL = { tx_id: 'tx-entry', filled_amount: 24.5, to_token_unit_price_usd: 1.02 };
const ZERO_CATALYSTS = { smart_money_buyers_6h: 0, smart_money_volume_6h_usd: 0, news_mentions_24h: 0, holder_growth_24h_pct: 0 };

function bars(close, volume = 100, n = 30) {
  return Array.from({ length: n }, () => (
    { ts: '', open: close, high: close, low: close, close, volume_usd: volume, complete: true }
  ));
}

// Stubs every collaborator strategy.js calls through a default-export object.
// Returns the swap/fetch mocks and the recorded notify alerts.
function setup(t, { swap = async () => ENTRY_FILL, candles = bars(1), entry = PASS, preflight = { ok: true }, catalysts = ZERO_CATALYSTS } = {}) {
  const alerts = {};
  for (const name of ['buy', 'buyBlocked', 'untracked', 'scaleOut', 'exit', 'exitBlocked', 'exitFailing', 'catalystUnconfirmed']) {
    alerts[name] = [];
    t.mock.method(notify, name, async (a) => { alerts[name].push(a); });
  }
  const swapMock = t.mock.method(execution, 'executeSwap', swap);
  const fetchMock = t.mock.method(execution, 'fetchCandles', async () => candles);
  t.mock.method(execution, 'fetchCatalysts', async () => catalysts);
  t.mock.method(execution, 'preflightCheck', async () => preflight);
  t.mock.method(execution, 'getPortfolioValueUsd', async () => 100);
  t.mock.method(signals, 'evaluatePriceSignals', () => ({ passed: true }));
  t.mock.method(signals, 'evaluateEntry', () => entry);
  return { alerts, swapMock, fetchMock };
}

const swapsOf = (m) => m.mock.calls.map(c => c.arguments[0]);
const amountsOf = (m) => swapsOf(m).map(a => a.amount);

function scan(tokens, { portfolio_usd = 100, cash_usd = 100 } = {}) {
  return strategy.evaluateNewEntries({ tokens, baseToken, referenceMint: 'sol', portfolio_usd, cash_usd });
}

// entry_amount_token 100 @ 1.0, cost 100. `patch` carries fields openPosition() always overwrites.
function openPos(data = {}, patch = {}) {
  const pos = state.openPosition({
    token: { symbol: 'JUP', mint: 'jup', decimals: 6 },
    entry_ts: new Date().toISOString(),
    entry_price_usd: 1,
    entry_amount_token: 100,
    entry_value_usd: 100,
    setup_id: 'smart_money',
    kill_conditions: [],
    scale_out_proceeds_usd: 0,
    scale_out_cost_usd: 0,
    ...data,
  });
  if (Object.keys(patch).length) state.updatePosition(pos.id, patch);
  return pos;
}

const manage = () => strategy.manageOpenPositions({ baseToken });
const tick = () => new Promise(resolve => setImmediate(resolve));

// ─── Entry: sizing and side ────────────────────────────────────────────────

describe('evaluateNewEntries', () => {
  test('buys 25% of the portfolio in base-token units and records the position from the fill', async (t) => {
    const { alerts, swapMock } = setup(t);
    await scan([JUP]);

    assert.equal(swapMock.mock.callCount(), 1);
    const call = swapsOf(swapMock)[0];
    assert.deepEqual({ fromMint: call.fromMint, toMint: call.toMint, amount: call.amount },
      { fromMint: 'usdc', toMint: 'jup', amount: '25000000' });
    assert.match(call.clientOrderId, /^entry-/);

    const [pos] = state.getOpenPositions();
    assert.equal(pos.entry_value_usd, 25);
    assert.equal(pos.entry_amount_token, ENTRY_FILL.filled_amount);
    assert.equal(pos.entry_price_usd, ENTRY_FILL.to_token_unit_price_usd);
    assert.equal(pos.entry_tx_id, ENTRY_FILL.tx_id);
    assert.equal(alerts.buy.length, 1);
    assert.equal(alerts.buy[0].size_usd, 25);
    assert.equal(alerts.buy[0].pct_of_portfolio, 25);
    assert.equal(strategy.takeFunnel().entered, 1);
  });

  test('RS boost adds 25% to the size in Normal mode', async (t) => {
    const { swapMock } = setup(t, { entry: { ...PASS, booster_active: true } });
    await scan([JUP]);
    assert.deepEqual(amountsOf(swapMock), ['31250000']);
  });

  test('in Slow mode the size is 12.5% and the RS boost is ignored', async (t) => {
    state.setMachineState('Slow');
    const { swapMock } = setup(t, { entry: { ...PASS, booster_active: true } });
    await scan([JUP]);
    assert.deepEqual(amountsOf(swapMock), ['12500000']);
    assert.equal(state.getOpenPositions()[0].entry_value_usd, 12.5);
  });

  test('per-token max_position_usd caps the size', async (t) => {
    const { swapMock } = setup(t);
    await scan([{ ...JUP, max_position_usd: 40 }], { portfolio_usd: 1000, cash_usd: 1000 });
    assert.deepEqual(amountsOf(swapMock), ['40000000']);
  });

  test('keeps a 25% cash buffer and spends down cash within one scan', async (t) => {
    const { swapMock } = setup(t);
    await scan([JUP, WIF], { portfolio_usd: 100, cash_usd: 40 });
    // 1st: min(25, 0.75*40) = 25. 2nd: min(25, 0.75*15) = 11.25.
    assert.deepEqual(amountsOf(swapMock), ['25000000', '11250000']);
  });

  test('MAX_PORTFOLIO_USD caps the size by the cost basis already deployed', async (t) => {
    process.env.MAX_PORTFOLIO_USD = '40';
    openPos({ token: { symbol: 'WIF', mint: 'wif', decimals: 6 }, entry_value_usd: 30 });
    const room = 40 - risk.deployedCostBasisUsd();
    const { swapMock } = setup(t);
    await scan([JUP]);
    assert.equal(room, 10);
    assert.deepEqual(amountsOf(swapMock), [String(room * 1e6)]);
  });

  test('does not trade below MIN_TRADE_SIZE_USD', async (t) => {
    const { swapMock } = setup(t);
    await scan([JUP], { portfolio_usd: 100, cash_usd: 5 });   // 0.75*5 = 3.75 < 5
    assert.equal(swapMock.mock.callCount(), 0);
    assert.equal(strategy.takeFunnel().size_below_min, 1);
  });

  test('does not trade when the preflight check fails', async (t) => {
    const { swapMock } = setup(t, { preflight: { ok: false, reason: 'no_gas' } });
    await scan([JUP]);
    assert.equal(swapMock.mock.callCount(), 0);
    assert.equal(strategy.takeFunnel().no_gas, 1);
  });

  test('does not trade while the machine is Halted', async (t) => {
    state.setMachineState('Halted', new Date(Date.now() + 3600_000).toISOString());
    const { swapMock } = setup(t);
    await scan([JUP]);
    assert.equal(swapMock.mock.callCount(), 0);
    assert.equal(strategy.takeFunnel().risk_gate, 1);
  });

  test('does not trade at the concurrent-position limit (3 in Normal)', async (t) => {
    for (const [symbol, mint] of [['A', 'a'], ['B', 'b'], ['C', 'c']]) {
      openPos({ token: { symbol, mint, decimals: 6 } });
    }
    const { swapMock } = setup(t);
    await scan([JUP]);
    assert.equal(swapMock.mock.callCount(), 0);
    assert.equal(strategy.takeFunnel().risk_gate, 1);
  });

  test('skips a token that already has an open position without fetching its data', async (t) => {
    openPos();
    const { swapMock, fetchMock } = setup(t);
    await scan([JUP]);
    assert.equal(swapMock.mock.callCount(), 0);
    assert.ok(!fetchMock.mock.calls.some(c => c.arguments[0] === 'jup'), 'no candles fetched for jup');
  });

  test('a token listed twice in one scan is bought once', async (t) => {
    const { swapMock } = setup(t);
    await scan([JUP, JUP]);
    assert.equal(swapMock.mock.callCount(), 1);
    assert.equal(state.getOpenPositions().length, 1);
  });

  test('a failed entry swap records no position and no buy alert', async (t) => {
    t.mock.method(console, 'log', () => {});   // the entry_swap_failed ERROR line is expected here
    const { alerts } = setup(t, { swap: async () => { throw new Error('slippage_too_high:3.1'); } });
    await scan([JUP]);
    assert.equal(state.getOpenPositions().length, 0);
    assert.equal(alerts.buy.length, 0);
    assert.equal(strategy.takeFunnel().entry_failed, 1);
  });

  test('a CLI confirming gate on entry alerts buyBlocked and records no position', async (t) => {
    const { alerts } = setup(t, { swap: async () => { throw new CliConfirmingError('needs approval', 'run X'); } });
    await scan([JUP]);
    assert.deepEqual(alerts.buyBlocked, [{ symbol: 'JUP', message: 'needs approval', next: 'run X' }]);
    assert.equal(alerts.buy.length, 0);
    assert.equal(state.getOpenPositions().length, 0);
  });

  test('falls back to the last candle close when the fill has no unit price', async (t) => {
    setup(t, { candles: bars(1.5), swap: async () => ({ ...ENTRY_FILL, to_token_unit_price_usd: null }) });
    await scan([JUP]);
    assert.equal(state.getOpenPositions()[0].entry_price_usd, 1.5);
  });

  test('no unit price and a zero last close raises untracked and records no position', async (t) => {
    t.mock.method(console, 'log', () => {});   // the entry_price_unavailable ERROR line is expected here
    const { alerts } = setup(t, { candles: bars(0), swap: async () => ({ ...ENTRY_FILL, to_token_unit_price_usd: null }) });
    await scan([JUP]);
    assert.deepEqual(alerts.untracked, [{ symbol: 'JUP', tx_id: 'tx-entry' }]);
    assert.equal(alerts.buy.length, 0);
    assert.equal(state.getOpenPositions().length, 0);
  });
});

// ─── Management: scale-outs ────────────────────────────────────────────────

describe('manageOpenPositions: scale-outs', () => {
  test('sells 20% at +15% and books proceeds, cost and remaining amount', async (t) => {
    const { swapMock } = setup(t, { candles: bars(1.16), swap: async () => ({ tx_id: 'tx-so', filled_amount: 23 }) });
    const pos = openPos();
    await manage();

    assert.equal(swapMock.mock.callCount(), 1);
    assert.deepEqual(swapsOf(swapMock)[0], {
      fromMint: 'jup', toMint: 'usdc', amount: '20000000', clientOrderId: `scaleout-${pos.id}-15`,
    });
    const live = state.loadState().positions[pos.id];
    assert.deepEqual(live.scale_outs_done, [15]);
    assert.equal(live.current_amount_token, 80);
    assert.equal(live.scale_out_proceeds_usd, 23);
    assert.equal(live.scale_out_cost_usd, 20);
  });

  test('does not repeat a scale-out already done on the next pass', async (t) => {
    const { swapMock } = setup(t, { candles: bars(1.16), swap: async () => ({ tx_id: 'tx-so', filled_amount: 23 }) });
    openPos();
    await manage();
    await manage();
    assert.equal(swapMock.mock.callCount(), 1);
  });

  test('a jump to +55% sells all three tranches in one pass', async (t) => {
    const { swapMock } = setup(t, { candles: bars(1.55), swap: async () => ({ tx_id: 'tx-so', filled_amount: 30 }) });
    const pos = openPos();
    await manage();

    assert.deepEqual(amountsOf(swapMock), ['20000000', '30000000', '30000000']);
    const live = state.loadState().positions[pos.id];
    assert.equal(live.current_amount_token, 20);
    assert.deepEqual(live.scale_outs_done, [15, 30, 50]);
  });

  test('a failed scale-out swap books nothing and is retried on the next pass', async (t) => {
    const { swapMock } = setup(t, { candles: bars(1.16), swap: async () => { throw new Error('rpc down'); } });
    const pos = openPos();
    await manage();
    await manage();

    assert.equal(swapMock.mock.callCount(), 2);
    const live = state.loadState().positions[pos.id];
    assert.deepEqual(live.scale_outs_done, []);
    assert.equal(live.current_amount_token, 100);
  });
});

// ─── Management: exits ─────────────────────────────────────────────────────

describe('manageOpenPositions: exits', () => {
  test('hard stop after a scale-out sells the remainder and books blended PnL', async (t) => {
    const { swapMock, alerts } = setup(t, { candles: bars(0.85), swap: async () => ({ tx_id: 'tx-exit', filled_amount: 68 }) });
    const pos = openPos({}, {
      scale_outs_done: [15], current_amount_token: 80, peak_pnl_pct: 15,
      scale_out_proceeds_usd: 23, scale_out_cost_usd: 20,
    });
    await manage();

    assert.deepEqual(swapsOf(swapMock), [{
      fromMint: 'jup', toMint: 'usdc', amount: '80000000', clientOrderId: `exit-${pos.id}`,
    }]);
    assert.equal(state.getOpenPositions().length, 0);
    const trade = state.loadState().history.at(-1);
    assert.equal(trade.exit_reason, 'hard_stop');
    // (23 - 20) + (68 - 80) = -9
    assert.equal(trade.realized_pnl_usd, -9);
    assert.ok(Math.abs(trade.realized_pnl_pct + 9) < 1e-9);
    assert.equal(alerts.exit.length, 1);
  });

  test('trailing stop exits when price falls the trailing pct below the peak', async (t) => {
    const { swapMock } = setup(t, { candles: bars(1.11) });   // pnl 11, peak 20: 9 >= 8
    openPos({}, { peak_pnl_pct: 20 });
    await manage();

    assert.equal(swapMock.mock.callCount(), 1);
    assert.equal(state.loadState().history.at(-1).exit_reason, 'trailing_stop_8pct');
  });

  test('trailing stop tightens to 5% in Slow mode', async (t) => {
    state.setMachineState('Slow');
    setup(t, { candles: bars(1.14) });   // pnl 14, peak 20: 6 >= 5 but < 8
    openPos({}, { peak_pnl_pct: 20 });
    await manage();
    assert.equal(state.loadState().history.at(-1).exit_reason, 'trailing_stop_5pct');
  });

  test('time stop exits a position held more than 5 days', async (t) => {
    const { swapMock } = setup(t, { candles: bars(1) });
    openPos({ entry_ts: new Date(Date.now() - 6 * 24 * 3600_000).toISOString() });
    await manage();

    assert.equal(swapMock.mock.callCount(), 1);
    assert.equal(state.loadState().history.at(-1).exit_reason, 'time_stop_5d');
  });

  test('volume collapse exits when the last closed bar is 70% below the reference', async (t) => {
    const { swapMock } = setup(t, { candles: bars(1, 300) });
    openPos({ kill_conditions: [{ type: 'volume_collapse', reference_volume_usd: 1000, drop_threshold_pct: 70 }] });
    await manage();

    assert.equal(swapMock.mock.callCount(), 1);
    assert.equal(state.loadState().history.at(-1).exit_reason, 'volume_collapse_70pct');
  });

  test('volume collapse does not exit when the drop is just under the threshold', async (t) => {
    const { swapMock } = setup(t, { candles: bars(1, 301) });
    openPos({ kill_conditions: [{ type: 'volume_collapse', reference_volume_usd: 1000, drop_threshold_pct: 70 }] });
    await manage();

    assert.equal(swapMock.mock.callCount(), 0);
    assert.equal(state.getOpenPositions().length, 1);
  });

  test('catalyst death exits when the catalysts have decayed to nothing', async (t) => {
    const { swapMock } = setup(t, { catalysts: ZERO_CATALYSTS });
    openPos({ kill_conditions: [{ type: 'catalyst_death', original_catalysts: ['smart_money'] }] });
    await manage();

    assert.equal(swapMock.mock.callCount(), 1);
    assert.equal(state.loadState().history.at(-1).exit_reason, 'catalyst_death');
  });

  test('catalyst death does not exit while smart-money buyers persist', async (t) => {
    const { swapMock } = setup(t, { catalysts: { ...ZERO_CATALYSTS, smart_money_buyers_6h: 3 } });
    openPos({ kill_conditions: [{ type: 'catalyst_death', original_catalysts: ['smart_money'] }] });
    await manage();

    assert.equal(swapMock.mock.callCount(), 0);
    assert.equal(state.getOpenPositions().length, 1);
  });

  test('a fully scaled-out position at a stop price is closed without a swap', async (t) => {
    const { swapMock } = setup(t, { candles: bars(0.85) });
    openPos({}, {
      scale_outs_done: [15, 30, 50], current_amount_token: 0,
      scale_out_proceeds_usd: 130, scale_out_cost_usd: 100,
    });
    await manage();

    assert.equal(swapMock.mock.callCount(), 0);
    assert.equal(state.getOpenPositions().length, 0);
    const trade = state.loadState().history.at(-1);
    assert.equal(trade.exit_reason, 'hard_stop');
    assert.equal(trade.realized_pnl_usd, 30);
  });

  test('no candles means no swap and an untouched position', async (t) => {
    const { swapMock } = setup(t, { candles: [] });
    const pos = openPos();
    const snapshot = structuredClone(pos);
    await manage();

    assert.equal(swapMock.mock.callCount(), 0);
    assert.deepEqual(state.loadState().positions[pos.id], snapshot);
  });

  test('a failed post-exit portfolio read still closes the position and alerts the exit', async (t) => {
    const { alerts } = setup(t, { candles: bars(0.85), swap: async () => ({ tx_id: 'tx-exit', filled_amount: 85 }) });
    t.mock.method(execution, 'getPortfolioValueUsd', async () => { throw new Error('balance blip'); });
    openPos();
    await manage();

    assert.equal(state.getOpenPositions().length, 0);
    assert.equal(state.loadState().history.length, 1);
    assert.equal(alerts.exit.length, 1);
  });
});

// ─── Management: double-execution guards ───────────────────────────────────

describe('manageOpenPositions: double-execution guards', () => {
  test('overlapping calls at a stop price send exactly one exit swap and close one trade', async (t) => {
    const { swapMock } = setup(t, {
      candles: bars(0.85),
      swap: async () => { await tick(); return { tx_id: 'tx-exit', filled_amount: 85 }; },
    });
    openPos();
    await Promise.all([manage(), manage()]);

    assert.equal(swapMock.mock.callCount(), 1);
    assert.equal(state.loadState().history.length, 1);
  });

  test('a recent exit_pending skips the position entirely', async (t) => {
    const { swapMock, fetchMock } = setup(t, { candles: bars(0.85) });
    openPos({}, { exit_pending: { reason: 'hard_stop', started_ts: new Date(Date.now() - 60_000).toISOString() } });
    await manage();

    assert.equal(fetchMock.mock.callCount(), 0);
    assert.equal(swapMock.mock.callCount(), 0);
  });

  test('a stale exit_pending is cleared in state and processing continues', async (t) => {
    const { swapMock, fetchMock } = setup(t, { candles: bars(1) });
    const pos = openPos({}, { exit_pending: { reason: 'hard_stop', started_ts: new Date(Date.now() - 11 * 60_000).toISOString() } });
    await manage();

    assert.equal(state.loadState().positions[pos.id].exit_pending, null);
    assert.equal(fetchMock.mock.callCount(), 1);
    assert.equal(swapMock.mock.callCount(), 0);
  });

  test('a stale exit_pending does not stop the hard stop from selling', async (t) => {
    const { swapMock } = setup(t, { candles: bars(0.85), swap: async () => ({ tx_id: 'tx-exit', filled_amount: 85 }) });
    openPos({}, { exit_pending: { reason: 'hard_stop', started_ts: new Date(Date.now() - 11 * 60_000).toISOString() } });
    await manage();

    assert.equal(swapMock.mock.callCount(), 1);
    assert.equal(state.getOpenPositions().length, 0);
  });

  test('an exit blocked by the CLI keeps the position open with exit_pending set and is not retried at once', async (t) => {
    const { swapMock, alerts } = setup(t, {
      candles: bars(0.85),
      swap: async () => { throw new CliConfirmingError('needs approval', 'run X'); },
    });
    const pos = openPos();
    await manage();
    await manage();

    assert.equal(alerts.exitBlocked.length, 1);
    assert.equal(alerts.exitBlocked[0].reason, 'hard_stop');
    assert.equal(alerts.exitBlocked[0].message, 'needs approval');
    assert.equal(alerts.exitBlocked[0].next, 'run X');
    assert.equal(state.getOpenPositions().length, 1);
    assert.equal(state.loadState().positions[pos.id].exit_pending.reason, 'hard_stop');
    assert.equal(swapMock.mock.callCount(), 1, 'second pass is skipped by exit_pending');
  });
});

// ─── Management: unconfirmed catalyst alert ────────────────────────────────
//
// An incomplete catalyst read that does not pass skips the catalyst-death
// exit. The streak start lives on the position; past 1h the bot tells the
// operator. None of this may ever change an exit decision.

describe('manageOpenPositions: unconfirmed catalyst alert', () => {
  const INCOMPLETE = { ...ZERO_CATALYSTS, incomplete: true };
  const CAT_KILL = [{ type: 'catalyst_death', original_catalysts: ['smart_money'] }];
  const minAgo = (m) => new Date(Date.now() - m * 60_000).toISOString();
  const sinceOf = (pos) => state.loadState().positions[pos.id].catalyst_unconfirmed_since;
  const isRecent = (iso) => Date.now() - Date.parse(iso) < 10_000 && Date.parse(iso) <= Date.now();

  test('the first unconfirmed read starts the streak: field set, no alert, no sale', async (t) => {
    const { swapMock, alerts } = setup(t, { catalysts: INCOMPLETE });
    const pos = openPos({ kill_conditions: CAT_KILL });
    await manage();

    assert.ok(isRecent(sinceOf(pos)), `since should be a recent ISO, got ${sinceOf(pos)}`);
    assert.equal(alerts.catalystUnconfirmed.length, 0);
    assert.equal(swapMock.mock.callCount(), 0);
    assert.equal(state.getOpenPositions().length, 1);
  });

  test('an unconfirmed streak past 1h alerts with the stuck time, and still never sells', async (t) => {
    const { swapMock, alerts } = setup(t, { catalysts: INCOMPLETE, candles: bars(1.05) });   // +5%: the alert must carry the real mark
    const since = minAgo(61);
    const pos = openPos({ kill_conditions: CAT_KILL }, { catalyst_unconfirmed_since: since });
    await manage();

    assert.equal(alerts.catalystUnconfirmed.length, 1);
    const a = alerts.catalystUnconfirmed[0];
    assert.equal(a.position_id, pos.id);
    assert.equal(a.symbol, 'JUP');
    assert.ok(Math.abs(a.pnl_pct - 5) < 1e-6, `pnl_pct ${a.pnl_pct}`);
    assert.equal(a.hard_stop_pct, risk.getHardStopPct());
    assert.ok(a.stuck_ms >= 61 * 60_000 && a.stuck_ms < 61 * 60_000 + 10_000, `stuck_ms ${a.stuck_ms}`);
    assert.equal(sinceOf(pos), since, 'alerting does not rewrite the streak start');
    assert.equal(swapMock.mock.callCount(), 0);
    assert.equal(state.getOpenPositions().length, 1);

    // Ten hours in: still no sale, still alerting (notify throttles, not strategy).
    state.updatePosition(pos.id, { catalyst_unconfirmed_since: minAgo(600) });
    await manage();
    assert.equal(alerts.catalystUnconfirmed.length, 2);
    assert.ok(alerts.catalystUnconfirmed[1].stuck_ms >= 600 * 60_000);
    assert.equal(swapMock.mock.callCount(), 0);
    assert.equal(state.getOpenPositions().length, 1);
  });

  test('the threshold is 1h: just under stays quiet, just over alerts', async (t) => {
    const { alerts } = setup(t, { catalysts: INCOMPLETE });
    const ago = (ms) => new Date(Date.now() - ms).toISOString();
    const pos = openPos({ kill_conditions: CAT_KILL }, { catalyst_unconfirmed_since: ago(3600_000 - 5_000) });
    await manage();
    assert.equal(alerts.catalystUnconfirmed.length, 0, '59m55s is under the threshold');

    state.updatePosition(pos.id, { catalyst_unconfirmed_since: ago(3600_000 + 5_000) });
    await manage();
    assert.equal(alerts.catalystUnconfirmed.length, 1, '1h00m05s is past it');
  });

  test('state is written only when a streak starts or ends, never on steady reads', async (t) => {
    setup(t, { catalysts: { ...ZERO_CATALYSTS, smart_money_buyers_6h: 3 } });
    const pos = openPos({ kill_conditions: CAT_KILL });
    const writes = t.mock.method(state, 'updatePosition');   // no stub: calls through
    const run = async (catalysts, times = 2) => {
      execution.fetchCatalysts.mock.mockImplementation(async () => catalysts);
      for (let i = 0; i < times; i++) await manage();
    };

    await run({ ...ZERO_CATALYSTS, smart_money_buyers_6h: 3 });
    assert.equal(writes.mock.callCount(), 0, 'confirmed reads with no streak write nothing');
    await run(INCOMPLETE);
    assert.equal(writes.mock.callCount(), 1, 'the streak start is written once, not per tick');
    await run({ ...ZERO_CATALYSTS, smart_money_buyers_6h: 3 });
    assert.equal(writes.mock.callCount(), 2, 'the reset is written once');
    assert.equal(sinceOf(pos), null);
  });

  test('an unconfirmed streak under 1h neither alerts nor rewrites the streak start', async (t) => {
    const { swapMock, alerts } = setup(t, { catalysts: INCOMPLETE });
    const since = minAgo(30);
    const pos = openPos({ kill_conditions: CAT_KILL }, { catalyst_unconfirmed_since: since });
    await manage();

    assert.equal(alerts.catalystUnconfirmed.length, 0);
    assert.equal(sinceOf(pos), since);
    assert.equal(swapMock.mock.callCount(), 0);
  });

  test('a confirming read clears the streak; a later incomplete read starts a fresh one', async (t) => {
    const { alerts } = setup(t, { catalysts: INCOMPLETE });
    const pos = openPos({ kill_conditions: CAT_KILL }, { catalyst_unconfirmed_since: minAgo(120) });

    execution.fetchCatalysts.mock.mockImplementation(async () => ({ ...ZERO_CATALYSTS, smart_money_buyers_6h: 3 }));
    await manage();
    assert.equal(sinceOf(pos), null);
    assert.equal(alerts.catalystUnconfirmed.length, 0);

    execution.fetchCatalysts.mock.mockImplementation(async () => INCOMPLETE);
    await manage();
    assert.ok(isRecent(sinceOf(pos)), 'a fresh streak, not the 2h-old one');
    assert.equal(alerts.catalystUnconfirmed.length, 0);
  });

  test('an incomplete read where another source passes clears the streak: no alert, no sale', async (t) => {
    const { swapMock, alerts } = setup(t, { catalysts: { ...INCOMPLETE, smart_money_buyers_6h: 3 } });
    const pos = openPos({ kill_conditions: CAT_KILL }, { catalyst_unconfirmed_since: minAgo(120) });
    await manage();

    assert.equal(sinceOf(pos), null);
    assert.equal(alerts.catalystUnconfirmed.length, 0);
    assert.equal(swapMock.mock.callCount(), 0);
    assert.equal(state.getOpenPositions().length, 1);
  });

  test('a complete dead read still sells as catalyst_death even with a streak recorded', async (t) => {
    const { swapMock, alerts } = setup(t, { catalysts: ZERO_CATALYSTS });
    openPos({ kill_conditions: CAT_KILL }, { catalyst_unconfirmed_since: minAgo(120) });
    await manage();

    assert.equal(swapMock.mock.callCount(), 1);
    assert.equal(state.loadState().history.at(-1).exit_reason, 'catalyst_death');
    assert.equal(alerts.catalystUnconfirmed.length, 0);
  });

  for (const [label, bad] of [
    ['an unparsable', 'not-a-date'],
    ['a future', new Date(Date.now() + 3600_000).toISOString()],
  ]) {
    test(`${label} streak start is replaced by now: no alert, no crash`, async (t) => {
      const { swapMock, alerts } = setup(t, { catalysts: INCOMPLETE });
      const pos = openPos({ kill_conditions: CAT_KILL }, { catalyst_unconfirmed_since: bad });
      await manage();

      assert.ok(isRecent(sinceOf(pos)), `since should be rewritten to ~now, got ${sinceOf(pos)}`);
      assert.equal(alerts.catalystUnconfirmed.length, 0);
      assert.equal(swapMock.mock.callCount(), 0);
      assert.equal(state.getOpenPositions().length, 1);
    });
  }

  test('the streak start is persisted to the state file', async (t) => {
    setup(t, { catalysts: INCOMPLETE });
    const pos = openPos({ kill_conditions: CAT_KILL });
    await manage();

    const onDisk = JSON.parse(fs.readFileSync(process.env.OKX_BOT_STATE_FILE, 'utf-8'));
    assert.equal(onDisk.positions[pos.id].catalyst_unconfirmed_since, sinceOf(pos));
    assert.ok(isRecent(onDisk.positions[pos.id].catalyst_unconfirmed_since));
  });

  test('end to end with the real notify: one Telegram message for a long streak, not one per tick', async (t) => {
    const prior = {
      fetch: globalThis.fetch,
      token: process.env.TELEGRAM_BOT_TOKEN,
      chat: process.env.TELEGRAM_CHAT_ID,
    };
    const telegram = [];
    process.env.TELEGRAM_BOT_TOKEN = '123456:test';
    process.env.TELEGRAM_CHAT_ID = '1';
    globalThis.fetch = async (url, opts) => {
      telegram.push({ url, body: JSON.parse(opts.body) });
      return { ok: true, status: 200 };
    };
    fs.rmSync(path.join(process.env.OKX_BOT_LOG_DIR, 'alerts_sent.json'), { force: true });
    try {
      const { swapMock } = setup(t, { catalysts: INCOMPLETE });
      notify.catalystUnconfirmed.mock.restore();   // run the real alert, through the real throttle
      openPos({ kill_conditions: CAT_KILL }, { catalyst_unconfirmed_since: minAgo(120) });
      await manage();
      await manage();

      assert.equal(telegram.length, 1, 'second tick is throttled');
      assert.match(telegram[0].url, /^https:\/\/api\.telegram\.org\/bot/);
      assert.equal(telegram[0].body.chat_id, '1');
      assert.match(telegram[0].body.text, /catalyst check blind for 2h/);
      assert.equal(swapMock.mock.callCount(), 0);
      assert.equal(state.getOpenPositions().length, 1);
    } finally {
      globalThis.fetch = prior.fetch;
      for (const [k, v] of [['TELEGRAM_BOT_TOKEN', prior.token], ['TELEGRAM_CHAT_ID', prior.chat]]) {
        if (v === undefined) delete process.env[k]; else process.env[k] = v;
      }
    }
  });
});
