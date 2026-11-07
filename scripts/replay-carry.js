// scripts/replay-carry.js — H-F2 historical replay (docs/prereg/H-F2.json).
// Public data only; no keys, no orders. Run: node scripts/replay-carry.js [--refresh]
// Cache and outputs: data/replay/carry/

import fs from 'node:fs';
import { fileURLToPath } from 'node:url';

import { selectBaskets, selectUniverse, simulateCarry } from '../carry.js';
import { fundingGaps, getBinanceFunding, getBinanceKlines, getBinancePerps, getTbill, getXPerpFunding, getXPerpInstruments } from '../market.js';
import { maxDrawdown, tbillGrowth } from '../paper.js';

const root = new URL('..', import.meta.url);
const prereg = JSON.parse(fs.readFileSync(new URL('docs/prereg/H-F2.json', root), 'utf-8'));
const outDir = fileURLToPath(new URL('data/replay/carry/', root));
fs.mkdirSync(outDir, { recursive: true });
const refresh = process.argv.includes('--refresh');

const DAY = 86400000;
const day = (s) => Date.parse(`${s}T00:00:00Z`);
const startMs = day(prereg.sample.start);
const endMs = day(prereg.sample.end) + DAY; // exclusive: the whole last day
const fetchFrom = day(prereg.data.fetch_from);
const fetchEnd = endMs + DAY; // one more daily candle: the open of endMs marks the last day
const total = prereg.sizing.starting_equity_usd;
const rule = { universe: 50, basket: 10 };
const FETCH_UNIVERSE = 80; // download funding for names ranked <= 80 by volume: buffer for names dropped by the funding test
const CAL_START = day('2026-08-06');

// Cache entries remember the range they were fetched for; a mismatch is an error, never a silent reuse.
async function cached(name, from, to, fn) {
  const file = `${outDir}${name}.json`;
  if (!refresh && fs.existsSync(file)) {
    const c = JSON.parse(fs.readFileSync(file, 'utf-8'));
    if (c.startMs !== from || c.endMs !== to) throw new Error(`cache ${name} covers ${c.startMs}..${c.endMs}, requested ${from}..${to}: re-run with --refresh`);
    return c.rows;
  }
  const rows = await fn();
  fs.writeFileSync(file, JSON.stringify({ startMs: from, endMs: to, fetchedAt: new Date().toISOString(), rows }));
  return rows;
}

// Data gaps (not network faults) reject the symbol; the rejection is cached and reported, never silent.
const rejected = [];
async function load(kind, symbol, from, to, fn) {
  const rows = await cached(`${kind}-${symbol}`, from, to, async () => {
    try {
      return await fn();
    } catch (err) {
      if (err.gap) return { rejected: err.message };
      throw err;
    }
  });
  if (rows.rejected) {
    rejected.push({ symbol, kind, reason: rows.rejected });
    return null;
  }
  return rows;
}

// Binance base asset -> OKX base: 1000PEPE -> PEPE, 1000000MOG -> MOG, 1MBABYDOGE -> BABYDOGE; 1INCH stays.
const okxBase = (b) => b.replace(/^(?:10{3,}|1M)(?=[A-Z])/, '');

// ─── fetch ───
const perps = await cached('perps', fetchFrom, fetchEnd, getBinancePerps);
const xperps = await cached('xperp-instruments', fetchFrom, fetchEnd, getXPerpInstruments);
const xBases = new Set(xperps.map((x) => x.base));
const inXPerp = (p) => xBases.has(p.baseAsset) || xBases.has(okxBase(p.baseAsset));

const candles = {};
let n = 0;
for (const p of perps) {
  if (p.onboardDate >= fetchEnd) continue;
  const rows = await load('klines', p.symbol, fetchFrom, fetchEnd, () => getBinanceKlines(p.symbol, fetchFrom, fetchEnd));
  if (rows?.length) candles[p.symbol] = rows;
  if (++n % 50 === 0) console.error(`klines ${n}/${perps.length}`);
}

// Which symbols ever rank in the top FETCH_UNIVERSE by volume (full set, and inside the X-Perp subset)?
const klinePanel = (pred) => Object.fromEntries(Object.entries(candles).filter(([s]) => pred(s)).map(([s, c]) => [s, { candles: c, funding: [] }]));
const xSymbols = new Set(perps.filter(inXPerp).map((p) => p.symbol));
const everRanked = (panel, size) => {
  const ever = new Set();
  for (let t = startMs; t < endMs; t += DAY) for (const m of selectUniverse(panel, t, { universe: size, ignoreFunding: true })) ever.add(m.symbol);
  return ever;
};
const kAll = klinePanel(() => true);
const kX = klinePanel((s) => xSymbols.has(s));
const everTop50 = everRanked(kAll, rule.universe);
const need = new Set([...everRanked(kAll, FETCH_UNIVERSE), ...everRanked(kX, FETCH_UNIVERSE)]);

