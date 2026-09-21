// Pure helpers in execution.js (no CLI involved).
// Run: npm test

import { test, before } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs';
import os from 'os';
import path from 'path';

let execution;
before(async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'okx-exec-test-'));
  process.env.OKX_BOT_HOLDERS_FILE = path.join(dir, 'holders_history.json');
  process.env.OKX_BOT_LOG_DIR = path.join(dir, 'logs');
  execution = (await import('../execution.js')).default;
});

const H = 3600_000;

// ─── holderGrowthPct ──────────────────────────────────────────────────────

test('holderGrowthPct: null until a ≥20h-old baseline exists', () => {
  const now = Date.now();
  const series = [{ ts: now - 5 * H, holders: 1000 }, { ts: now, holders: 1200 }];
  assert.equal(execution.holderGrowthPct(series, now), null);
});

test('holderGrowthPct: uses the snapshot closest to 24h ago as baseline', () => {
  const now = Date.now();
  const series = [
    { ts: now - 26 * H, holders: 900 },
    { ts: now - 24 * H, holders: 1000 },   // ← baseline
    { ts: now - 22 * H, holders: 1100 },
    { ts: now - 1 * H, holders: 1040 },
    { ts: now, holders: 1050 },
  ];
  assert.equal(execution.holderGrowthPct(series, now).toFixed(2), '5.00');
});

test('holderGrowthPct: hourly series builds a baseline after a day (v0.1 never did)', () => {
  const now = Date.now();
  const series = [];
  for (let h = 30; h >= 0; h--) series.push({ ts: now - h * H, holders: 1000 + (30 - h) * 2 });
  const g = execution.holderGrowthPct(series, now);
  assert.ok(g !== null && g > 0, `expected positive growth, got ${g}`);
});

test('holderGrowthPct: tolerates a single stale legacy point (no baseline → null, not NaN)', () => {
  const now = Date.now();
  assert.equal(execution.holderGrowthPct([{ ts: now - 30 * H, holders: 500 }], now), null);
});

// ─── normalizeHolderSeries (legacy file migration) ────────────────────────

test('normalizeHolderSeries converts the v0.1 two-point record', () => {
  const out = execution.normalizeHolderSeries({ ts: 5000, holders: 120, prev_ts: 1000, prev_holders: 100 });
  assert.deepEqual(out, [{ ts: 1000, holders: 100 }, { ts: 5000, holders: 120 }]);
});

test('normalizeHolderSeries passes arrays through and drops junk entries', () => {
  const out = execution.normalizeHolderSeries([{ ts: 1, holders: 10 }, null, { ts: 2, holders: 0 }]);
  assert.deepEqual(out, [{ ts: 1, holders: 10 }]);
  assert.deepEqual(execution.normalizeHolderSeries(undefined), []);
});

// ─── Balance helpers ──────────────────────────────────────────────────────

test('portfolio and cash derive from a single balance snapshot', () => {
  const balances = [
    { symbol: 'USDC', mint: 'u', balance: 40, value_usd: 40 },
    { symbol: 'SOL', mint: 's', balance: 0.1, value_usd: 15 },
    { symbol: 'JUP', mint: 'j', balance: 100, value_usd: 20 },
  ];
  assert.equal(execution.portfolioValueFromBalances(balances), 75);
  assert.equal(execution.cashFromBalances(balances), 40);
  assert.equal(execution.cashFromBalances([]), 0);
});
