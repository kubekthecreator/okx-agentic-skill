// carry.js (H-F2 replay engine): universe, signal, baskets, funding, costs, delisting, liquidation. Pure, offline.
// Run: npm test

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { selectBaskets, selectUniverse, simulateCarry } from '../carry.js';

globalThis.fetch = () => { throw new Error('network is off in unit tests'); };

const near = (a, b, eps = 1e-9) => assert.ok(Math.abs(a - b) < eps, `${a} != ${b}`);
const DAY = 86400000;
const H = 3600000;
const T0 = Date.UTC(2023, 0, 31); // first rebalance day in every test
const costs = { taker_fee_per_side: 0.0005, slippage_bps_per_side: { BTCUSDT: 3, ETHUSDT: 3, others: 10 } };
const RATE = 0.0005 + 0.001; // fee + 10 bp slippage on "others"

// One symbol: `hist` flat candles before T0, then one candle per entry of `opens` (closes default to the next open).
// Funding prints every `step` ms on the UTC grid from 10 days before T0 up to `until`.
function coin({ opens, closes = [], vol = 1e6, volOf = {}, hist = 30, rate = 0, rateOf = () => rate, step = 8 * H, until = T0 + opens.length * DAY, from = T0 - 10 * DAY }) {
  const candles = [];
  for (let i = -hist; i < opens.length; i++) {
    const open = i < 0 ? opens[0] : opens[i];
    const close = i < 0 ? open : (closes[i] ?? opens[i + 1] ?? open);
    candles.push({ ts: T0 + i * DAY, open, high: Math.max(open, close), low: Math.min(open, close), close, quoteVolume: volOf[i] ?? vol });
  }
  const funding = [];
  for (let ts = from; ts <= until; ts += step) funding.push({ ts, rate: rateOf(ts) });
  return { candles, funding };
}

test('universe: needs 30 candles and a funding print in the last 48h; top-N by trailing volume (today excluded)', () => {
  const panel = {
    OK: coin({ opens: [1, 1], vol: 5e6 }),
    SHORT: coin({ opens: [1, 1], hist: 29, vol: 9e6 }), // 29 completed candles
    STALE: coin({ opens: [1, 1], vol: 9e6, until: T0 - 49 * H }), // last print 49h before open
    EDGE: coin({ opens: [1, 1], vol: 4e6, until: T0 - 48 * H }), // print exactly 48h before open: inside
    BIG: coin({ opens: [1, 1], vol: 1e6, volOf: { 0: 1e12 } }), // huge volume TODAY must not count
  };
  const u = selectUniverse(panel, T0, { universe: 10 }).map((m) => m.symbol);
  assert.deepEqual(u, ['OK', 'EDGE', 'BIG']);
  assert.deepEqual(selectUniverse(panel, T0, { universe: 2 }).map((m) => m.symbol), ['OK', 'EDGE']);
  near(selectUniverse(panel, T0, { universe: 10 })[0].vol, 5e6);
});

test('signal: sum of prints in [t-72h, t) / 9; 8h and 4h prints agree; print at t excluded, at t-72h included', () => {
  const at = (ms) => (ts) => (ts === T0 ? 1000 : ts === T0 - 72 * H ? ms : 0);
  // 8h grid: 9 prints in [t-72h, t). Only the t-72h print is non-zero -> 0.0009 / 9.
  const a = selectUniverse({ X: coin({ opens: [1, 1], rateOf: at(0.0009) }) }, T0, { universe: 5 })[0];
  near(a.signal, 0.0001);
  // 4h grid at 0.0001: 18 prints -> 0.0018 / 9 = 0.0002; 8h grid at 0.0002 -> 9 prints -> 0.0002.
  const b = selectUniverse({ X: coin({ opens: [1, 1], step: 4 * H, rate: 0.0001 }) }, T0, { universe: 5 })[0];
  const c = selectUniverse({ X: coin({ opens: [1, 1], rate: 0.0002 }) }, T0, { universe: 5 })[0];
  near(b.signal, 0.0002);
  near(c.signal, 0.0002);
});

