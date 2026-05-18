# OKX Trend-Follower — Agentic Wallet Skill

> A disciplined trend-following bot for the OKX Agentic Wallet Trading Competition.
> AI-augmented, not AI-autonomous. Built for the May 2026 competition; designed
> to be useful well beyond it.

## Why this skill exists

Most trading systems lose money for the same reason: traders don't manage
themselves. They have FOMO, they panic, they revenge-trade after a loss, they
break their own rules at 3 AM. The technique was never the problem.

This skill is built around one idea: **AI's edge is not better predictions —
it's the absence of emotion**. The bot enforces the rules a disciplined human
would set but cannot consistently follow. It exits when the catalyst dies.
It halts after a losing streak. It takes a 2h break after a big win to avoid
overtrading. None of these are clever. All of them require not feeling FOMO.

## Core design principles

1. **Every position needs a catalyst.** Chart patterns alone are noise. Entry
   requires smart-money confirmation, news flow, or on-chain holder growth.
2. **AI as augmentation, not autonomy.** Material decisions can ping a human
   with a veto window. Routine execution is automatic.
3. **Consistency beats conviction.** Same setup → same action, every time.
4. **The first job of risk control is to stop trading.** Losing streaks,
   exhausted daily limits, and pattern-loss detection all trigger halts.
5. **Whitelist-only.** Eight large SPL tokens. No mem-sniper roulette.

## Architecture

```
                ┌─────────────────────────────────────┐
                │  Data sources (OKX OnchainOS API)   │
                │  market data · smart money · holders │
                └─────────────────┬───────────────────┘
                                  │
                ┌─────────────────▼───────────────────┐
                │   Strategy layer (signals.js)        │
                │   4 hard signals + 1 booster         │
                │   • Trend (SMA 4h)                   │
                │   • Momentum (volume 1h vs 24h)      │
                │   • Valuation (not extended)         │
                │   • Catalyst (smart money/news/spike)│
                │   • Relative strength (booster)      │
                └─────────────────┬───────────────────┘
                                  │
                ┌─────────────────▼───────────────────┐
                │   Risk machine (risk.js)             │
                │   State: Normal | Slow mode | Halted │
                │   Daily PnL guards · cooldowns       │
                │   Anti-pattern detector              │
                └─────────────────┬───────────────────┘
                                  │
                ┌─────────────────▼───────────────────┐
                │   Execution layer (execution.js)     │
                │   Position sizing · scale-out        │
                │   Per-position kill conditions       │
                └─────────────────┬───────────────────┘
                                  │
                ┌─────────────────▼───────────────────┐
                │   OKX swap + Telegram + logs         │
                └─────────────────────────────────────┘
```

Three concurrent monitoring loops run alongside the main flow:

- **Every 60s** — peak unrealized PnL snapshot per position
- **Every 5 min** — kill condition check per open position
- **Every 30 min** — catalyst freshness check (smart money still in? news still alive?)

## Strategy completeness

The strategy is a complete, testable system spanning four dimensions:

**Selection — what to trade.** Whitelist of eight SPL tokens with verified
liquidity (each > $1.5M LP), known contracts, and trader interest. No tokens
are added without manual review (see `tokens.json` for criteria).

**Entry — when to buy.** All four hard signals must pass:

| Signal | Threshold | Source |
|--------|-----------|--------|
| Trend | price > SMA(4h) | OKX market data |
| Momentum | volume(1h) > 1.5 × avg(volume, 24h) | OKX market data |
| Valuation | price ≤ 1.15 × SMA(4h) | derived |
| Catalyst | smart money cluster OR news flow OR holders +5% / 24h | OKX top traders + on-chain |

A booster signal (relative strength: token outperforms SOL by ≥5% over 4h)
scales position size up by 25% when triggered.

**Position management — what to do while in.** Every open position is
monitored continuously. Three exit families compete; whichever fires first
wins:

- *Scaled take-profit*: +15% sell 20%, +30% sell 30%, +50% sell 30%, 20% residue trails
- *Stops*: hard −10% from entry, trailing −8% from peak (−5% in Slow mode)
- *Kill conditions*: catalyst death, volume collapse, time stop (5 days)

**Exit quality — measuring how well we sold.** After every close:
`quality = exit_pnl / peak_pnl`. If 5-trade average drops below 40%, the bot
recognises it's exiting too early and auto-widens trailing stops.

