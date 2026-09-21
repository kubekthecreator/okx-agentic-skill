// signals.js — pure functions over candle/market data. No I/O.
//
// Input data shape (returned by execution.fetchCandles):
// candles: [{ ts, open, high, low, close, volume_usd }, ...]   newest last
//
// All thresholds match SKILL.md / README.md spec.

// ─── Basic indicators ──────────────────────────────────────────────────────

export function sma(candles, period) {
  if (candles.length < period) return null;
  const slice = candles.slice(-period);
  const sum = slice.reduce((acc, c) => acc + c.close, 0);
  return sum / period;
}

export function lastPrice(candles) {
  if (candles.length === 0) return null;
  return candles[candles.length - 1].close;
}

// Completed (closed) candles only.
//
// The newest hourly bar returned by the market API is the bar in progress:
// one minute past the hour its volume is close to zero. Any volume-based
// comparison that includes it is systematically biased (momentum fails early
// in the hour, "volume collapse" fires right after the hour turns over).
//
// Candles carry `complete: true|false` when the source reports it. When the
// flag is missing the newest bar is assumed to be in progress and dropped.
export function completedCandles(candles) {
  const n = candles.length;
  if (n === 0) return [];
  const last = candles[n - 1];
  if (last.complete === true) return candles;
  if (last.complete === false) {
    let end = n;
    while (end > 0 && candles[end - 1].complete === false) end--;
    return candles.slice(0, end);
  }
  return candles.slice(0, n - 1);
}

// ─── Entry signals ─────────────────────────────────────────────────────────

// Signal 1: Trend — price > SMA(4h).
// Candles assumed 1h, so SMA(4h) = SMA over 4 candles.
export function signalTrend(candles) {
  const price = lastPrice(candles);
  const trend = sma(candles, 4);
  if (price === null || trend === null) return { passed: false, reason: 'insufficient_data' };
  return {
    passed: price > trend,
    price,
    sma_4h: trend,
    pct_above_sma: ((price - trend) / trend) * 100,
  };
}

// Signal 2: Momentum — volume(1h) > 1.5 × avg(volume, 24h).
// "1h" is the last COMPLETED hourly bar; the average is over the 24 completed
// bars before it. Needs 25 completed candles.
export function signalMomentum(candles, multiplier = 1.5) {
  const closed = completedCandles(candles);
  if (closed.length < 25) return { passed: false, reason: 'insufficient_data' };
  const last1h_volume = closed[closed.length - 1].volume_usd;
  const prior24 = closed.slice(-25, -1);
  const avg24h_volume = prior24.reduce((acc, c) => acc + c.volume_usd, 0) / 24;
  if (avg24h_volume === 0) return { passed: false, reason: 'zero_volume' };
  const ratio = last1h_volume / avg24h_volume;
  return {
    passed: ratio > multiplier,
    last_1h_volume_usd: last1h_volume,
    avg_24h_volume_usd: avg24h_volume,
    ratio,
  };
}

// Signal 3: Valuation — price ≤ 1.15 × SMA(4h).
export function signalNotExtended(candles, maxPctAbove = 15) {
  const price = lastPrice(candles);
  const trend = sma(candles, 4);
  if (price === null || trend === null) return { passed: false, reason: 'insufficient_data' };
  const pct = ((price - trend) / trend) * 100;
  return {
    passed: pct <= maxPctAbove,
    pct_above_sma: pct,
    threshold_pct: maxPctAbove,
  };
}

// Signal 4: Catalyst — at least one of:
//   a) smart money cluster: ≥3 OKX top-trader wallets accumulated last 6h
//   b) news flow: token mentioned in news in last 24h (stub for v0.1)
//   c) on-chain spike: holders +5% in 24h
// Inputs come from execution.fetchCatalysts().
export function signalCatalyst(catalysts) {
  if (!catalysts) return { passed: false, reason: 'no_catalyst_data' };
  const checks = [];

  if (catalysts.smart_money_buyers_6h >= 3) {
    checks.push({
      type: 'smart_money',
      buyers_6h: catalysts.smart_money_buyers_6h,
      total_usd: catalysts.smart_money_volume_6h_usd,
    });
  }

  if (catalysts.news_mentions_24h > 0) {
    checks.push({
      type: 'news',
      mentions_24h: catalysts.news_mentions_24h,
    });
  }

  if (catalysts.holder_growth_24h_pct >= 5) {
    checks.push({
      type: 'on_chain_spike',
      holder_growth_pct: catalysts.holder_growth_24h_pct,
    });
  }

  return {
    passed: checks.length > 0,
    catalysts_active: checks,
  };
}