test('selectBaskets: short = highest signal, long = lowest, ties by higher volume', () => {
  const m = [
    { symbol: 'A', signal: 3, vol: 1 },
    { symbol: 'B', signal: 3, vol: 9 },
    { symbol: 'C', signal: 1, vol: 2 },
    { symbol: 'D', signal: 1, vol: 8 },
    { symbol: 'E', signal: 2, vol: 5 },
  ];
  assert.deepEqual(selectBaskets(m, 1), { short: ['B'], long: ['D'] });
  assert.deepEqual(selectBaskets(m, 2), { short: ['B', 'A'], long: ['D', 'C'] });
});

// ─── hand-checked run: 4 coins, universe 4, baskets of 1, gross 1x, equity 1000, 3 days ───
// Funding is constant per coin: A +0.0004, B +0.0001, D +0.0002, C -0.0002 per 8h print.
// Signal = rate, so short = A (highest), long = C (lowest), every day. N = 1 * E / 2 / 1.
// Opens (day0..day3): A 100,110,99,99   C 50,55,55,60   (B, D flat at 10)
// Day 0: E0 = 1000 -> N = 500. Short A qty 5, long C qty 10. Cost = (500+500) * 0.0015 = 1.5 (fee 0.5, slip 1.0).
//   price: A -5*(110-100) = -50; C +10*(55-50) = +50 -> 0.
//   funding: prints at t0+8h, +16h, +24h (the print AT t0 excluded, the one at t1 included) = 3 prints.
//   A short receives 3*0.0004*500 = 0.6; C long with rate -0.0002 receives 3*0.0002*500 = 0.3 -> 0.9.
//   E1 = 1000 + 0 + 0.9 - 1.5 = 999.4
// Day 1: N = 999.4/2 = 499.7. Carried A = 5*110 = 550, C = 10*55 = 550. Resize |499.7-550| = 50.3 each -> traded 100.6, cost 0.1509.
//   qty A = 499.7/110, C = 499.7/55. price: A -(499.7/110)*(99-110) = +49.97; C 0 (55 -> 55). funding 3 prints:
//   3*0.0004*499.7 + 3*0.0002*499.7 = 0.0018*499.7 = 0.89946.
//   E2 = 999.4 + 49.97 + 0.89946 - 0.1509 = 1050.11856
// Day 2: N = 525.05928. Carried A = (499.7/110)*99 = 449.73, C = (499.7/55)*55 = 499.7.
//   traded |525.05928-449.73| + |525.05928-499.7| = 75.32928 + 25.35928 = 100.68856 -> cost 0.15103284.
//   price: A 0 (99 -> 99); C +(525.05928/55)*(60-55) = 47.73266...; funding 0.0018*525.05928 = 0.945106704.
//   E3 = 1050.11856 + 47.7326618... + 0.945106704 - 0.15103284
test('hand-checked 4-coin x 3-day run: funding signs, window edges, resize cost', () => {
  const rates = { A: 0.0004, B: 0.0001, D: 0.0002, C: -0.0002 };
  const px = { A: [100, 110, 99, 99], B: [10, 10, 10, 10], C: [50, 55, 55, 60], D: [10, 10, 10, 10] };
  const panel = Object.fromEntries(Object.keys(rates).map((s) => [s, coin({ opens: px[s], rate: rates[s], until: T0 + 4 * DAY })]));
  const r = simulateCarry({ panel, rule: { universe: 4, basket: 1 }, costs, gross: 1, startMs: T0, endMs: T0 + 3 * DAY, startEquity: 1000 });
  assert.equal(r.liquidated, false);
  assert.equal(r.days.length, 3);
  near(r.days[0].costs, 1.5);
  near(r.days[0].pricePnl, 0);
  near(r.days[0].funding, 0.9);
  near(r.equity[1].value, 999.4);
  near(r.days[0].ret, -0.0006);
  assert.equal(r.days[0].held, 2);
  near(r.days[1].costs, 0.1509);
  near(r.days[1].pricePnl, 49.97);
  near(r.days[1].funding, 0.89946);
  near(r.equity[2].value, 1050.11856);
  near(r.days[2].costs, 0.15103284);
  const pnlC = (525.05928 / 55) * 5;
  near(r.days[2].pricePnl, pnlC, 1e-9);
  near(r.equity[3].value, 1050.11856 + pnlC + 0.945106704 - 0.15103284, 1e-9);
  assert.deepEqual(r.equity.map((e) => e.ts), [T0, T0 + DAY, T0 + 2 * DAY, T0 + 3 * DAY]);
});