## Risk control framework

A three-tier state machine. Every entry passes through it.

### State definitions

**Normal (🟢)** — Default operating state.
- All entry rules at standard thresholds
- Full position sizing (per-token cap from `tokens.json`)
- Up to 3 concurrent positions

**Slow mode (🟡)** — Triggered by any of:
- 2 losses today
- Daily PnL < −1.5% (half of daily limit)
- Last exit was chaotic (<5 min hold)
- 5-trade exit quality average < 40%

Behavior:
- Catalyst becomes mandatory (cannot pass on other 3 signals alone)
- Position size halved
- Max 1 new position concurrent
- Trailing stop tightens to 5%

**Halted (🔴)** — Triggered by any of:
- 3 losses in a row
- Daily PnL < −3% (full daily limit)
- Daily profit > +5% (post-win discipline, halts new entries only)
- Anti-pattern detector: 5 losses on same setup type

Behavior:
- No new positions for 4 hours
- Open positions continue to be managed, with tightened trailing
- Telegram alert dispatched with reason
- After 4h cooldown → reverts to Slow mode (must earn way back to Normal)

### Anti-pattern detector

Every trade is logged with metadata: setup signals, entry/exit time, PnL,
exit reason. A background analyser runs every 24h to find patterns:

- 5 losses on the same setup type → that setup pauses for 24h
- 3 losses in a row in same time-of-day window → that window pauses for 24h

This is the bot detecting its own bad habits — the most expensive lesson in
trading, automated.

### Post-win cooldown

After a winning close where realised PnL > 3% of portfolio: no new positions
for 2 hours. The 5%-of-portfolio daily target halts new entries for the
rest of the UTC day. Both are mechanisms against the most expensive failure
mode: overtrading after a win.

## Execution reliability

**Idempotent operations.** Every trade carries a client-generated UUID.
Retries on network failure reference the same ID, so a flaky connection
cannot double-execute.

**State persistence.** All open positions, kill conditions, and PnL history
live in `state.json` and are flushed after every state change. Process
restart loses no information. Tested by killing the bot mid-trade and
restarting — open positions resume monitoring without manual intervention.

**Pre-flight checks** before every swap:
- Sufficient SOL gas balance (min 0.003 SOL)
- Quote slippage within tolerance (max 2%)
- Token not in cooldown
- State machine permits the action
- Daily limit not breached

If any check fails, the trade is logged with rejection reason and skipped.
No silent failures.

**Rate limiting.** The bot respects OKX API limits with a token-bucket
backoff. A 429 response is logged but never crashes the loop.

**Dry run mode.** `DRY_RUN=true` simulates all swaps with current market
quotes. State updates happen normally, but no chain transactions are
broadcast. Use this for at least 24 hours before going live.

## User safety guidance

The bot does not pretend to be safe. Trading is risky and this skill makes
that visible at every step.

**Before first run, the bot displays:**
```
⚠️ This skill executes real on-chain trades.
⚠️ Trading can result in total loss of deployed capital.
⚠️ This is not financial advice.
⚠️ You are participating in a competition with explicit rules — read them.

Continue? Type CONFIRM to proceed.
```

**Capital caps.** `MAX_PORTFOLIO_USD` in `.env` is a hard ceiling — bot will
never deploy more than this even if wallet balance is higher. Default $200.

**Material decisions ping a human.** Any position > 15% of portfolio
dispatches a Telegram alert with a 2-minute veto window before execution.
Replying STOP cancels the trade. Silence → proceed (this is intentional,
so the bot doesn't stall when you're asleep).

**Emergency controls.**
- `STOP` to Telegram bot → halt all new positions
- `EXIT` to Telegram bot → close all positions at market
- Pressing Ctrl-C → graceful shutdown, state flushed, positions left open

**Wallet export detection.** If the bot detects an export attempt on the
agentic wallet (which would disqualify the participant from the competition
and give the agent unencrypted keys), it immediately halts and dispatches
an alert.

**No data exfiltration.** The bot does not transmit your trades anywhere
except OKX itself and your Telegram bot. No analytics, no telemetry.

## Observability

Every decision is logged. Logs are structured JSON, written to
`logs/bot-YYYY-MM-DD.log` with daily rotation.

