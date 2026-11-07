// scripts/replay.js — H-F1 historical replay (docs/prereg/H-F1.json). Stage A.
// Public data only; no keys, no orders. Run: node scripts/replay.js [--refresh]
// Cache and outputs: data/replay/

import fs from 'node:fs';
import { fileURLToPath } from 'node:url';

import { getCandles, getFunding, getTbill } from '../market.js';
import { maxDrawdown, simulate, tbillGrowth } from '../paper.js';

const root = new URL('..', import.meta.url);
const prereg = JSON.parse(fs.readFileSync(new URL('docs/prereg/H-F1.json', root), 'utf-8'));
const outDir = fileURLToPath(new URL('data/replay/', root));
fs.mkdirSync(outDir, { recursive: true });
const refresh = process.argv.includes('--refresh');

const DAY = 86400000;
const day = (s) => Date.parse(`${s}T00:00:00Z`);
const iso = (ms) => new Date(ms).toISOString().slice(0, 10);
const startMs = day(prereg.sample.start);
const endMs = day(prereg.sample.end) + DAY; // exclusive: the whole last day
const fetchFrom = prereg.data.fetch_from.slice(0, 10); // the prereg value carries a trailing note
const total = prereg.sizing.starting_equity_usd;
const insts = prereg.instruments.price_proxy;
const bars = [{ label: '1D', okx: '1Dutc' }, { label: '4H', okx: '4H' }];
const levs = [...prereg.sizing.leverage_runs, ...prereg.sizing.counterfactual_runs];

// Cache entries remember the range they were fetched for; a mismatch is an error, never a silent reuse.
async function cached(name, from, to, fn) {
  const file = `${outDir}${name}.json`;
  if (!refresh && fs.existsSync(file)) {
    const c = JSON.parse(fs.readFileSync(file, 'utf-8'));
    if (c.startMs !== from || c.endMs !== to) {
      throw new Error(`cache ${name} covers ${c.startMs}..${c.endMs}, requested ${from}..${to}: re-run with --refresh`);
    }
    return c.rows;
  }
  const rows = await fn();
  fs.writeFileSync(file, JSON.stringify({ startMs: from, endMs: to, fetchedAt: new Date().toISOString(), rows }));
  return rows;
}

const data = { candles: {}, funding: {} };
for (const id of insts) {
  for (const b of bars) {
    data.candles[`${id}|${b.label}`] = await cached(`candles-${id}-${b.label}`, day(fetchFrom), endMs, () => getCandles(id, b.okx, day(fetchFrom), endMs));
  }
  data.funding[id] = await cached(`funding-${id}`, startMs, endMs, () => getFunding(id, `${id.split('-')[0]}USDT`, startMs, endMs));
}
const tbill = await cached('tbill', day(fetchFrom), endMs, () => getTbill(fetchFrom, prereg.sample.end));

// One run = three sleeves (total / 3 each) over [from, to).
function run(bar, leverage, from = startMs, to = endMs, equity0 = total) {
  const sleeves = {};
  for (const id of insts) {
    sleeves[id] = simulate({
      candles: data.candles[`${id}|${bar}`],
      funding: data.funding[id],
      rule: prereg.rule,
      leverage,
      costs: prereg.costs,
      startMs: from,
      endMs: to,
      startEquity: equity0 / insts.length,
    });
  }
  // Portfolio = sum of sleeves at each ts; a sleeve with no bar there carries its last value.
  const maps = insts.map((id) => new Map(sleeves[id].equity.map((e) => [e.ts, e.value])));
  const last = insts.map(() => equity0 / insts.length);
  const stamps = [...new Set(insts.flatMap((id) => sleeves[id].equity.map((e) => e.ts)))].sort((a, b) => a - b);
  const portfolio = stamps.map((ts) => {
    maps.forEach((m, k) => {
      if (m.has(ts)) last[k] = m.get(ts);
    });
    return { ts, value: last.reduce((a, b) => a + b, 0) };
  });
  const trades = insts.flatMap((id) => sleeves[id].trades.map((t) => ({ inst: id, ...t })));
  return { bar, leverage, sleeves, portfolio, trades, equity0 };
}

const finalValue = (r) => (r.portfolio.length ? r.portfolio[r.portfolio.length - 1].value : r.equity0);
const growth = (r) => finalValue(r) / r.equity0 - 1;
const valueBefore = (r, ms) => r.portfolio.filter((p) => p.ts < ms).at(-1)?.value ?? r.equity0;

