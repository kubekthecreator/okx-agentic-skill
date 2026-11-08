// paper.js + the Donchian helpers in signals.js (H-F1 replay). Pure, offline.
// Run: npm test

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { channel, turtleN } from '../signals.js';
import { fee, fillPrice, fundingPayment, liqPrice, simulate } from '../paper.js';

globalThis.fetch = () => { throw new Error('network is off in unit tests'); };

const near = (a, b, eps = 1e-6) => assert.ok(Math.abs(a - b) < eps, `${a} != ${b}`);

test('fillPrice: buys fill higher, sells lower', () => {
  near(fillPrice('buy', 100, 3), 100.03);
  near(fillPrice('sell', 100, 3), 99.97);
});

test('fee: notional x rate', () => {
  near(fee(10000, 0.0005), 5);
});

test('liqPrice: long and short at 1x / 3x / 10x, mmr 0.5%', () => {
  const lp = (dir, leverage) => liqPrice({ dir, entryPx: 100, leverage, mmr: 0.005 });
  near(lp('long', 1), 0.5);
  near(lp('long', 3), 100 * (1 - 1 / 3 + 0.005));
  near(lp('long', 3), 67.1666667);
  near(lp('long', 10), 90.5);
  near(lp('short', 1), 199.5);
  near(lp('short', 3), 132.8333333);
  near(lp('short', 10), 109.5);
});

test('fundingPayment: signed from our side (negative = we pay)', () => {
  const f = (dir, rate) => fundingPayment({ dir, qty: 2, entryPx: 100, rate });
  near(f('long', 0.0001), -0.02);
  near(f('long', -0.0001), 0.02);
  near(f('short', 0.0001), 0.02);
  near(f('short', -0.0001), -0.02);
});

const bar = (high, low, close) => ({ high, low, close });

test('turtleN: seed = mean of first TRs (TR0 = high - low), then Wilder recursion', () => {
  // period 2. TR0 = 10-8 = 2. TR1 = max(2, |11-9|, |9-9|) = 2 -> seed N1 = 2.
  // TR2 = max(3, |13-10|, |10-10|) = 3 -> N2 = (1*2 + 3)/2 = 2.5.
  // TR3 = max(1, |12-12|, |11-12|) = 1 -> N3 = (1*2.5 + 1)/2 = 1.75.
  const c = [bar(10, 8, 9), bar(11, 9, 10), bar(13, 10, 12), bar(12, 11, 11.5)];
  assert.deepEqual(turtleN(c, 2), [null, 2, 2.5, 1.75]);
});

test('channel: looks at the lookback bars BEFORE i, never bar i itself', () => {
  const c = [bar(5, 1, 3), bar(6, 2, 4), bar(7, 3, 5), bar(99, -99, 0)];
  assert.deepEqual(channel(c, 3, 2), { high: 7, low: 2 }); // bars 1 and 2
  assert.deepEqual(channel(c, 2, 2), { high: 6, low: 1 }); // bars 0 and 1
  assert.equal(channel(c, 1, 2), null);
});