test('delisting: held name with no next candle closes at its last close -10%/+10% adverse, with exit costs', () => {
  const rates = { A: 0.0004, B: 0.0001, D: 0.0002, C: -0.0002 };
  const px = { A: [100, 100, 100], B: [10, 10, 10], C: [50, 50, 50], D: [10, 10, 10] };
  const panel = Object.fromEntries(Object.keys(rates).map((s) => [s, coin({ opens: px[s], closes: s === 'C' ? [52] : [], rate: rates[s] })]));
  panel.C.candles = panel.C.candles.filter((c) => c.ts <= T0); // C's last candle is day 0 (close 52)
  const r = simulateCarry({ panel, rule: { universe: 4, basket: 1 }, costs, gross: 1, startMs: T0, endMs: T0 + DAY, startEquity: 1000 });
  // long C: qty 10 opened at 50, exits at 52 * 0.9 = 46.8 -> -32; short A flat. Funding: 0.9 as in the hand run.
  // Costs: entries 1000 * 0.0015 = 1.5 + exit 10 * 46.8 * 0.0015 = 0.702.
  near(r.days[0].pricePnl, -32);
  near(r.days[0].costs, 1.5 + 0.702);
  near(r.equity[1].value, 1000 - 32 + 0.9 - 2.202);
});

test('delisting of a short closes 10% higher (adverse for a short)', () => {
  const rates = { A: 0.0004, B: 0.0001, D: 0.0002, C: -0.0002 };
  const px = { A: [100, 100, 100], B: [10, 10, 10], C: [50, 50, 50], D: [10, 10, 10] };
  const panel = Object.fromEntries(Object.keys(rates).map((s) => [s, coin({ opens: px[s], closes: s === 'A' ? [90] : [], rate: rates[s] })]));
  panel.A.candles = panel.A.candles.filter((c) => c.ts <= T0);
  const r = simulateCarry({ panel, rule: { universe: 4, basket: 1 }, costs, gross: 1, startMs: T0, endMs: T0 + DAY, startEquity: 1000 });
  near(r.days[0].pricePnl, -5 * (99 - 100)); // exit 90 * 1.1 = 99: short qty 5 gains 5
});

test('liquidation: equity at the close (after costs, before funding) <= 0.5% of gross ends the run at zero', () => {
  // gross 3 -> N = 1500 per leg. Both legs lose 40% by the close: -1200 vs equity 1000 - costs.
  const panel = {
    A: coin({ opens: [100, 140, 140], closes: [140], rate: 0.0004 }),
    B: coin({ opens: [10, 10, 10], rate: 0.0001 }),
    D: coin({ opens: [10, 10, 10], rate: 0.0002 }),
    C: coin({ opens: [50, 30, 30], closes: [30], rate: -0.0002 }),
  };
  const r = simulateCarry({ panel, rule: { universe: 4, basket: 1 }, costs, gross: 3, startMs: T0, endMs: T0 + 2 * DAY, startEquity: 1000 });
  assert.equal(r.liquidated, true);
  assert.equal(r.equity.at(-1).value, 0);
  assert.equal(r.equity.length, 2); // run ends at zero: no further days
});

test('fewer than 2 x basket names in the universe: stay flat (equity only moves by nothing)', () => {
  const panel = { A: coin({ opens: [100, 110] }), B: coin({ opens: [10, 10] }) };
  const r = simulateCarry({ panel, rule: { universe: 4, basket: 2 }, costs, gross: 1, startMs: T0, endMs: T0 + DAY, startEquity: 1000 });
  assert.equal(r.days[0].held, 0);
  near(r.equity[1].value, 1000);
});

// ─── liquidation threshold ───
// gross 3, equity 1000 -> N = 1500 per leg: short A qty 15 (open 100), long C qty 30 (open 50, flat).
// Entry costs 3000 * 0.0015 = 4.5 -> equity after costs 995.5. Threshold 0.005 * 3000 = 15.
// A closes at 165.4: unrealised -15 * 65.4 = -981 -> 14.5 <= 15: liquidated although still positive.
// A closes at 165.2: -15 * 65.2 = -978 -> 17.5 > 15: survives (next equity 1000 - 978 + funding - 4.5 > 0).
const liqRun = (aClose) => {
  const panel = {
    A: coin({ opens: [100, aClose, aClose], closes: [aClose], rate: 0.0004 }),
    B: coin({ opens: [10, 10, 10], rate: 0.0001 }),
    D: coin({ opens: [10, 10, 10], rate: 0.0002 }),
    C: coin({ opens: [50, 50, 50], rate: -0.0002 }),
  };
  return simulateCarry({ panel, rule: { universe: 4, basket: 1 }, costs, gross: 3, startMs: T0, endMs: T0 + DAY, startEquity: 1000 });
};

