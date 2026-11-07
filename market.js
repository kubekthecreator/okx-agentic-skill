// market.js — public market data for the H-F1 replay. I/O only, no keys, no orders.

const OKX = 'https://www.okx.com/api/v5';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function getText(url) {
  for (let attempt = 0; ; attempt++) {
    try {
      const res = await fetch(url, { signal: AbortSignal.timeout(15000) });
      if ((res.status >= 500 || res.status === 429) && attempt < 2) {
        await sleep(500 * (attempt + 1));
        continue;
      }
      if (!res.ok) throw new Error(`HTTP ${res.status} for ${url}`);
      return await res.text();
    } catch (err) {
      if (/^HTTP /.test(err.message) || attempt >= 2) throw err;
      await sleep(500 * (attempt + 1)); // network error / timeout
    }
  }
}

async function getJson(url) {
  const j = JSON.parse(await getText(url));
  if (j && !Array.isArray(j) && j.code !== undefined && j.code !== '0') {
    throw new Error(`API error ${j.code}: ${j.msg} for ${url}`);
  }
  return j;
}

// Pages OKX rows (newest first, `after` = older than) until `stop(row)` or no rows.
async function okxPages(path, params, stop) {
  const out = [];
  let after = params.after;
  for (;;) {
    const q = new URLSearchParams({ ...params, ...(after ? { after } : {}), limit: '100' });
    const { data } = await getJson(`${OKX}${path}?${q}`);
    if (!data.length) return out;
    out.push(...data);
    if (stop(data[data.length - 1])) return out;
    after = data[data.length - 1][path.includes('funding') ? 'fundingTime' : 0]; // oldest row
    await sleep(150); // OKX limit: 20 req / 2 s
  }
}

// Ascending [{ ts, open, high, low, close, volume_usd }] for bars with
// startMs <= ts < endMs. Confirmed bars only. volume_usd = quote volume (USDT).
const BAR_MS = { '1Dutc': 86400000, '4H': 14400000 };
const FUNDING_MAX_STEP = 8 * 3600000;

export async function getCandles(instId, bar, startMs, endMs) {
  const barMs = BAR_MS[bar];
  if (!barMs) throw new Error(`unknown bar ${bar}`);
  const tag = `${instId} ${bar}`;
  const raw = await okxPages('/market/history-candles', { instId, bar, after: String(endMs) }, (r) => Number(r[0]) <= startMs);
  const rows = raw
    .filter((r) => r[8] === '1' && Number(r[0]) >= startMs && Number(r[0]) < endMs)
    .map((r) => ({ ts: Number(r[0]), open: +r[1], high: +r[2], low: +r[3], close: +r[4], volume_usd: +r[7] }))
    .sort((a, b) => a.ts - b.ts);
  if (!rows.length) throw new Error(`no candles returned for ${tag}`);
  // History must reach startMs, unless the API ran out first (the instrument's first listed bar, e.g. SOL).
  const firstListed = Math.min(...raw.map((r) => Number(r[0])));
  const wantFirst = Math.max(startMs, firstListed);
  if (rows[0].ts !== wantFirst) throw new Error(`${tag}: first bar ${rows[0].ts}, expected ${wantFirst}`);
  if (rows.at(-1).ts !== endMs - barMs) throw new Error(`${tag}: last bar ${rows.at(-1).ts}, expected ${endMs - barMs}`);
  for (let i = 1; i < rows.length; i++) {
    if (rows[i].ts - rows[i - 1].ts !== barMs) throw new Error(`${tag}: gap or duplicate between ${rows[i - 1].ts} and ${rows[i].ts}`);
  }
  return rows;
}

// Ascending, deduplicated [{ ts, rate, source }]. OKX where it has history,
// Binance for everything older. Timestamps are rounded to the minute (Binance
// stamps settlements a few ms late) so a bar boundary compares cleanly.
export async function getFunding(okxInstId, binanceSymbol, startMs, endMs) {
  const okxRows = (
    await okxPages('/public/funding-rate-history', { instId: okxInstId, after: String(endMs) }, (r) => Number(r.fundingTime) <= startMs)
  )
    .map((r) => ({ ts: Number(r.fundingTime), rate: +(r.realizedRate || r.fundingRate), source: 'okx' }))
    .filter((r) => r.ts >= startMs && r.ts < endMs);
  const okxFrom = okxRows.length ? Math.min(...okxRows.map((r) => r.ts)) : endMs;

  const binRows = [];
  for (let from = startMs; from < okxFrom; ) {
    const q = new URLSearchParams({ symbol: binanceSymbol, startTime: String(from), endTime: String(okxFrom - 1), limit: '1000' });
    const page = await getJson(`https://fapi.binance.com/fapi/v1/fundingRate?${q}`);
    binRows.push(...page.map((r) => ({ ts: Math.round(r.fundingTime / 60000) * 60000, rate: +r.fundingRate, source: 'binance' })));
    if (page.length < 1000) break;
    from = page[page.length - 1].fundingTime + 1;
    await sleep(150);
  }
  const byTs = new Map();
  for (const r of [...binRows, ...okxRows]) if (r.ts >= startMs && r.ts < endMs) byTs.set(r.ts, r); // OKX wins ties
  const out = [...byTs.values()].sort((a, b) => a.ts - b.ts);
  const tag = `funding ${okxInstId}`;
  if (!out.length) throw new Error(`${tag}: no events`);
  if (out[0].ts - startMs > FUNDING_MAX_STEP) throw new Error(`${tag}: coverage starts ${out[0].ts}, requested ${startMs}`);
  if (endMs - out.at(-1).ts > FUNDING_MAX_STEP) throw new Error(`${tag}: coverage ends ${out.at(-1).ts}, requested ${endMs}`);
  for (let i = 1; i < out.length; i++) {
    if (out[i].ts - out[i - 1].ts > FUNDING_MAX_STEP) throw new Error(`${tag}: gap > 8h between ${out[i - 1].ts} and ${out[i].ts}`);
  }
  return out;
}

// FRED DTB3 -> ascending [{ date: 'YYYY-MM-DD', ratePct }]; "." (no print) rows skipped.
export async function getTbill(startDate, endDate) {
  const csv = await getText(`https://fred.stlouisfed.org/graph/fredgraph.csv?id=DTB3&cosd=${startDate}&coed=${endDate}`);
  return csv
    .trim()
    .split(/\r?\n/)
    .slice(1)
    .map((l) => l.split(','))
    .filter(([d, v]) => v && v !== '.' && d >= startDate && d <= endDate) // FRED may ignore cosd/coed
    .map(([date, v]) => ({ date, ratePct: +v }));
}