// ─── simulate: hand-checkable run ─────────────────────────────────────────
// Rule: entry 3, exit 2, ATR period 3, stop 2N. Leverage 10, fee 0.1 %,
// slippage 0, mmr 0.5 %, sleeve equity 1000, one bar = one day (ts = i * DAY).
// Every bar has TR = 2 until bar 11, so N = 2 and the stop is 4 away.
//
// idx  open high  low close
//  0   100  101   99  100   warm-up
//  1   100  101   99  100
//  2   100  101   99  100
//  3   100  102  100  102   close > max high(0..2)=101 -> long signal, N=2
//  4   102  104  102  104   LONG fills 102 at the open. stop 98, liq 102*0.905=92.31
//  5   104  106  104  106
//  6   106  108  106  108
//  7   108  108  106  106   close 106 vs min low(5,6)=104: no exit
//  8   106  106  104  104   close 104 < min low(6,7)=106 -> exit signal
//                           (short signal? 104 < min low(5..7)=104 is false: no reversal)
//  9   104  104  102  102   channel exit fills at this open = 104.
//                           close 102 < min low(6..8)=104 -> short signal, N=2
// 10   102  102  100  100   SHORT fills 102. stop 106, liq 102*1.095=111.69
// 11   107  108  106 107.5  gap: opens 107, above the stop 106 -> stop fills at the open 107.
//                           TR = 8, N = (2*2+8)/3 = 4. close 107.5 > max high(8..10)=106 -> long signal
// 12   108  109  107  108   LONG fills 108. stop 108-8=100, liq 108*0.905=97.74
// 13   107  107   90   92   low 90 reaches BOTH the stop (100) and the liq (97.74):
//                           the worse one (liquidation, whole margin) is booked
// 14    92  111   92  110   long signal (110 > 109) but the sleeve is at zero
// 15   110  111  109  110   no entry
//
// Funding (rate x qty x entryPx; the long's notional is 10 * E):
//   t=4D  +0.001  at the long's entry fill time: NOT counted (strictly after)
//   t=6D  +0.0001 long pays 0.0001 * 10000 = -1
//   t=9D  +0.0001 at the exit fill time: counted, -1
//   t=10D +0.0002 at the short's entry fill time: NOT counted
//   t=11D -0.0002 short with a negative rate pays: -0.0002 * notional_B
const DAY = 86400000;
const rows = [
  [100, 101, 99, 100], [100, 101, 99, 100], [100, 101, 99, 100], [100, 102, 100, 102],
  [102, 104, 102, 104], [104, 106, 104, 106], [106, 108, 106, 108], [108, 108, 106, 106],
  [106, 106, 104, 104], [104, 104, 102, 102], [102, 102, 100, 100], [107, 108, 106, 107.5],
  [108, 109, 107, 108], [107, 107, 90, 92], [92, 111, 92, 110], [110, 111, 109, 110],
];
const candles = rows.map(([open, high, low, close], i) => ({ ts: i * DAY, open, high, low, close, volume_usd: 1 }));
const funding = [
  { ts: 4 * DAY, rate: 0.001 }, { ts: 6 * DAY, rate: 0.0001 }, { ts: 9 * DAY, rate: 0.0001 },
  { ts: 10 * DAY, rate: 0.0002 }, { ts: 11 * DAY, rate: -0.0002 },
];
const base = {
  candles,
  funding,
  rule: { entry_lookback: 3, exit_lookback: 2, atr_period: 3, stop_atr_mult: 2 },
  leverage: 10,
  costs: { taker_fee_per_side: 0.001, slippage_bps_per_side: 0, maintenance_margin_rate: 0.005 },
  startMs: 0,
  endMs: 16 * DAY,
  startEquity: 1000,
};

test('simulate: channel exit, gap stop, liquidation, zero sleeve stops trading', () => {
  const { trades, equity } = simulate(base);
  assert.equal(trades.length, 3);

  // A: long, qty = 10000/102 = 98.0392157. Fees 10 + 0.001*qty*104 = 10.1960784.
  // Price pnl = qty*(104-102) = 196.0784314. Funding -2. Net = 173.8823529.
  const [a, b, c] = trades;
  assert.equal(a.dir, 'long');
  assert.equal(a.reason, 'channel');
  assert.equal(a.entryTs, 4 * DAY);
  assert.equal(a.exitTs, 9 * DAY);
  near(a.entryPx, 102);
  near(a.exitPx, 104);
  near(a.qty, 98.0392157);
  near(a.fees, 20.1960784);
  near(a.funding, -2);
  near(a.pnl, 173.8823529);
  near(a.ret, 0.1738823529);

  // B: short with E = 1173.8823529, notional 11738.823529, qty = 115.0865052.
  // Stop gap fill 107: price pnl = qty*(102-107) = -575.4325260.
  // Fees 11.7388235 + 0.001*qty*107 (12.3142561) = 24.0530796.
  // Funding = -0.0002 * 11738.823529 = -2.3477647. Net = -601.8333702.
  assert.equal(b.dir, 'short');
  assert.equal(b.reason, 'stop');
  assert.equal(b.entryTs, 10 * DAY);
  assert.equal(b.exitTs, 12 * DAY); // stop time = close of the bar it hit
  near(b.entryPx, 102);
  near(b.exitPx, 107); // the open, not the 106 stop
  near(b.fees, 24.0530796);
  near(b.funding, -2.3477647);
  near(b.pnl, -601.8333702);
  near(b.ret, -601.8333702 / 1173.8823529);

  // C: long with E = 572.0489827. Liquidation books the whole margin.
  assert.equal(c.dir, 'long');
  assert.equal(c.reason, 'liquidation');
  assert.equal(c.entryTs, 12 * DAY);
  near(c.entryPx, 108);
  near(c.exitPx, 97.74);
  near(c.pnl, -572.0489827);
  near(c.ret, -1);

  // Mark-to-market at every bar close inside the sample.
  assert.equal(equity.length, 16);
  near(equity[3].value, 1000); // flat
  near(equity[4].value, 990 + 98.0392157 * 2); // entry fee paid, +2 unrealized: 1186.0784314
  near(equity[8].value, 988 + 98.0392157 * 2); // funding at 6D and 9D accrued by this close
  near(equity[9].value, 1173.8823529);
  near(equity[13].value, 0);
  near(equity[15].value, 0);
});