const funding = {};
const noFunding = []; // downloaded but no rows at all (or rejected): listed in the summary, never silent
n = 0;
for (const symbol of need) {
  const rows = await load('funding', symbol, fetchFrom, fetchEnd, async () => (await getBinanceFunding(symbol, fetchFrom, fetchEnd)).rows);
  if (rows?.length) funding[symbol] = rows;
  else noFunding.push(symbol);
  if (++n % 25 === 0) console.error(`funding ${n}/${need.size}`);
}
const panel = Object.fromEntries(Object.keys(funding).filter((s) => candles[s]).map((s) => [s, { candles: candles[s], funding: funding[s] }]));
const subset = Object.fromEntries(Object.entries(panel).filter(([s]) => xSymbols.has(s)));
const tbill = await cached('tbill', fetchFrom, fetchEnd, () => getTbill(prereg.data.fetch_from, prereg.sample.end));

// ─── runs and metrics ───
const costs = prereg.costs;
const slipX2 = Object.fromEntries(Object.entries(costs.slippage_bps_per_side).map(([k, v]) => [k, v * 2]));
const run = (p, gross, c = costs) => simulateCarry({ panel: p, rule, costs: c, gross, startMs, endMs, startEquity: total });
const growthOf = (curve, a = 0, b = curve.length - 1) => curve[b].value / curve[a].value - 1;
const sum = (xs) => xs.reduce((a, b) => a + b, 0);
const valueAt = (curve, ms) => curve.findLast((e) => e.ts <= ms).value;

function metrics(r) {
  const rets = r.days.map((d) => d.ret);
  const mean = sum(rets) / rets.length;
  const sd = Math.sqrt(sum(rets.map((x) => (x - mean) ** 2)) / (rets.length - 1));
  const exTop10 = [...rets].sort((a, b) => b - a).slice(10).reduce((p, x) => p * (1 + x), 1) - 1;
  const [h1] = prereg.sample.halves;
  const mid = day(h1[1]) + DAY;
  const years = {};
  for (let y = +prereg.sample.start.slice(0, 4); y <= +prereg.sample.end.slice(0, 4); y++) {
    const a = Math.max(startMs, day(`${y}-01-01`));
    const b = Math.min(endMs, day(`${y + 1}-01-01`));
    years[y] = valueAt(r.equity, b) / valueAt(r.equity, a) - 1;
  }
  return {
    growth: growthOf(r.equity),
    tStat: (mean / sd) * Math.sqrt(rets.length),
    exTop10,
    maxDD: maxDrawdown(r.equity, total),
    half1: valueAt(r.equity, mid) / total - 1,
    half2: valueAt(r.equity, mid) > 0 ? valueAt(r.equity, endMs) / valueAt(r.equity, mid) - 1 : -1, // wiped out before the split
    liquidated: r.liquidated,
    days: rets.length,
    split: { funding: sum(r.days.map((d) => d.funding)), longPricePnl: sum(r.days.map((d) => d.longPnl)), shortPricePnl: sum(r.days.map((d) => d.shortPnl)), fees: -sum(r.days.map((d) => d.fees)), slippage: -sum(r.days.map((d) => d.slippage)) },
    perYear: years,
    turnoverPerDay: sum(r.days.map((d, i) => d.traded / r.equity[i].value)) / r.days.length,
    namesHeldMean: sum(r.days.map((d) => d.held)) / r.days.length,
    worstNameDay: Math.min(...r.days.map((d) => d.worstName)),
    worstPortfolioDay: Math.min(...rets),
  };
}