test('liquidation threshold: positive equity at or below 0.5% of gross liquidates, just above survives', () => {
  const dead = liqRun(165.4);
  assert.equal(dead.liquidated, true);
  assert.equal(dead.equity.at(-1).value, 0);
  const alive = liqRun(165.2);
  assert.equal(alive.liquidated, false);
  assert.ok(alive.equity.at(-1).value > 0);
});

// ─── flip + leaving + entering ───
// All prices 100, so price PnL is 0. Rates per 8h print: Y +0.0003, Z -0.0001, W +0.0001 (constant);
// X is -0.0004 before T0 and +0.002 from T0. Day 0 signals: X -0.0004 (lowest), Y 0.0003 (highest) -> long X, short Y.
// Day 1 signal X = (6 * -0.0004 + 3 * 0.002) / 9 = 0.0004 (highest), Z -0.0001 lowest -> short X, long Z, Y leaves.
// Day 0: E = 1000, N = 500, cost 1000 * 0.0015 = 1.5. Funding (3 prints): X long pays 3 * 0.002 * 500 = 3.0,
//   Y short receives 3 * 0.0003 * 500 = 0.45 -> -2.55. E1 = 1000 - 1.5 - 2.55 = 995.95.
// Day 1: N = 497.975. X flips: traded carried 500 + target 497.975 = 997.975; Y leaves: 500; Z enters: 497.975.
//   traded = 1995.95, cost = 1995.95 * 0.0015 = 2.993925.
test('direction flip, name leaving and name entering: costs on carried + target', () => {
  const rates = { Y: 0.0003, Z: -0.0001, W: 0.0001 };
  const panel = Object.fromEntries(Object.entries(rates).map(([s, rate]) => [s, coin({ opens: [100, 100, 100], rate })]));
  panel.X = coin({ opens: [100, 100, 100], rateOf: (ts) => (ts >= T0 ? 0.002 : -0.0004) });
  const r = simulateCarry({ panel, rule: { universe: 4, basket: 1 }, costs, gross: 1, startMs: T0, endMs: T0 + 2 * DAY, startEquity: 1000 });
  near(r.days[0].costs, 1.5);
  near(r.days[0].funding, -2.55);
  near(r.equity[1].value, 995.95);
  near(r.days[1].traded, 1995.95);
  near(r.days[1].costs, 2.993925);
  assert.equal(r.days[1].held, 2);
});

// ─── long and short delisted on the same day ───
// Day 0: short A qty 5 (open 100, last close 90), long C qty 10 (open 50, last close 52). Neither has a candle on day 1.
// A exits at 90 * 1.1 = 99: short gains 5 * 1 = +5, exit cost 5 * 99 * 0.0015 = 0.7425.
// C exits at 52 * 0.9 = 46.8: long loses 10 * 3.2 = -32, exit cost 10 * 46.8 * 0.0015 = 0.702.
// Entry cost 1.5; funding 0.9 (as the hand run). E1 = 1000 + 5 - 32 + 0.9 - (1.5 + 0.7425 + 0.702) = 970.9555.
test('long and short delisted on the same day', () => {
  const rates = { A: 0.0004, B: 0.0001, D: 0.0002, C: -0.0002 };
  const closes = { A: [90], C: [52] };
  const px0 = { A: 100, B: 10, C: 50, D: 10 };
  const panel = Object.fromEntries(Object.entries(rates).map(([s, rate]) => [s, coin({ opens: [px0[s], 100, 100], closes: closes[s] ?? [], rate })]));
  for (const s of ['A', 'C']) panel[s].candles = panel[s].candles.filter((c) => c.ts <= T0);
  const r = simulateCarry({ panel, rule: { universe: 4, basket: 1 }, costs, gross: 1, startMs: T0, endMs: T0 + DAY, startEquity: 1000 });
  near(r.days[0].pricePnl, -27);
  near(r.days[0].costs, 2.9445);
  near(r.equity[1].value, 970.9555);
  assert.deepEqual(r.days[0].delisted.map((d) => `${d.symbol}:${d.side}`).sort(), ['A:short', 'C:long']);
});