// Booster (Signal 5): Relative Strength — token outperforms SOL by ≥5% over 4h.
// Inputs: candles for token + candles for reference (SOL).
export function signalRelativeStrength(tokenCandles, refCandles, minPct = 5) {
  if (tokenCandles.length < 4 || refCandles.length < 4) {
    return { passed: false, reason: 'insufficient_data' };
  }
  const tokenStart = tokenCandles[tokenCandles.length - 4].close;
  const tokenEnd = lastPrice(tokenCandles);
  const refStart = refCandles[refCandles.length - 4].close;
  const refEnd = lastPrice(refCandles);

  const tokenRet = ((tokenEnd - tokenStart) / tokenStart) * 100;
  const refRet = ((refEnd - refStart) / refStart) * 100;
  const outperformance = tokenRet - refRet;

  return {
    passed: outperformance >= minPct,
    token_return_4h_pct: tokenRet,
    ref_return_4h_pct: refRet,
    outperformance_pct: outperformance,
  };
}

// ─── Composite ─────────────────────────────────────────────────────────────

// Returns a setup_id encoding which catalyst type triggered. Used by
// anti-pattern detector to identify recurring losing setups.
export function setupId(signals) {
  if (!signals.catalyst.passed) return 'no_catalyst';
  const types = signals.catalyst.catalysts_active.map(c => c.type).sort();
  const rs = signals.rs && signals.rs.passed ? 'rs' : 'no_rs';
  return `${types.join('+')}__${rs}`;
}

// The three chart-only hard signals (trend, momentum, valuation). Pure and
// cheap — strategy.js runs this BEFORE paying for catalyst data, which costs
// an extra CLI call per token per tick.
export function evaluatePriceSignals(candles) {
  const trend = signalTrend(candles);
  const momentum = signalMomentum(candles);
  const valuation = signalNotExtended(candles);
  const breakdown = { trend, momentum, valuation };
  const passed = trend.passed && momentum.passed && valuation.passed;
  return { passed, breakdown, reason: passed ? null : firstFailure(breakdown) };
}

// Combined entry decision. Returns object with .passed and full breakdown.
// In Slow mode, catalyst becomes mandatory AND smart_money type is required.
export function evaluateEntry({
  candles,
  refCandles,
  catalysts,
  machineState = 'Normal',
}) {
  const price = evaluatePriceSignals(candles);
  const catalyst = signalCatalyst(catalysts);
  const rs = signalRelativeStrength(candles, refCandles);

  const breakdown = { ...price.breakdown, catalyst, rs };

  // All 4 hard signals must pass
  if (!price.passed || !catalyst.passed) {
    return { passed: false, breakdown, reason: firstFailure(breakdown) };
  }

  // In Slow mode: smart_money catalyst is required (not just any catalyst)
  if (machineState === 'Slow') {
    const hasSM = catalyst.catalysts_active.some(c => c.type === 'smart_money');
    if (!hasSM) {
      return { passed: false, breakdown, reason: 'slow_mode_requires_smart_money' };
    }
  }

  return {
    passed: true,
    breakdown,
    setup_id: setupId(breakdown),
    booster_active: rs.passed,
  };
}

function firstFailure(breakdown) {
  for (const [name, signal] of Object.entries(breakdown)) {
    if (!signal.passed && name !== 'rs') return `${name}_failed`;
  }
  return 'unknown';
}

export default {
  sma,
  lastPrice,
  completedCandles,
  signalTrend,
  signalMomentum,
  signalNotExtended,
  signalCatalyst,
  signalRelativeStrength,
  evaluatePriceSignals,
  evaluateEntry,
  setupId,
};