const R = { primary: run(panel, 1), stress: run(panel, 1, { ...costs, slippage_bps_per_side: slipX2 }), x2: run(panel, 2), x3: run(panel, 3), xperp: run(subset, 1) };
const R_ALL = Object.entries(R);
const M = Object.fromEntries(Object.entries(R).map(([k, r]) => [k, metrics(r)]));
const bill = tbillGrowth(tbill, startMs, endMs);
const p = M.primary;
const kc = {
  'K-C1': { growth: p.growth, tbill: bill, kill: p.growth <= bill },
  'K-C2': { tStat: p.tStat, kill: p.tStat < 2 },
  'K-C3': { exTop10: p.exTop10, kill: p.exTop10 <= 0 },
  'K-C4': { maxDD: p.maxDD, kill: p.maxDD > 0.2 },
  'K-C5': { half1: p.half1, half2: p.half2, kill: p.half1 <= 0 || p.half2 <= 0 },
  'K-C6': { growth: M.stress.growth, tbill: bill, kill: M.stress.growth <= bill },
};
const verdict = Object.values(kc).some((x) => x.kill) ? 'KILL' : 'PASS';

// BTC buy-and-hold 1x: first sample open to the open of endMs, fee + slippage both sides, no funding (as H-F1).
const btc = candles.BTCUSDT;
const o0 = btc.find((c) => c.ts === startMs).open;
const o1 = btc.find((c) => c.ts === endMs).open;
const sl = costs.slippage_bps_per_side.BTCUSDT / 10000;
const f = costs.taker_fee_per_side;
const buyHold = { gross: o1 / o0 - 1, net: ((o1 * (1 - sl)) / (o0 * (1 + sl))) * ((1 - f) / (1 + f)) - 1 };

// Proxy calibration on coins listed on both venues, window CAL_START..endMs.
const pearson = (xs, ys) => {
  const mx = sum(xs) / xs.length;
  const my = sum(ys) / ys.length;
  const c = sum(xs.map((x, i) => (x - mx) * (ys[i] - my)));
  const d = Math.sqrt(sum(xs.map((x) => (x - mx) ** 2)) * sum(ys.map((y) => (y - my) ** 2)));
  return d ? c / d : null;
};
const xFunding = {};
const perCoin = [];
for (const pf of perps.filter(inXPerp)) {
  const inst = xperps.find((x) => x.base === pf.baseAsset || x.base === okxBase(pf.baseAsset));
  const xr = await cached(`xfunding-${inst.base}`, CAL_START, endMs, async () => (await getXPerpFunding(inst.instId, CAL_START)).filter((r) => r.ts < endMs));
  const br = funding[pf.symbol]?.filter((r) => r.ts >= CAL_START && r.ts < endMs) ?? (candles[pf.symbol] ? await load('bcal', pf.symbol, CAL_START, endMs, async () => (await getBinanceFunding(pf.symbol, CAL_START, endMs)).rows) : null);
  if (!xr.length || !br?.length) continue;
  xFunding[pf.symbol] = { x: xr, b: br };
  const bm = new Map(br.map((r) => [r.ts, r.rate]));
  const pairs = xr.filter((r) => bm.has(r.ts)).map((r) => [r.rate, bm.get(r.ts)]);
  if (pairs.length < 10) continue;
  perCoin.push({ symbol: pf.symbol, matched: pairs.length, meanDiff: sum(pairs.map(([a, b]) => a - b)) / pairs.length, corr: pearson(pairs.map((q) => q[0]), pairs.map((q) => q[1])) });
}
const sigOf = (rows, t) => sum(rows.filter((r) => r.ts >= t - 72 * 3600000 && r.ts < t).map((r) => r.rate)) / 9;
const overlap = { short: [], long: [] };
for (let t = CAL_START; t < endMs; t += DAY) {
  const members = selectUniverse(subset, t, rule).filter((m) => xFunding[m.symbol]);
  if (members.length < 2 * rule.basket) continue;
  const b = selectBaskets(members, rule.basket);
  const x = selectBaskets(members.map((m) => ({ ...m, signal: sigOf(xFunding[m.symbol].x, t) })), rule.basket);
  for (const side of ['short', 'long']) overlap[side].push(b[side].filter((s) => x[side].includes(s)).length / rule.basket);
}
const mean = (xs) => (xs.length ? sum(xs) / xs.length : null);
const calibration = {
  coins: perCoin.length,
  meanOfMeanDiff: mean(perCoin.map((c) => c.meanDiff)),
  meanCorr: mean(perCoin.map((c) => c.corr).filter((c) => c !== null)),
  basketOverlap: { days: overlap.short.length, short: mean(overlap.short), long: mean(overlap.long) },
  perCoin,
};