// K-A1..K-A5 for one bar size.
function criteria(bar) {
  const r1 = run(bar, 1);
  const r3 = run(bar, 3);
  const rets = r1.trades.map((t) => t.ret).sort((a, b) => b - a);
  const exTop5 = rets.slice(5).reduce((p, x) => p * (1 + x), 1) - 1;
  const [h1, h2] = prereg.sample.halves;
  const mid = day(h1[1]) + DAY;
  const half1 = valueBefore(r1, mid) / total - 1;
  const half2 = finalValue(r1) / valueBefore(r1, mid) - 1;
  // Alternative reading of K-A5: each half as its own run from fresh equity.
  const alt1 = growth(run(bar, 1, day(h1[0]), mid));
  const alt2 = growth(run(bar, 1, mid, day(h2[1]) + DAY));
  const bill = tbillGrowth(tbill, startMs, endMs);
  const k = {
    'K-A1': { portfolio: growth(r1), tbill: bill, kill: growth(r1) <= bill },
    'K-A2': { exTop5Product: exTop5, kill: exTop5 <= 0 },
    'K-A3': { maxDD3x: maxDrawdown(r3.portfolio, r3.equity0), kill: maxDrawdown(r3.portfolio, r3.equity0) > 0.3 },
    'K-A4': { trades: r1.trades.length, kill: r1.trades.length < 60 },
    'K-A5': { half1, half2, kill: half1 <= 0 || half2 <= 0, altSeparateRuns: { half1: alt1, half2: alt2, kill: alt1 <= 0 || alt2 <= 0 } },
  };
  return { k, pass: !Object.values(k).some((x) => x.kill) };
}

const runs = [];
for (const b of bars) {
  for (const L of levs) {
    const r = run(b.label, L);
    const perInst = Object.fromEntries(
      insts.map((id) => {
        const t = r.sleeves[id].trades;
        const sum = (f) => t.reduce((a, x) => a + x[f], 0);
        const eq = r.sleeves[id].equity;
        return [id, { trades: t.length, winRate: t.length ? t.filter((x) => x.pnl > 0).length / t.length : null, netReturn: (eq.at(-1)?.value ?? r.equity0 / 3) / (r.equity0 / 3) - 1, fees: sum('fees'), funding: sum('funding') }];
      }),
    );
    const liquidations = r.trades.filter((t) => t.reason === 'liquidation').length;
    runs.push({ bar: b.label, leverage: L, growth: growth(r), maxDD: maxDrawdown(r.portfolio, r.equity0), trades: r.trades.length, liquidations, perInst });
    fs.writeFileSync(`${outDir}H-F1-${b.label}-${L}x-trades.jsonl`, r.trades.map((t) => JSON.stringify(t)).join('\n'));
  }
}

const primary = criteria('1D');
const secondary = criteria('4H');

// BTC buy-and-hold 1x: first sample open to last sample close, fee + slippage on both sides, no funding.
const btc = data.candles[`${insts[0]}|1D`].filter((c) => c.ts >= startMs && c.ts < endMs);
const s = prereg.costs.slippage_bps_per_side / 10000;
const f = prereg.costs.taker_fee_per_side;
const buyHold = {
  gross: btc.at(-1).close / btc[0].open - 1,
  net: ((btc.at(-1).close * (1 - s)) / (btc[0].open * (1 + s))) * ((1 - f) / (1 + f)) - 1,
};

const verdict = primary.pass ? 'PASS' : 'KILL';
fs.writeFileSync(`${outDir}H-F1-summary.json`, JSON.stringify({ id: prereg.id, sample: prereg.sample, runs, criteria: { primary1D: primary.k, secondary4H: secondary.k }, buyHoldBTC: buyHold,
  verdict,
  notes: [
    'Funding for stop/liquidation exits accrues to the close of the bar they hit, which can add up to two 8h events on 1D.',
    "K-A5's verdict uses the continuous-run reading (halves sliced from one equity curve); altSeparateRuns is report-only.",
  ],
}, null, 2));

const pct = (x) => `${(x * 100).toFixed(1)}%`.padStart(9);
console.log('bar  lev   trades  growth    maxDD     liqs');
for (const r of runs) console.log(`${r.bar.padEnd(4)} ${String(r.leverage).padStart(2)}x  ${String(r.trades).padStart(6)} ${pct(r.growth)} ${pct(r.maxDD)} ${String(r.liquidations).padStart(6)}`);
console.log(`BTC buy-and-hold 1x: gross ${pct(buyHold.gross).trim()}, net of fees+slippage ${pct(buyHold.net).trim()}`);
for (const [name, c] of [['1D (primary)', primary], ['4H (report only)', secondary]]) {
  console.log(`\n${name}`);
  for (const [id, v] of Object.entries(c.k)) console.log(`  ${id} ${v.kill ? 'KILL' : 'ok  '} ${JSON.stringify(v, (_, x) => (typeof x === 'number' ? +x.toFixed(4) : x))}`);
}
console.log(`\nVERDICT: ${verdict}`);
