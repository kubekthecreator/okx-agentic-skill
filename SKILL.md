---
name: okx-trend-follower
version: 0.1.0
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
mechanically. For material decisions, alerts are dispatched to a human with a
veto window.

**Consistency beats conviction.** This is not a system designed to nail bottoms
or moonshots. It's designed to make the same disciplined decision every time the
same setup appears.

**Every position requires a catalyst.** Pure chart patterns are noise.
A position only opens when at least one of these is true: smart money cluster
accumulation, news event, or on-chain spike (holders growing, mint volume rising).

## Capabilities

- Multi-signal entry filter (trend, momentum, valuation, catalyst, relative strength)
- 3-state risk machine (Normal → Slow mode → Halted) with auto-recovery
- Position-level kill conditions evaluated every 5 minutes
- Scaled exits (no single TP — partials at +15%, +30%, +50%, trailing on residue)
- Daily loss limit and daily profit target
- Post-win cooldown to prevent overtrading
- Anti-pattern detector: bot halts setups that consistently lose
- Peak PnL tracking with exit quality measurement
- Telegram alerts for all material events

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
| Slow mode | 2 losses today, OR daily PnL < −1.5%, OR exit quality < 40% (5-trade avg), OR chaotic exit (<5min hold) | Tighter filters (must have smart money), half size, max 1 new position |
| Halted | 3 losses in a row, OR daily PnL < −3%, OR anti-pattern detected | No new positions for 4h. Existing positions: trailing stop tightens. Telegram alert. After 4h → Slow mode (not Normal) |

Daily profit target +5% → no new positions until UTC midnight (post-win discipline).

## Usage

The skill is invoked from an AI agent (Claude Code / Cursor / Codex CLI / OpenCode).

```
Run the OKX trend-follower bot
```

The agent will spawn `bot.js`, which runs the main loop indefinitely.

### Commands

- `npm start` — live trading
- `npm run dev` — dry run (no transactions, simulated fills)
- `npm run status` — current portfolio, open positions, state machine status

### Manual override

Send `STOP` to the Telegram bot to halt all new positions. Send `RESUME` to
return to Normal state. Open positions continue to be managed regardless.

## Safety Considerations

- **Dry-run by default**. Set `DRY_RUN=false` in `.env` only after testing.
- **Position size capped** at `MAX_PORTFOLIO_USD` in `.env`. Bot will never
  deploy more capital than this, regardless of available balance.
- **Whitelist-only**. Bot trades only tokens in `tokens.json`. Adding tokens
  requires manual verification (LP locked, liquidity > $1M, contract audited).
- **No leverage**. Spot trades only.
- **No private key access**. Keys are in OKX TEE, not visible to bot or agent.
- **Wallet export = competition disqualification AND skill disable**. The bot
  detects export attempts and shuts down.

## Files

- `bot.js` — main loop and orchestration
- `signals.js` — technical indicators (SMA, volume, relative strength)
- `strategy.js` — entry/exit decision logic
- `risk.js` — state machine, position sizing, anti-pattern detector
- `execution.js` — OKX OnchainOS API wrapper (swaps, balance checks)
- `state.js` — persistent state (positions, history, PnL)
- `logger.js` — structured logging + Telegram alerts
- `tokens.json` — tradable token whitelist
- `state.json` — runtime state (gitignored, auto-created)

## Disclaimer

This skill executes real on-chain trades and can lose money. The author makes
no guarantee of profit. Trading is at the user's own risk. Conform to the OKX
Agentic Wallet competition rules at all times. See `README.md` for full details.