test('simulate: no entry before startMs', () => {
  // Fills at bar 4 and 5 opens are before startMs; the first allowed signal
  // is bar 5 (106 > max high(2..4)=104), filling at the bar-6 open = 106.
  const { trades } = simulate({ ...base, startMs: 5 * DAY + 1 });
  assert.equal(trades[0].entryTs, 6 * DAY);
  near(trades[0].entryPx, 106);
  for (const t of trades) assert.ok(t.entryTs >= 5 * DAY + 1);
});

test('simulate: open position is closed at the last close of the sample', () => {
  // endMs = 7D: bars 0..6, long open from bar 4 at 102, last close 108.
  // qty*(108-102) = 588.2352941; fees 10 + 0.001*qty*108 (10.5882353); funding at 6D = -1.
  const { trades } = simulate({ ...base, endMs: 7 * DAY });
  assert.equal(trades.length, 1);
  assert.equal(trades[0].reason, 'end');
  assert.equal(trades[0].exitTs, 7 * DAY);
  near(trades[0].exitPx, 108);
  near(trades[0].pnl, 588.2352941 - 10 - 10.5882353 - 1);
});

// ─── simulate: small series for reversal, short liquidation, stop price, slippage ──
// Rule: lookbacks 2 / 2, ATR period 2, stop 2N. Fee 0.1 %, mmr 0.5 %, equity 1000.
// Series R (long, then reversal):
//  0  100 101  99  100   TR0 = 2
//  1  100 101  99  100   TR1 = 2 -> seed N = 2
//  2  100 103 100  103   close > max high(0,1)=101 -> long signal. TR = 3, N = (2+3)/2 = 2.5
//  3  103 104 102  103   LONG fills 103. stop 103 - 5 = 98. qty = 1000/103 (leverage 1)
//  4  103 103 98.5  99   low 98.5 > stop 98. close 99 < min low(2,3)=100: exit AND short signal
//                        (equal lookbacks). TR = 4.5, N = (2.5+4.5)/2 = 3.5
//  5   99 100  98   99   at this open: long exits at 99 and the short fills 99 (same open)
const rule2 = { entry_lookback: 2, exit_lookback: 2, atr_period: 2, stop_atr_mult: 2 };
const costs0 = { taker_fee_per_side: 0.001, slippage_bps_per_side: 0, maintenance_margin_rate: 0.005 };
const mk = (rs) => rs.map(([open, high, low, close], i) => ({ ts: i * DAY, open, high, low, close, volume_usd: 1 }));
const sim = (rs, over) =>
  simulate({ candles: mk(rs), funding: [], rule: rule2, leverage: 1, costs: costs0, startMs: 0, endMs: rs.length * DAY, startEquity: 1000, ...over });
const R = [[100, 101, 99, 100], [100, 101, 99, 100], [100, 103, 100, 103], [103, 104, 102, 103], [103, 103, 98.5, 99], [99, 100, 98, 99]];

