// Smoke tests for signals.js — pure functions, no I/O, easy to cover.
// Run: npm test
//
// These tests are intentionally narrow. They verify the strategy thresholds
// in the spec actually hold in code, so a future refactor that accidentally
// flips `>` to `>=` (or vice versa) gets caught.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import signals from '../signals.js';

// ─── Test fixtures ────────────────────────────────────────────────────────

// 25 hourly candles. SMA(last 4) ≈ 110, last1h_volume = 200, avg24h_volume = 100,
// so volume ratio = 2.0 (passes 1.5× momentum threshold).
function fixtureBullishCandles() {
  const candles = [];
  for (let i = 0; i < 24; i++) {
    candles.push({ ts: '', open: 100, high: 105, low: 95, close: 100, volume_usd: 100 });
  }
  // Last candle: price spike + volume spike
  candles.push({ ts: '', open: 100, high: 115, low: 100, close: 115, volume_usd: 200 });
  // Bump last 3 closes so SMA(4) reflects a real uptrend without overshooting
  // the not-extended threshold (price <= 1.15 × SMA).
  candles[candles.length - 4].close = 105;
  candles[candles.length - 3].close = 108;
  candles[candles.length - 2].close = 112;
  return candles;
}

// All-flat 25 candles — should fail momentum (ratio == 1.0).
function fixtureFlatCandles() {
  const candles = [];
  for (let i = 0; i < 25; i++) {
    candles.push({ ts: '', open: 100, high: 100, low: 100, close: 100, volume_usd: 100 });
  }
  return candles;
}

// ─── signalTrend ──────────────────────────────────────────────────────────

test('signalTrend passes when last close > SMA(4)', () => {
  const r = signals.signalTrend(fixtureBullishCandles());
  assert.equal(r.passed, true, 'should pass');
  assert.ok(r.pct_above_sma > 0, 'pct_above_sma should be positive');
});

test('signalTrend fails when last close < SMA(4)', () => {
  const candles = fixtureFlatCandles();
  candles[candles.length - 1].close = 99;  // dip below SMA
  const r = signals.signalTrend(candles);
  assert.equal(r.passed, false);
});

// ─── signalMomentum ───────────────────────────────────────────────────────

test('signalMomentum default threshold is 1.5× — matches SKILL.md spec', () => {
  const r = signals.signalMomentum(fixtureBullishCandles());
  assert.equal(r.passed, true);
  assert.ok(r.ratio >= 1.5, `ratio=${r.ratio} should be ≥ 1.5`);
});

test('signalMomentum fails on flat volume', () => {
  const r = signals.signalMomentum(fixtureFlatCandles());
  assert.equal(r.passed, false);
});

test('signalMomentum returns insufficient_data with <25 candles', () => {
  const r = signals.signalMomentum([{ ts: '', open: 1, high: 1, low: 1, close: 1, volume_usd: 1 }]);
  assert.equal(r.passed, false);
  assert.equal(r.reason, 'insufficient_data');
});

// ─── signalNotExtended ────────────────────────────────────────────────────

test('signalNotExtended caps at 15% above SMA per spec', () => {
  const candles = fixtureBullishCandles();
  // Force price >25% above SMA by inflating last close
  candles[candles.length - 1].close = 200;
  const r = signals.signalNotExtended(candles);
  assert.equal(r.passed, false, 'should fail when extended');
  assert.equal(r.threshold_pct, 15);
});

// ─── signalCatalyst ───────────────────────────────────────────────────────

test('signalCatalyst passes on ≥3 smart money buyers in 6h', () => {
  const r = signals.signalCatalyst({
    smart_money_buyers_6h: 5,
    smart_money_volume_6h_usd: 12000,
    holder_growth_24h_pct: 0,
    news_mentions_24h: 0,
  });
  assert.equal(r.passed, true);
  assert.equal(r.catalysts_active[0].type, 'smart_money');
});

test('signalCatalyst passes on ≥5% holder growth alone', () => {
  const r = signals.signalCatalyst({
    smart_money_buyers_6h: 0,
    smart_money_volume_6h_usd: 0,
    holder_growth_24h_pct: 7.2,
    news_mentions_24h: 0,
  });
  assert.equal(r.passed, true);
  assert.equal(r.catalysts_active[0].type, 'on_chain_spike');
});

test('signalCatalyst fails when no catalyst type triggers', () => {
  const r = signals.signalCatalyst({
    smart_money_buyers_6h: 1,        // below 3-threshold
    smart_money_volume_6h_usd: 100,
    holder_growth_24h_pct: 2,        // below 5% threshold
    news_mentions_24h: 0,
  });
  assert.equal(r.passed, false);
});

// ─── evaluateEntry composite ──────────────────────────────────────────────

test('evaluateEntry requires all 4 hard signals — fails fast on momentum', () => {
  // Construct candles where trend passes (price slightly above SMA) but
  // momentum fails (flat volume = ratio < 1.5).
  const candles = fixtureFlatCandles();
  candles[candles.length - 1].close = 101;  // trend passes (price > sma)
  // Volumes stay at 100 → ratio = 1.0 → momentum fails
  const r = signals.evaluateEntry({
    candles,
    refCandles: fixtureFlatCandles(),
    catalysts: { smart_money_buyers_6h: 10, smart_money_volume_6h_usd: 100000, holder_growth_24h_pct: 0, news_mentions_24h: 0 },
    machineState: 'Normal',
  });
  assert.equal(r.passed, false);
  assert.equal(r.reason, 'momentum_failed');
});

test('evaluateEntry in Slow mode requires smart_money catalyst specifically', () => {
  const r = signals.evaluateEntry({
    candles: fixtureBullishCandles(),
    refCandles: fixtureFlatCandles(),
    // Holder growth catalyst, no smart money
    catalysts: { smart_money_buyers_6h: 0, smart_money_volume_6h_usd: 0, holder_growth_24h_pct: 8, news_mentions_24h: 0 },
    machineState: 'Slow',
  });
  assert.equal(r.passed, false);
  assert.equal(r.reason, 'slow_mode_requires_smart_money');
});

test('evaluateEntry passes when all 4 signals + smart_money catalyst align', () => {
  const r = signals.evaluateEntry({
    candles: fixtureBullishCandles(),
    refCandles: fixtureFlatCandles(),
    catalysts: { smart_money_buyers_6h: 5, smart_money_volume_6h_usd: 8000, holder_growth_24h_pct: 0, news_mentions_24h: 0 },
    machineState: 'Normal',
  });
  assert.equal(r.passed, true);
  assert.match(r.setup_id, /smart_money/);
});
