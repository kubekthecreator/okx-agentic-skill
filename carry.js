// carry.js — pure engine for the H-F2 replay (docs/prereg/H-F2.json). No I/O.
// panel: { SYMBOL: { candles: [{ ts, open, high, low, close, quoteVolume }] (ascending, daily),
//                    funding: [{ ts, rate }] (ascending) } }

const DAY = 86400000;
const H = 3600000;
const VOL_DAYS = 30;
const DELIST_PENALTY = 0.1; // extra adverse move when a held symbol vanishes
const LIQ_MARGIN = 0.005;

// First index with rows[i].ts >= ts.
function lowerBound(rows, ts) {
  let lo = 0;
  let hi = rows.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (rows[mid].ts < ts) lo = mid + 1;
    else hi = mid;
  }
  return lo;
}

// Sum of rates with fromMs <= ts < toMs.
function sumRates(rows, fromMs, toMs) {
  let s = 0;
  for (let i = lowerBound(rows, fromMs); i < rows.length && rows[i].ts < toMs; i++) s += rows[i].rate;
  return s;
}

const hasPrint = (rows, fromMs, toMs) => lowerBound(rows, fromMs) < lowerBound(rows, toMs);

// ts -> candle index, built once per panel.
const indexCache = new WeakMap();
function candleIndex(panel, sym) {
  if (!indexCache.has(panel)) indexCache.set(panel, new Map());
  const m = indexCache.get(panel);
  if (!m.has(sym)) m.set(sym, new Map(panel[sym].candles.map((c, i) => [c.ts, i])));
  return m.get(sym);
}

// Eligible perps at the open `t` (uses only data before t, plus the open candle needed to trade),
// top rule.universe by mean quote volume of the previous 30 days. rule.ignoreFunding drops the funding
// eligibility test (used only to pick which symbols' funding to download).
// Signal = sum of prints in [t-72h, t) / 9 = mean rate per 8h whatever the print interval.
export function selectUniverse(panel, t, rule) {
  const out = [];
  for (const [symbol, { candles, funding }] of Object.entries(panel)) {
    const k = candleIndex(panel, symbol).get(t);
    if (k === undefined || k < VOL_DAYS || candles[k - VOL_DAYS].ts !== t - VOL_DAYS * DAY) continue;
    if (!rule.ignoreFunding && !hasPrint(funding, t - 48 * H, t)) continue;
    let v = 0;
    for (let i = k - VOL_DAYS; i < k; i++) v += candles[i].quoteVolume;
    out.push({ symbol, vol: v / VOL_DAYS, signal: sumRates(funding, t - 72 * H, t) / 9 });
  }
  return out.sort((a, b) => b.vol - a.vol || (a.symbol < b.symbol ? -1 : 1)).slice(0, rule.universe);
}

// Short the highest signal, long the lowest; ties by higher volume (then symbol, for determinism).
export function selectBaskets(members, basket) {
  const pick = (sign) =>
    [...members]
      .sort((a, b) => sign * (b.signal - a.signal) || b.vol - a.vol || (a.symbol < b.symbol ? -1 : 1))
      .slice(0, basket)
      .map((m) => m.symbol);
  return { short: pick(1), long: pick(-1) };
}

// Daily rebalance at 00:00 UTC over [startMs, endMs). Equity is marked at every open (one extra point at endMs).
// A day's return runs from its open to the next open and includes price PnL, funding and costs.
export function simulateCarry({ panel, rule, costs, gross, startMs, endMs, startEquity = 3000 }) {
  const slip = costs.slippage_bps_per_side;
  let equity = startEquity;
  let held = new Map(); // symbol -> { dir: +1 long | -1 short, qty }
  const curve = [{ ts: startMs, value: equity }];
  const days = [];
  let liquidated = false;

  for (let t = startMs; t < endMs && equity > 0; t += DAY) {
    const cndl = (sym, ts) => panel[sym].candles[candleIndex(panel, sym).get(ts)];
    const members = selectUniverse(panel, t, rule);
    const target = new Map();
    if (members.length >= 2 * rule.basket) {
      const notional = (gross * equity) / 2 / rule.basket;
      const b = selectBaskets(members, rule.basket);
      for (const s of b.short) target.set(s, { dir: -1, notional });
      for (const s of b.long) target.set(s, { dir: 1, notional });
    }

    const d = { fees: 0, slippage: 0, traded: 0 };
    const trade = (sym, n) => {
      d.traded += n;
      d.fees += n * costs.taker_fee_per_side;
      d.slippage += (n * (slip[sym] ?? slip.others)) / 10000;
    };
    for (const sym of new Set([...held.keys(), ...target.keys()])) {
      const h = held.get(sym);
      const g = target.get(sym);
      const carried = h ? h.qty * cndl(sym, t).open : 0;
      trade(sym, h && g && h.dir === g.dir ? Math.abs(g.notional - carried) : carried + (g ? g.notional : 0));
    }
    held = new Map([...target].map(([sym, g]) => [sym, { dir: g.dir, qty: g.notional / cndl(sym, t).open }]));
    const rebalanceCosts = d.fees + d.slippage;

    let pricePnl = 0;
    let longPnl = 0;
    let shortPnl = 0;
    let funding = 0;
    let worstName = 0;
    const delisted = [];
    let grossNotional = 0;
    let unrealisedAtClose = 0;
    const heldCount = held.size;
    for (const [sym, p] of [...held]) {
      const c = cndl(sym, t);
      const next = panel[sym].candles[candleIndex(panel, sym).get(t + DAY)];
      const notional = p.qty * c.open;
      const exitPx = next ? next.open : c.close * (1 - p.dir * DELIST_PENALTY);
      const pnl = p.dir * p.qty * (exitPx - c.open);
      const fund = -p.dir * notional * sumRates(panel[sym].funding, t + 1, t + DAY + 1);
      grossNotional += notional;
      unrealisedAtClose += p.dir * p.qty * (c.close - c.open);
      pricePnl += pnl;
      if (p.dir > 0) longPnl += pnl;
      else shortPnl += pnl;
      funding += fund;
      worstName = Math.min(worstName, (pnl + fund) / equity);
      if (!next) {
        trade(sym, p.qty * exitPx); // delisted: normal exit costs on top of the 10 % adverse move
        delisted.push({ symbol: sym, side: p.dir > 0 ? 'long' : 'short' });
        held.delete(sym);
      }
    }

    const dayCosts = d.fees + d.slippage;
    liquidated = grossNotional > 0 && equity - rebalanceCosts + unrealisedAtClose <= LIQ_MARGIN * grossNotional;
    const nextEquity = liquidated ? 0 : Math.max(0, equity + pricePnl + funding - dayCosts);
    days.push({ ts: t, ret: nextEquity / equity - 1, funding, pricePnl, longPnl, shortPnl, costs: dayCosts, fees: d.fees, slippage: d.slippage, traded: d.traded, held: heldCount, worstName, delisted });
    equity = nextEquity;
    curve.push({ ts: t + DAY, value: equity });
    if (equity <= 0) {
      liquidated = true;
      break;
    }
  }
  return { equity: curve, days, liquidated };
}