**Per-tick log entry:**
```json
{
  "ts": "2026-05-15T12:34:56Z",
  "tick": 1234,
  "state": "Normal",
  "portfolio_usd": 187.42,
  "open_positions": 2,
  "daily_pnl_pct": 1.8,
  "decisions": [
    {
      "token": "JUP",
      "action": "skip",
      "reason": "catalyst_missing",
      "signals": { "trend": true, "momentum": true, "valuation": true, "catalyst": false }
    }
  ]
}
```

**Per-trade log entry** includes entry signals, kill conditions assigned,
exit reason, peak PnL during hold, exit quality, and full PnL accounting.

**Daily summary** sent to Telegram at 00:00 UTC:
- Trades count, win rate, PnL
- Exit quality average
- State machine transitions
- Setup type performance (which signal combinations made/lost money)

**Status command.** `npm run status` prints the live state to console:
current portfolio, open positions with PnL, state machine status, today's
trades, next decision window.

**Replay-ability.** Logs are sufficient to reconstruct every decision the
bot made. If a trade went wrong, the log shows exactly which signals fired
and what the bot thought was happening.

## Quick start

### Prerequisites

- Node.js 20+
- OKX Agentic Wallet installed and registered for the competition
- OKX API credentials from the [Developer Portal](https://web3.okx.com/onchainos/dev-portal)
- Funded wallet: minimum $120 USDC + 0.02 SOL (recommended $150 + 0.05 SOL)

### Install

```bash
git clone https://github.com/YOUR_USER/okx-agentic-skill
cd okx-agentic-skill
npm install
cp .env.example .env
# Edit .env with your OKX credentials
```

### Run in dry mode

```bash
npm run dev
```

The bot will fetch market data, evaluate signals, but **not** execute trades.
Watch the logs to verify everything looks reasonable. Leave running for at
least 1 hour.

### Run live

```bash
# Set DRY_RUN=false in .env
npm start
```

Recommended deployment: a small VPS (Hetzner CAX11, ~€4/month) with the bot
running as a systemd service. See `deploy/` directory for sample unit file.

### Monitor

```bash
npm run status                    # live snapshot
tail -f logs/bot-*.log | jq .     # follow structured logs
```

Or just watch your Telegram for alerts.

## Competition compliance

This skill is built specifically for the **OKX Agentic Wallet Trading
Competition (7–21 May 2026)** but designed to function before and after.

- Trades **only** on Solana (the competition's primary tracked chain).
- Trades USDC ↔ SPL tokens, never stablecoin-to-stablecoin (which wouldn't
  count toward competition volume).
- Never exports the wallet (which would disqualify the participant).
- Never executes washes, hedges on external platforms, or other
  rule-circumventing maneuvers (which would also disqualify).
- Volume target awareness: bot prioritizes setups that build toward the
  $1000 volume threshold for leaderboard qualification, while never taking
  a trade purely for volume (which would lose money).

## Roadmap (post-competition)

Things deliberately not in v0.1 to keep scope realistic for the
2-week competition window:

- **News/social catalyst integration.** Currently the "news flow" catalyst
  is a stub — only smart-money and on-chain spike work. A Twitter/news API
  integration is the obvious next step.
- **Cross-chain support.** X Layer is in scope for the competition but not
  yet implemented here. Solana-only for now.
- **Backtest harness.** A simulator that replays historical OKX market
  data against the strategy. Critical for parameter tuning beyond the
  competition.
- **Web dashboard.** Read-only view of positions, PnL, state machine,
  decision log. Currently CLI + Telegram only.
- **Strategy variants.** Mean-reversion mode, mem-sniper mode (with
  separate stricter rules), market regime detection.

## Acknowledgements

Risk management philosophy borrowed liberally from
[@0xBarrry](https://x.com/0xBarrry), who has written extensively about
emotional state systems, catalyst-driven entries, and the discipline of
stopping after a good day. The 3-state risk machine in this skill is a
direct mechanical implementation of his Green/Yellow/Red framework.

## License

MIT. See `LICENSE`.

## Disclaimer

This software executes real on-chain trades and can lose money. The author
makes no guarantee of profitability. Cryptocurrencies are highly volatile
and trading them carries substantial risk. The author is not a financial
advisor and this skill does not constitute financial advice. Use at your
own risk. By running this skill, you accept full responsibility for all
trades it executes on your behalf.