test('simulate: exit and opposite entry at the same open (reversal)', () => {
  const { trades } = sim(R);
  assert.equal(trades.length, 2);
  const [long, short] = trades;
  // Long: qty = 1000/103 = 9.7087379. Price pnl = qty*(99-103) = -38.8349515.
  // Fees 1 + 0.001*qty*99 (0.9611650) = 1.9611650. Net = -40.7961165, equity after = 959.2038835.
  assert.equal(long.reason, 'channel');
  assert.equal(long.exitTs, 5 * DAY);
  near(long.exitPx, 99);
  near(long.pnl, -40.7961165);
  // Short: opens at the same ts, notional = 959.2038835, fills 99. Closed at the end (bar 5 close 99):
  // price pnl 0, fees 2 * 0.001 * 959.2038835 = 1.9184078.
  assert.equal(short.dir, 'short');
  assert.equal(short.entryTs, 5 * DAY);
  near(short.entryPx, 99);
  assert.equal(short.reason, 'end');
  near(short.pnl, -1.9184078);
});

test('simulate: short liquidation books the whole margin', () => {
  // 0,1 flat; 2: 100 100 97 97 close < min low(0,1)=99 -> short signal, TR 3, N 2.5.
  // 3: 97 98 96 97 short fills 97 at 10x: notional 10000, fee 10, stop 97+5=102, liq 97*(1+0.1-0.005)=106.215.
  // 4: 97 110 97 109 high 110 reaches both stop and liq -> liquidation at 106.215, pnl = -1000.
  const S = [[100, 101, 99, 100], [100, 101, 99, 100], [100, 100, 97, 97], [97, 98, 96, 97], [97, 110, 97, 109]];
  const { trades, equity } = sim(S, { leverage: 10 });
  assert.equal(trades.length, 1);
  assert.equal(trades[0].dir, 'short');
  assert.equal(trades[0].reason, 'liquidation');
  near(trades[0].exitPx, 106.215);
  near(trades[0].fees, 10);
  near(trades[0].pnl, -1000);
  near(trades[0].ret, -1);
  near(equity[4].value, 0);
});

test('simulate: stop fills at the stop price when the bar does not gap through it', () => {
  // Series R bars 0..3, then bar 4: open 103 (above stop 98), low 95 -> fills at 98, not at the open or low.
  // qty = 1000/103. Price pnl = qty*(98-103) = -48.5436893. Fees 1 + 0.001*qty*98 (0.9514563).
  // Net = -50.4951456.
  const { trades } = sim([...R.slice(0, 4), [103, 103, 95, 96]]);
  assert.equal(trades.length, 1);
  assert.equal(trades[0].reason, 'stop');
  near(trades[0].exitPx, 98);
  near(trades[0].pnl, -50.4951456);
});

test('simulate: slippage 100 bps hurts both sides, long and short', () => {
  const slip = { ...costs0, slippage_bps_per_side: 100 };
  // Long (R bars 0..3, closed at the bar-3 close 103): buy 103*1.01 = 104.03, sell 103*0.99 = 101.97.
  // qty = 1000/104.03. pnl = qty*(101.97-104.03) - 1 - 0.001*qty*101.97.
  const q = 1000 / 104.03;
  const long = sim(R.slice(0, 4), { costs: slip }).trades[0];
  near(long.entryPx, 104.03);
  near(long.exitPx, 101.97);
  near(long.pnl, q * (101.97 - 104.03) - 1 - 0.001 * q * 101.97);
  // Short (bars 0..3 of the liquidation series, closed at the bar-3 close 97): sell 97*0.99 = 96.03, buy 97*1.01 = 97.97.
  // qty = 1000/96.03. pnl = qty*(96.03-97.97) - 1 - 0.001*qty*97.97.
  const S3 = [[100, 101, 99, 100], [100, 101, 99, 100], [100, 100, 97, 97], [97, 98, 96, 97]];
  const q2 = 1000 / 96.03;
  const short = sim(S3, { costs: slip }).trades[0];
  assert.equal(short.dir, 'short');
  near(short.entryPx, 96.03);
  near(short.exitPx, 97.97);
  near(short.pnl, q2 * (96.03 - 97.97) - 1 - 0.001 * q2 * 97.97);
});

test('simulate: refuses an endMs that the data does not reach', () => {
  assert.throws(() => simulate({ ...base, endMs: 40 * DAY }), /endMs/);
});
