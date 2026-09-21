// State-machine and sizing tests for risk.js against a throwaway state file.
// Run: npm test

import { test, before, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs';
import os from 'os';
import path from 'path';

let state, risk;
before(async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'okx-risk-test-'));
  process.env.OKX_BOT_STATE_FILE = path.join(dir, 'state.json');
  process.env.OKX_BOT_LOG_DIR = path.join(dir, 'logs');
  delete process.env.MAX_PORTFOLIO_USD;
  delete process.env.MIN_TRADE_SIZE_USD;
  const { setLogLevel } = await import('../logger.js');
  setLogLevel('error');
  state = (await import('../state.js')).default;
  risk = (await import('../risk.js')).default;
});

function resetState(daily = {}) {
  const s = state.loadState();
  for (const k of Object.keys(s)) delete s[k];
  Object.assign(s, {
    machine_state: 'Normal',
    halt_until: null,
    post_win_cooldown_until: null,
    last_summary_date: null,
    positions: {},
    history: [],
    daily: {
      date: new Date().toISOString().slice(0, 10),
      starting_portfolio_usd: 100,
      trades: 0, wins: 0, losses: 0, consecutive_losses: 0, realized_pnl_usd: 0,
      ...daily,
    },
    setup_stats: {},
  });
  state.saveState();
  return s;
}

beforeEach(() => resetState());

// ─── Halted is an edge, not a level ───────────────────────────────────────

test('3 consecutive losses → Halted with a 4h cooldown', () => {
  const s = resetState({ trades: 3, losses: 3, consecutive_losses: 3, realized_pnl_usd: -2 });
  const r = risk.evaluateState(100);
  assert.equal(r.state, 'Halted');
  assert.equal(r.reason, 'three_consecutive_losses');
  assert.ok(s.halt_until);
  assert.deepEqual(s.halt_trigger, { reason: 'three_consecutive_losses', date: s.daily.date, trades: 3 });
});

test('while the cooldown runs, evaluateState stays Halted without re-alerting', () => {
  const s = resetState({ trades: 3, losses: 3, consecutive_losses: 3 });
  risk.evaluateState(100);
  const until = s.halt_until;
  const r = risk.evaluateState(100);
  assert.equal(r.state, 'Halted');
  assert.equal(s.halt_until, until, 'cooldown not extended');
});

test('after the cooldown, a still-true trigger drops to Slow and does NOT re-halt', () => {
  const s = resetState({ trades: 3, losses: 3, consecutive_losses: 3 });
  risk.evaluateState(100);
  s.halt_until = new Date(Date.now() - 1000).toISOString();  // 4h passed
  const r1 = risk.evaluateState(100);
  assert.equal(r1.state, 'Slow', 'documented recovery path: Halted → Slow');
  assert.equal(s.machine_state, 'Slow');
  const r2 = risk.evaluateState(100);
  assert.equal(r2.state, 'Slow', 'stays Slow on subsequent ticks (v0.1 re-halted here)');
  assert.equal(s.halt_until, null);
});

test('a NEW losing trade after recovery re-arms the halt', () => {
  const s = resetState({ trades: 3, losses: 3, consecutive_losses: 3 });
  risk.evaluateState(100);
  s.halt_until = new Date(Date.now() - 1000).toISOString();
  risk.evaluateState(100);
  assert.equal(s.machine_state, 'Slow');
  // fourth loss closes
  s.daily.trades = 4; s.daily.losses = 4; s.daily.consecutive_losses = 4;
  const r = risk.evaluateState(100);
  assert.equal(r.state, 'Halted');
  assert.equal(s.halt_trigger.trades, 4);
});

test('daily loss limit (−3%) halts; after cooldown the bot sits in Slow for the day', () => {
  const s = resetState({ trades: 2, losses: 2, consecutive_losses: 2, realized_pnl_usd: -3.5 });
  assert.equal(risk.evaluateState(100).reason, 'daily_loss_limit');
  s.halt_until = new Date(Date.now() - 1000).toISOString();
  assert.equal(risk.evaluateState(100).state, 'Slow');
  assert.equal(risk.getTrailingStopPct(), 5, 'Slow tightens trailing to 5%');
});

// ─── Daily profit target: blocks entries, never enters Halted ─────────────

test('profit target ≥ +5% keeps Normal state and normal trailing stop', () => {
  const s = resetState({ trades: 2, wins: 2, realized_pnl_usd: 6 });
  const r = risk.evaluateState(100);
  assert.equal(r.state, 'Normal');
  assert.equal(s.machine_state, 'Normal');
  assert.equal(risk.getTrailingStopPct(), 8, 'winners keep the 8% trail (v0.1 tightened to 5%)');
  assert.equal(s.daily.profit_target_alerted, true);
});

test('profit target blocks new entries via canOpenPosition', () => {
  resetState({ trades: 2, wins: 2, realized_pnl_usd: 6 });
  risk.evaluateState(100);
  const gate = risk.canOpenPosition('smart_money__no_rs');
  assert.equal(gate.allowed, false);
  assert.equal(gate.reason, 'daily_profit_target_hit');
});

// ─── Sizing ───────────────────────────────────────────────────────────────

const token = { symbol: 'JUP', max_position_usd: 50 };

test('rs_boost never breaches the per-token cap', () => {
  resetState();
  const plain = risk.computePositionSize({ portfolio_usd: 1000, cash_usd: 1000, token_config: token });
  const boosted = risk.computePositionSize({ portfolio_usd: 1000, cash_usd: 1000, token_config: token, rs_boost: true });
  assert.equal(plain, 50);
  assert.equal(boosted, 50, 'v0.1 returned 62.5 here');
});

test('rs_boost still adds +25% when the cap is not binding', () => {
  resetState();
  const plain = risk.computePositionSize({ portfolio_usd: 100, cash_usd: 100, token_config: token });
  const boosted = risk.computePositionSize({ portfolio_usd: 100, cash_usd: 100, token_config: token, rs_boost: true });
  assert.equal(plain, 25);
  assert.equal(boosted, 31.25);
});

test('MAX_PORTFOLIO_USD caps total deployed cost basis', () => {
  const s = resetState();
  s.positions['a'] = { entry_value_usd: 160, entry_amount_token: 100, current_amount_token: 100 };
  process.env.MAX_PORTFOLIO_USD = '200';
  try {
    assert.equal(risk.deployedCostBasisUsd(), 160);
    const size = risk.computePositionSize({ portfolio_usd: 1000, cash_usd: 1000, token_config: token });
    assert.equal(size, 40, 'only $40 of headroom left under the $200 ceiling');
    s.positions['b'] = { entry_value_usd: 40, entry_amount_token: 10, current_amount_token: 10 };
    assert.equal(risk.computePositionSize({ portfolio_usd: 1000, cash_usd: 1000, token_config: token }), 0);
  } finally {
    delete process.env.MAX_PORTFOLIO_USD;
  }
});

test('deployedCostBasisUsd releases the share sold in scale-outs', () => {
  const s = resetState();
  s.positions['a'] = { entry_value_usd: 100, entry_amount_token: 100, current_amount_token: 50 };
  assert.equal(risk.deployedCostBasisUsd(), 50);
});

test('unset MAX_PORTFOLIO_USD means no global cap', () => {
  const s = resetState();
  s.positions['a'] = { entry_value_usd: 5000, entry_amount_token: 1, current_amount_token: 1 };
  assert.equal(risk.computePositionSize({ portfolio_usd: 1000, cash_usd: 1000, token_config: token }), 50);
});
