// Pure-function tests for strategy.js accounting and kill-condition setup.
// Run: npm test

import { test, before } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs';
import os from 'os';
import path from 'path';

let strategy;
before(async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'okx-strategy-test-'));
  process.env.OKX_BOT_STATE_FILE = path.join(dir, 'state.json');
  process.env.OKX_BOT_HOLDERS_FILE = path.join(dir, 'holders_history.json');
  process.env.OKX_BOT_LOG_DIR = path.join(dir, 'logs');
  const { setLogLevel } = await import('../logger.js');
  setLogLevel('error');
  strategy = (await import('../strategy.js')).default;
});

function basePosition(overrides = {}) {
  return {
    entry_value_usd: 100,
    entry_price_usd: 1.0,
    entry_amount_token: 100,
    current_amount_token: 100,
    scale_out_proceeds_usd: 0,
    scale_out_cost_usd: 0,
    peak_pnl_pct: 0,
    ...overrides,
  };
}

// ─── computeRealizedPnl ───────────────────────────────────────────────────

test('computeRealizedPnl: plain close with no partials matches mark-to-market', () => {
  const r = strategy.computeRealizedPnl(basePosition(), { current_price: 0.9 });
  assert.equal(r.realized_pnl_usd.toFixed(6), '-10.000000');
  assert.equal(r.realized_pnl_pct.toFixed(6), '-10.000000');
});

test('computeRealizedPnl: prefers the actual exit fill over mark price', () => {
  const r = strategy.computeRealizedPnl(basePosition(), { exit_proceeds_usd: 112, current_price: 0.5 });
  assert.equal(r.realized_pnl_usd.toFixed(6), '12.000000');
});

test('computeRealizedPnl: scale-outs at +15%/+30% then hard stop at -10% is a WIN, not a loss', () => {
  // 20% sold @1.15 → 23, 30% sold @1.30 → 39; cost of those = 50.
  // Residue 50 tokens stopped @0.90 → 45 vs cost 50.
  // True PnL = (23 + 39 − 50) + (45 − 50) = +7.
  const pos = basePosition({
    current_amount_token: 50,
    scale_out_proceeds_usd: 23 + 39,
    scale_out_cost_usd: 50,
  });
  const r = strategy.computeRealizedPnl(pos, { current_price: 0.9 });
  assert.equal(r.realized_pnl_usd.toFixed(6), '7.000000');
  assert.equal(r.realized_pnl_pct.toFixed(6), '7.000000');
  assert.ok(r.realized_pnl_usd > 0, 'v0.1 booked this as −$10 and counted a loss');
});

test('computeRealizedPnl: fully scaled-out residue (amount 0) books only the partials', () => {
  const pos = basePosition({ current_amount_token: 0, scale_out_proceeds_usd: 130, scale_out_cost_usd: 100 });
  const r = strategy.computeRealizedPnl(pos, { current_price: 0.1 });
  assert.equal(r.realized_pnl_usd.toFixed(6), '30.000000');
});

test('computeRealizedPnl: legacy v0.1 position (no scale-out fields) still works', () => {
  const pos = { entry_value_usd: 50, entry_price_usd: 2, entry_amount_token: 25, current_amount_token: 25 };
  const r = strategy.computeRealizedPnl(pos, { current_price: 2.2 });
  assert.equal(r.realized_pnl_usd.toFixed(6), '5.000000');
  assert.equal(r.realized_pnl_pct.toFixed(6), '10.000000');
});

test('computeRealizedPnl: unknown mark and no fill books the residue flat (no NaN)', () => {
  const r = strategy.computeRealizedPnl(basePosition(), { current_price: null });
  assert.equal(r.realized_pnl_usd, 0);
  assert.ok(Number.isFinite(r.realized_pnl_pct));
});

// ─── buildKillConditions ──────────────────────────────────────────────────

const ev = { breakdown: { catalyst: { catalysts_active: [{ type: 'smart_money' }] } } };

function candles(volumes, lastComplete) {
  return volumes.map((v, i) => ({
    ts: '', open: 1, high: 1, low: 1, close: 1, volume_usd: v,
    complete: i === volumes.length - 1 ? lastComplete : true,
  }));
}

test('buildKillConditions: volume reference is the last CLOSED bar, not the in-progress one', () => {
  const kc = strategy.buildKillConditions(ev, candles([100, 500, 2], false));
  const vol = kc.find(k => k.type === 'volume_collapse');
  assert.ok(vol, 'volume_collapse present');
  assert.equal(vol.reference_volume_usd, 500);
  assert.equal(vol.drop_threshold_pct, 70);
});

test('buildKillConditions: no candles → no volume_collapse (never -Infinity)', () => {
  const kc = strategy.buildKillConditions(ev, []);
  assert.equal(kc.find(k => k.type === 'volume_collapse'), undefined);
  assert.ok(kc.find(k => k.type === 'time_stop'));
  assert.deepEqual(kc.find(k => k.type === 'catalyst_death').original_catalysts, ['smart_money']);
});

test('buildKillConditions: zero-volume reference is skipped rather than dividing by zero later', () => {
  const kc = strategy.buildKillConditions(ev, candles([0], true));
  assert.equal(kc.find(k => k.type === 'volume_collapse'), undefined);
});