const first = (s) => new Date(panel[s].candles[0].ts).toISOString().slice(0, 10);
const last = (s) => new Date(panel[s].candles.at(-1).ts).toISOString().slice(0, 10);
const everInUniverse = new Set();
for (let t = startMs; t < endMs; t += DAY) for (const m of selectUniverse(panel, t, rule)) everInUniverse.add(m.symbol);
const fundingGapList = Object.fromEntries(Object.entries(funding).map(([s, rows]) => [s, fundingGaps(rows).map((g) => [g.from, g.to].map((x) => new Date(x).toISOString().slice(0, 16)))]).filter(([, g]) => g.length));
const delistings = R_ALL.flatMap(([run, r]) => r.days.flatMap((d) => d.delisted.map((x) => ({ run, symbol: x.symbol, date: new Date(d.ts).toISOString().slice(0, 10), side: x.side }))));
const lastCandleBeforeEnd = Object.entries(candles).filter(([, c]) => c.at(-1).ts < endMs).map(([s, c]) => ({ symbol: s, lastCandle: new Date(c.at(-1).ts).toISOString().slice(0, 10), status: perps.find((q) => q.symbol === s).status }));
const counts = {
  delistingCloses: delistings.filter((d) => d.run === 'primary').length,
  fundingGapSymbols: Object.keys(fundingGapList).length,
  noFundingRows: noFunding.length, perpsInExchangeInfo: perps.length, withCandles: Object.keys(candles).length, everTop50ByVolume: everTop50.size, fundingFetched: need.size, everInUniverse: everInUniverse.size, gapRejections: rejected.length, xPerpSubsetSymbols: Object.keys(subset).length };
fs.writeFileSync(`${outDir}H-F2-summary.json`, JSON.stringify({ id: prereg.id, sample: prereg.sample, counts, rejected, noFunding, fundingGaps: fundingGapList, delistings, lastCandleBeforeFetchEnd: lastCandleBeforeEnd, coverage: Object.fromEntries(Object.keys(panel).map((s) => [s, [first(s), last(s)]])), runs: M, criteria: kc, tbillGrowth: bill, buyHoldBTC: buyHold, calibration, verdict,
  notes: [
    'Signal = sum of prints in [t-72h, t) / 9 (mean rate per 8h for any print interval).',
    'Sizing equity = equity at the open before that day\'s costs; costs are then deducted from the day\'s return.',
    'A symbol needs a candle on the rebalance day to be eligible (it must be tradable at that open). Fewer than 2 x basket eligible names = flat that day.',
    'Equity is marked at each open; the final point is the open of the day after the sample (no exit costs charged at the end).',
    'Liquidation: equity after rebalance costs plus unrealised price PnL at the daily close (funding excluded) <= 0.5 % of gross notional; the run then ends at zero.',
    'Funding is downloaded for names ranked <= 80 by volume (buffer over the 50 universe); internal funding gaps are kept (funding counts as zero there, the 48h-print rule makes the symbol ineligible) and listed in `fundingGaps`; klines gaps still reject the symbol (`rejected`).',
    'Ties in the top-50 volume cut are broken alphabetically; t-stat uses the sample standard deviation.',
    'Proxy calibration joins X-Perp and Binance prints on identical minute-rounded settlement times; basket overlap is measured inside the X-Perp subset universe, only names with X-Perp funding.',
  ],
}, null, 2));

const pct = (x) => `${(x * 100).toFixed(1)}%`.padStart(9);
console.log(`delisting closes (primary): ${counts.delistingCloses}; symbols with funding gaps: ${counts.fundingGapSymbols}; no funding rows: ${noFunding.length}; last candle before fetch end: ${lastCandleBeforeEnd.length}`);
console.log(`symbols: ${counts.perpsInExchangeInfo} perps, ${counts.withCandles} with candles, ${counts.everInUniverse} ever in universe, ${counts.gapRejections} rejected for gaps`);
console.log('run                    growth    maxDD   t-stat    liq');
for (const [k, m] of Object.entries(M)) console.log(`${k.padEnd(20)} ${pct(m.growth)} ${pct(m.maxDD)} ${m.tStat.toFixed(2).padStart(8)} ${String(m.liquidated).padStart(6)}`);
console.log(`BTC buy-and-hold 1x: gross ${pct(buyHold.gross).trim()}, net ${pct(buyHold.net).trim()}; T-bill ${pct(bill).trim()}`);
for (const [id, v] of Object.entries(kc)) console.log(`  ${id} ${v.kill ? 'KILL' : 'ok  '} ${JSON.stringify(v, (_, x) => (typeof x === 'number' ? +x.toFixed(4) : x))}`);
console.log(`\nVERDICT: ${verdict}`);
