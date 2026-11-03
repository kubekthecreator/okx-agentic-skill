---
name: okx-trend-follower
version: 0.2.0
description: |
  Trend-following trading skill for OKX Agentic Wallet on Solana.
  Trades whitelisted large SPL tokens (JUP, BONK, WIF, JTO, PYTH, RAY, ORCA, DRIFT)
  against USDC. AI-augmented, not AI-autonomous — strict rules-based execution
  with multi-state risk machine. Requires catalyst confirmation for every entry.
runtime: node>=20
license: MIT
---

# OKX Trend-Follower Skill

A disciplined trend-following bot for the OKX Agentic Wallet Trading Competition.

## Design Philosophy

**AI as augmentation, not autonomy.** This bot enforces the rules emotions break.
It has no FOMO, no panic, no revenge trading. It surfaces patterns and executes
mechanically, and alerts a human loudly only when something needs a decision or
is broken (see `notify.js`).

**Consistency beats conviction.** This is not a system designed to nail bottoms
or moonshots. It's designed to make the same disciplined decision every time the
same setup appears.

**Every position requires a catalyst.** Pure chart patterns are noise.
A position only opens when at least one of these is true: smart money cluster
accumulation, news event, or on-chain spike (holders growing, mint volume rising).

## Capabilities

- Multi-signal entry filter (trend, momentum, valuation, catalyst, relative strength)
- 3-state risk machine (Normal → Slow mode → Halted) with auto-recovery
- Position-level kill conditions evaluated every tick plus an independent 5-minute sweep
- Scaled exits (no single TP — partials at +15%, +30%, +50%, trailing on residue)
- Daily loss limit and daily profit target
- Post-win cooldown to prevent overtrading
- Anti-pattern detector: bot halts setups that consistently lose
- Peak PnL tracking with exit quality measurement
- Tiered Telegram alerts: loud only when action is needed (e.g. can't start, crash, blind, exit blocked/failing, Halted), trades with sound, the rest silent, plus a weekly heartbeat

## Entry Conditions

A position opens **only** when **all four hard signals** pass, optionally
boosted by the fifth:

1. **Trend** — price > 4h SMA
2. **Momentum** — 1h volume > 1.5× 24h average
3. **Not extended** — price ≤ 15% above 4h SMA (don't buy tops)
4. **Catalyst** (at least one of):
   - Smart money cluster: ≥3 OKX top-trader wallets accumulated in last 6h
   - News flow detected for token in last 24h
   - On-chain spike: unique holders +5% in 24h
5. **Booster (optional)** — Relative strength: token outperforms SOL by ≥5%
   over 4h. When true, position size scales up.

## Exit Conditions

Whichever fires first:

- **Trailing stop**: peak − 8% (tightens to 5% in Slow mode)
- **Hard stop**: −10% from entry
- **Scaled take-profit**: +15% sell 20%, +30% sell 30%, +50% sell 30%, residue trails
- **Time stop**: 5 days max hold
- **Catalyst death**: kill conditions met (smart money exits, volume drops 70%
  from peak, news flow stops)

## Risk State Machine

| State | Triggers | Behavior |
|-------|----------|----------|
| Normal | Default | Full entry rules, max position size, up to 3 concurrent positions |
| Slow mode | 2 losses today, OR daily PnL < −1.5%, OR exit quality < 40% (5-trade avg) | Tighter filters (must have smart money), half size, max 1 new position, trailing stop 5% |
| Halted | 3 losses in a row, OR daily PnL < −3% | No new positions for 4h. Existing positions: trailing stop tightens. Telegram alert. After 4h → Slow mode (not Normal). Served once per trigger — re-arms only after another trade closes |

Daily profit target +5% → no new positions until UTC midnight (post-win
discipline); open positions are unaffected. Anti-pattern detector (≥5 losses
and <30% win rate on one setup type) pauses that setup for 24h, not the bot.

Volume-based rules (momentum, volume collapse) only ever read completed
hourly candles; the in-progress bar is excluded.

## Usage

The skill is invoked from an AI agent (Claude Code / Cursor / Codex CLI / OpenCode).

```
Run the OKX trend-follower bot
```

The agent will spawn `bot.js`, which runs the main loop indefinitely.

### Commands

- `npm start` — live trading
- `npm run dev` — dry run (no transactions, simulated fills)
- `npm run status` — Solana wallet value, open positions, state machine status

### Manual override

There is no Telegram command channel in this version: alerts are one-way.
To stop trading, stop the process (`Ctrl-C`, `systemctl stop okx-bot`,
`docker compose stop`) — state is flushed on SIGTERM and open positions are
left intact for the next start. To force a halt without stopping, set
`machine_state` to `"Halted"` with a future `halt_until` in `state.json`
while the bot is stopped.

## Safety Considerations

- **Dry-run by default**. Set `DRY_RUN=false` in `.env` only after testing.
- **Position size capped** at `MAX_PORTFOLIO_USD` in `.env`. Bot will never
  deploy more capital than this, regardless of available balance.
- **Whitelist-only**. Bot trades only tokens in `tokens.json`. Adding tokens
  requires manual verification (LP locked, liquidity > $1M, contract audited).
- **No leverage**. Spot trades only.
- **No private key access**. Keys are in OKX TEE, not visible to bot or agent.
- **Never exports the wallet**. The bot only ever calls `wallet status`,
  `wallet balance`, `wallet addresses`, `market kline`, `signal list`,
  `token price-info`, `swap quote` and `swap execute`. There is no
  export-detection logic — don't run other tooling against the same login.
- **Swaps run exactly once**. A timed-out `swap execute` is never retried
  (it may already be on-chain); the error surfaces for the next tick.

## Files

- `bot.js` — main loop and orchestration
- `signals.js` — technical indicators (SMA, volume, relative strength)
- `strategy.js` — entry/exit decision logic
- `risk.js` — state machine, position sizing, anti-pattern detector
- `execution.js` — OKX OnchainOS API wrapper (swaps, balance checks)
- `state.js` — persistent state (positions, history, PnL)
- `logger.js` — structured logging
- `notify.js` — every Telegram message: tiers, throttling, formatting
- `tokens.json` — tradable token whitelist
- `state.json` — runtime state (gitignored, auto-created)
- `holders_history.json` — hourly holder-count snapshots per token (gitignored)
- `scripts/status.js` — read-only status snapshot (`npm run status`)
- `test/` — `node:test` suite (`npm test`)
- `deploy/` — systemd unit, Dockerfile, compose file, ops runbook

## Disclaimer

This skill executes real on-chain trades and can lose money. The author makes
no guarantee of profit. Trading is at the user's own risk. Conform to the OKX
Agentic Wallet competition rules at all times. See `README.md` for full details.
