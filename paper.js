// paper.js — pure perp-trading maths for the H-F1 replay (docs/prereg/H-F1.json).
// No I/O. One instrument = one isolated-margin sleeve.

import { channel, turtleN } from './signals.js';

// side is 'buy' | 'sell': buys fill higher, sells fill lower.
export function fillPrice(side, px, slipBps) {
  return px * (1 + ((side === 'buy' ? 1 : -1) * slipBps) / 10000);
}

export function fee(notional, rate) {
  return notional * rate;
}

export function liqPrice({ dir, entryPx, leverage, mmr }) {
  return dir === 'long' ? entryPx * (1 - 1 / leverage + mmr) : entryPx * (1 + 1 / leverage - mmr);
}

// Signed from OUR side: negative = we pay. Longs pay a positive rate, shorts receive it.
export function fundingPayment({ dir, qty, entryPx, rate }) {
  const p = rate * qty * entryPx;
  return dir === 'long' ? -p : p;
}

// candles: ascending, includes warm-up bars. funding: ascending [{ ts, rate }].
// rule / costs use the prereg field names. Bars with ts in [startMs, endMs) are
// the sample; the open position is closed at the last in-sample close.
export function simulate({ candles, funding, rule, leverage, costs, startMs, endMs, startEquity }) {
  const feeRate = costs.taker_fee_per_side;
  const slip = costs.slippage_bps_per_side;
  const mmr = costs.maintenance_margin_rate;
  const N = turtleN(candles, rule.atr_period);
  const barMs = candles.length > 1 ? candles[1].ts - candles[0].ts : 0;
  const lastIn = candles.findLast((c) => c.ts < endMs);
  if (!lastIn || lastIn.ts + barMs !== endMs) throw new Error('last in-sample candle does not end at endMs: data is short or endMs is misaligned');
  const trades = [];
  const equity = [];
  let cash = startEquity;
  let pos = null;
  let pending = null; // { dir: 'long'|'short'|null, n } executes at the next open
  let fi = 0; // next funding event not yet applied to pos

  const accrue = (t) => {
    while (fi < funding.length && funding[fi].ts <= t) {
      const p = fundingPayment({ dir: pos.dir, qty: pos.qty, entryPx: pos.entryPx, rate: funding[fi].rate });
      cash += p;
      pos.funding += p;
      fi++;
    }
  };

  const enter = (dir, c, n) => {
    const px = fillPrice(dir === 'long' ? 'buy' : 'sell', c.open, slip);
    const notional = leverage * cash;
    const entryFee = fee(notional, feeRate);
    pos = {
      dir,
      entryTs: c.ts,
      entryPx: px,
      qty: notional / px,
      equity0: cash,
      fee: entryFee,
      funding: 0,
      stop: dir === 'long' ? px - rule.stop_atr_mult * n : px + rule.stop_atr_mult * n,
      liq: liqPrice({ dir, entryPx: px, leverage, mmr }),
    };
    cash -= entryFee;
    fi = funding.findIndex((f) => f.ts > c.ts); // strictly after the entry fill
    if (fi < 0) fi = funding.length;
  };

  const book = (exitPx, ts, reason, exitFee) => {
    const pnl = cash - pos.equity0;
    trades.push({
      dir: pos.dir,
      entryTs: pos.entryTs,
      entryPx: pos.entryPx,
      exitTs: ts,
      exitPx,
      qty: pos.qty,
      reason,
      fees: pos.fee + exitFee,
      funding: pos.funding,
      pnl,
      ret: pnl / pos.equity0,
    });
    pos = null;
  };

  const exit = (basePx, ts, reason) => {
    accrue(ts);
    const px = fillPrice(pos.dir === 'long' ? 'sell' : 'buy', basePx, slip);
    const exitFee = fee(pos.qty * px, feeRate);
    cash += (pos.dir === 'long' ? 1 : -1) * pos.qty * (px - pos.entryPx) - exitFee;
    book(px, ts, reason, exitFee);
  };

  for (let i = 0; i < candles.length; i++) {
    const c = candles[i];
    if (c.ts >= endMs) break;
    const inSample = c.ts >= startMs;
    const closeTs = c.ts + barMs;
    const last = i === candles.length - 1 || candles[i + 1].ts >= endMs;

    if (pending) {
      if (pos) exit(c.open, c.ts, 'channel');
      if (pending.dir && inSample && cash > 0) enter(pending.dir, c, pending.n);
      pending = null;
    }

    if (pos) {
      const long = pos.dir === 'long';
      const liqHit = long ? c.low <= pos.liq : c.high >= pos.liq;
      const stopHit = long ? c.low <= pos.stop : c.high >= pos.stop;
      // Both reachable in one bar: liquidation (whole margin) is never better than
      // a stop inside the margin, so it is the worse result and the one booked.
      if (liqHit) {
        accrue(closeTs);
        cash = 0;
        book(long ? Math.min(c.open, pos.liq) : Math.max(c.open, pos.liq), closeTs, 'liquidation', 0);
      } else if (stopHit) {
        exit(long ? Math.min(c.open, pos.stop) : Math.max(c.open, pos.stop), closeTs, 'stop');
      }
    }

    if (pos) accrue(closeTs);
    if (pos && last) exit(c.close, closeTs, 'end');
    if (inSample) {
      const unreal = pos ? (pos.dir === 'long' ? 1 : -1) * pos.qty * (c.close - pos.entryPx) : 0;
      equity.push({ ts: c.ts, value: cash + unreal });
    }
    if (last) continue;

    // Signals on the closed bar; they execute at the next open.
    const n = N[i];
    const entryCh = channel(candles, i, rule.entry_lookback);
    const exitCh = channel(candles, i, rule.exit_lookback);
    if (n === null || !entryCh || !exitCh) continue;
    const longSig = c.close > entryCh.high;
    const shortSig = c.close < entryCh.low;
    if (!pos) {
      if (longSig) pending = { dir: 'long', n };
      else if (shortSig) pending = { dir: 'short', n };
    } else if (pos.dir === 'long' && c.close < exitCh.low) {
      pending = { dir: shortSig ? 'short' : null, n };
    } else if (pos.dir === 'short' && c.close > exitCh.high) {
      pending = { dir: longSig ? 'long' : null, n };
    }
  }
  return { trades, equity };
}
