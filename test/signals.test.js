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

// 25 CLOSED hourly candles. SMA(last 4) ≈ 110, last1h_volume = 200,
// avg24h_volume (the 24 bars before it) = 100, so ratio = 2.0 (passes 1.5×).
function fixtureBullishCandles() {
  const candles = [];
  for (let i = 0; i < 24; i++) {
    candles.push({ ts: '', open: 100, high: 105, low: 95, close: 100, volume_usd: 100, complete: true });
  }
  // Last candle: price spike + volume spike
  candles.push({ ts: '', open: 100, high: 115, low: 100, close: 115, volume_usd: 200, complete: true });
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
    candles.push({ ts: '', open: 100, high: 100, low: 100, close: 100, volume_usd: 100, complete: true });
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
  const r = signals.signalMomentum([{ ts: '', open: 1, high: 1, low: 1, close: 1, volume_usd: 1, complete: true }]);
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

// ─── completedCandles / in-progress bar handling ──────────────────────────

test('completedCandles keeps everything when the newest bar is marked complete', () => {
  const c = fixtureFlatCandles();
  assert.equal(signals.completedCandles(c).length, 25);
});

test('completedCandles drops the newest bar when the complete flag is absent', () => {
  const c = fixtureFlatCandles().map(({ complete, ...rest }) => rest);
  assert.equal(signals.completedCandles(c).length, 24);
});

test('completedCandles drops every trailing bar explicitly marked in-progress', () => {
  const c = fixtureFlatCandles();
  c.push({ ts: '', open: 100, high: 100, low: 100, close: 100, volume_usd: 3, complete: false });
  const closed = signals.completedCandles(c);
  assert.equal(closed.length, 25);
  assert.equal(closed[closed.length - 1].volume_usd, 100);
});

test('signalMomentum ignores the in-progress bar (near-zero volume right after the hour)', () => {
  // Bullish fixture qualifies on its closed bars. Appending the current
  // hour's bar with 1% of normal volume must NOT flip momentum to fail.
  const c = fixtureBullishCandles();
  c.push({ ts: '', open: 115, high: 115, low: 115, close: 115, volume_usd: 1, complete: false });
  const r = signals.signalMomentum(c);
  assert.equal(r.passed, true);
  assert.equal(r.last_1h_volume_usd, 200, 'uses the last CLOSED bar');
});

test('signalMomentum needs 25 closed bars — 25 with an unflagged newest one is insufficient', () => {
  const c = fixtureBullishCandles().map(({ complete, ...rest }) => rest);
  const r = signals.signalMomentum(c);
  assert.equal(r.passed, false);
  assert.equal(r.reason, 'insufficient_data');
});

// ─── evaluatePriceSignals (chart-only pre-check) ──────────────────────────

test('evaluatePriceSignals passes on the bullish fixture and names no reason', () => {
  const r = signals.evaluatePriceSignals(fixtureBullishCandles());
  assert.equal(r.passed, true);
  assert.equal(r.reason, null);
  assert.deepEqual(Object.keys(r.breakdown), ['trend', 'momentum', 'valuation']);
});

test('evaluatePriceSignals reports the first failing chart signal', () => {
  const r = signals.evaluatePriceSignals(fixtureFlatCandles());
  assert.equal(r.passed, false);
  assert.equal(r.reason, 'trend_failed');
});

test('evaluateEntry breakdown keeps the trend→momentum→valuation→catalyst→rs order', () => {
  const r = signals.evaluateEntry({
    candles: fixtureBullishCandles(),
    refCandles: fixtureFlatCandles(),
    catalysts: { smart_money_buyers_6h: 0, smart_money_volume_6h_usd: 0, holder_growth_24h_pct: 0, news_mentions_24h: 0 },
    machineState: 'Normal',
  });
  assert.equal(r.passed, false);
  assert.equal(r.reason, 'catalyst_failed');
  assert.deepEqual(Object.keys(r.breakdown), ['trend', 'momentum', 'valuation', 'catalyst', 'rs']);
});
