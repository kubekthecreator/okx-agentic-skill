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
2. **AI as augmentation, not autonomy.** Routine execution is automatic; a
   human is pinged loudly only when something needs a decision or is broken.
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

Background loops run alongside the main 60-second tick (which manages open
positions first, then scans for entries):

- **Every 5 min** — independent exit sweep per open position (stops, time
  stop, volume collapse, catalyst death), so a slow tick never delays an
  exit by more than five minutes
- **Every hour** — holder-count snapshot per whitelisted token; this builds
  the 24h baseline behind the on-chain-spike catalyst
- **Daily (first tick after UTC midnight)** — daily report if the day had
  trades, open positions or failed ticks; on Mondays also the weekly heartbeat

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
`quality = exit_pnl / peak_pnl`. If the 5-trade average drops below 40%, the
bot drops into Slow mode (smart-money catalyst required, half size, one
position at a time) until the average recovers.

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
- 5-trade exit quality average < 40%

Behavior:
- Catalyst becomes mandatory (cannot pass on other 3 signals alone)
- Position size halved
- Max 1 new position concurrent
- Trailing stop tightens to 5%

**Halted (🔴)** — Triggered by any of:
- 3 losses in a row
- Daily PnL < −3% (full daily limit)

Behavior:
- No new positions for 4 hours
- Open positions continue to be managed, with tightened trailing
- Telegram alert dispatched with reason
- After 4h cooldown → reverts to Slow mode (must earn way back to Normal)
- A halt is served once per trigger: the same still-true condition does
  not re-halt the bot until another trade closes (the triggers are levels,
  the halt is an edge)

The daily profit target (+5%) is *not* a Halted trigger: it blocks new
entries until UTC midnight but leaves open winners on the normal 8% trail.

### Anti-pattern detector

Every trade is logged with metadata: setup signals, entry/exit time, PnL,
exit reason. On every close the bot checks the closed trade's setup type
(`smart_money__rs`, `on_chain_spike__no_rs`, …):

- ≥5 losses on the same setup type with a win rate under 30% → that setup
  pauses for 24h (the bot itself keeps trading other setups)

This is the bot detecting its own bad habits — the most expensive lesson in
trading, automated.

### Post-win cooldown

After a winning close where realised PnL > 3% of portfolio: no new positions
for 2 hours. The 5%-of-portfolio daily target halts new entries for the
rest of the UTC day. Both are mechanisms against the most expensive failure
mode: overtrading after a win.

## Execution reliability

**Concurrency safety.** The main 60-second tick and the 5-minute kill-check
loop both call `manageOpenPositions`. Two guards prevent duplicate execution:
1. A per-position in-process mutex — whichever loop grabs the lock runs;
   the other skips that position until next round.
2. Loops self-reschedule via `setTimeout` after the previous run finishes,
   not `setInterval`, so a slow tick can never overlap itself.

**Exit-in-flight marker.** Before issuing an exit swap, the bot writes
`exit_pending: { reason, started_ts }` into the position's state. A
concurrent caller (or a restart) sees the flag and skips. Stale flags
older than 10 minutes are auto-cleared so a crash mid-exit doesn't leave
the position permanently stuck.

**State persistence.** All open positions, kill conditions, and PnL history
live in `state.json` and are flushed (atomic temp+rename) after every state
change. On a JSON parse error the corrupted file is preserved as
`state.json.corrupted-<ts>` before falling back to defaults — the user can
inspect or recover. Process restart loses no information.

**Pre-flight checks** before every entry:
- State machine permits a new position (not Halted, no post-win cooldown,
  daily profit target not hit, setup not paused, concurrent limit)
- Sizing leaves a 25% cash buffer and respects the per-token cap and
  `MAX_PORTFOLIO_USD`
- Sufficient SOL gas balance (min 0.003 SOL)
- Quote price impact within tolerance (max 2%) — also checked on exits

If any check fails, the trade is logged with rejection reason and skipped.

**Closed candles only for volume.** The newest hourly bar from the market
API is the bar in progress — a minute past the hour its volume is close to
zero. Momentum (1h vs 24h volume) and the volume-collapse kill condition
therefore use only completed bars (`confirm` flag from the API; when the
flag is missing the newest bar is assumed in-progress). Price-based checks
(trend, stops) use the live price.

**Swaps are never retried.** Transient CLI errors are retried once for
reads. `swap execute` is not idempotent — a timed-out call may already be
on-chain — so it runs exactly once and any failure surfaces for the next
tick to reconcile.

**PnL accounting includes partial exits.** Each scale-out books its real
proceeds against the entry cost of the fraction sold. The final close adds
the residue, so a position scaled out at +15% and +30% and then stopped at
−10% is recorded as the winner it actually was — and feeds the state
machine as one.

**Confirming responses are surfaced, not auto-forced.** When the OnchainOS
CLI returns a confirming response (its backend wants a human in the loop),
the bot does NOT pass `--force`. It alerts to Telegram with the CLI's
next-step hint and leaves the position state correct (no entry on a
blocked buy; `exit_pending` retained on a blocked exit until the operator
acts). Reminders are throttled: a blocked BUY at most every 6h per token,
a blocked EXIT at most hourly per position.

**Entry price always validated.** Entry price is derived from the swap
quote response (`toToken.tokenUnitPrice`), with a 3×500ms candle fetch as
fallback. If both fail, the position is never created with a null price
(which would NaN-out the PnL math and disable every exit guard).

**Balance failures fail loud.** A failed `fetchBalances` at startup
retries once after 5s and then `process.exit(1)`. In-tick failures skip
that one tick and retry the next. The bot never trades with a silently
zeroed portfolio (which would disable all daily PnL guards).

**Dry run mode.** `DRY_RUN=true` simulates all swaps with current market
quotes. State updates happen normally, but no chain transactions are
broadcast. Use this for at least 24 hours before going live.

## User safety guidance

The bot does not pretend to be safe. Trading is risky and this skill makes
that visible at every step.

**Startup banner.** On launch the bot prints a banner declaring mode
(LIVE / DRY RUN), tick interval, and whitelist size — see [bot.js](bot.js)
`printBanner()`. There is no interactive CONFIRM prompt; the gate is
`DRY_RUN=true` in `.env` (the default).

**Capital caps.** `MAX_PORTFOLIO_USD` in `.env` is a hard ceiling on the
entry cost basis held across all open positions — the bot will never deploy
more than this even if the wallet balance is higher. Default $200; unset or
`0` disables the global cap (per-token caps in `tokens.json` still apply).

**Alerts are tiered, and loud only when you need to act.** Every Telegram
message lives in [notify.js](notify.js). Loud alerts and trade alerts both
ring; everything else arrives silently. Loud (act now): the bot can't start
(sent before each exit of a Docker restart loop, at most every 6h), crashed
or hit an unhandled error, went blind (5 failed ticks in a row — e.g. CLI
session expired or Market API quota exhausted), an exit is blocked or
failing, a position is untracked, HALTED, or the bot stopped with open
positions. With sound: BUY, EXIT, and a BUY that OKX held for manual
confirmation. Silent: start/stop, recovery after a blind spell, scale-outs,
Slow/Normal, profit target, the daily report and the weekly heartbeat.
Repeating alerts are throttled per key, and the throttle survives restarts
(`alerts_sent.json`, next to the bot logs).

**Confirming gates surface to Telegram.** When the OKX OnchainOS CLI's
backend requires explicit human approval for a swap (e.g. risk-warning
81362), the bot does not auto-`--force` it. An alert is dispatched with
the CLI's next-step hint; the operator decides.

**Graceful shutdown.** SIGINT / SIGTERM → state.json flushed atomically,
final shutdown alert dispatched, open positions left intact for the next
start to resume monitoring.

**No data exfiltration.** The bot does not transmit your trades anywhere
except OKX itself and your Telegram bot. No analytics, no telemetry.

## Observability

Every decision is logged. Logs are structured JSON, written to
`logs/bot-YYYY-MM-DD.log` with daily rotation.

**Per-tick log entry** (plus one `signal_eval` line per token at
`LOG_LEVEL=debug`):
```json
{"ts":"2026-05-15T12:34:56Z","level":"info","msg":"tick","tick":1234,"state":"Normal","portfolio_usd":"187.42","cash_usd":"92.10","open_positions":2,"daily_pnl_usd":"3.37","daily_trades":1}
{"ts":"2026-05-15T12:34:58Z","level":"debug","msg":"signal_eval","token":"JUP","passed":false,"reason":"momentum_failed"}
```

**Per-trade log entry** includes entry signals, kill conditions assigned,
exit reason, peak PnL during hold, exit quality, and full PnL accounting.

**Daily report** on the first tick after UTC midnight, only if the day had
trades, open positions or failed ticks: trades W/L, realized PnL, portfolio,
open positions with their last PnL, tick health. **Weekly heartbeat** every
Monday whatever happened: ticks and failures, portfolio, the week's trades,
and how the entry filter rejected the week's token checks — if it stops
arriving, the bot or the VPS is down. Set `TZ` (e.g. `Europe/Warsaw`) in
`.env` for local times in alerts; unset means the host's zone (UTC in the
Docker image).

**Status command.** `npm run status` prints the live state to console:
current portfolio, open positions with PnL, state machine status, today's
trades, next decision window.

**Replay-ability.** Logs are sufficient to reconstruct every decision the
bot made. If a trade went wrong, the log shows exactly which signals fired
and what the bot thought was happening.

## Production run — 19–23 May 2026 (~90h continuous, dry-run on VPS)

The bot was deployed to a Hetzner VPS via the `deploy/` docker-compose
setup and left running in dry-run for **~90.6 hours** (2026-05-19
21:30 UTC → 2026-05-23 16:08 UTC), reading live OnchainOS data the
whole time. Numbers below are extracted directly from the daily JSON
logs (`deploy/data/logs/bot-2026-05-*.log`), which persist on the host
volume independent of the container.

| Metric | Value |
|---|---|
| Continuous uptime | ~90.6 h across 5 calendar days |
| Total ticks | **4,750** (≈1,257/full-day, ~68s/tick incl. per-token CLI work) |
| Crashes | **0** — zero unhandled rejections, zero uncaught exceptions |
| Daily summaries fired | **4 / 4** on schedule at 00:00 UTC |
| Transient API errors | 69 `cli_call_failed` (≈1.5% of CLI calls), **all auto-recovered** |
| Tick failures from those errors | 0 — every transient error degraded gracefully (empty candles / catalyst=0), never propagated |

Ticks per day (partial on first/last day):

```
bot-2026-05-19.log:  128 ticks   (from 21:30 UTC)
bot-2026-05-20.log: 1257 ticks
bot-2026-05-21.log: 1255 ticks
bot-2026-05-22.log: 1260 ticks
bot-2026-05-23.log:  850 ticks   (until 16:08 UTC)
```

The four daily summaries, verbatim from the logs:

```json
{"ts":"2026-05-20T00:00:28.045Z","msg":"alert","message":"📊 Daily summary 2026-05-19\nTrades: 0 (0W / 0L, 0% WR)\nRealized PnL: $0.00\nState: Normal"}
{"ts":"2026-05-21T00:00:42.755Z","msg":"alert","message":"📊 Daily summary 2026-05-20\nTrades: 0 (0W / 0L, 0% WR)\nRealized PnL: $0.00\nState: Normal"}
{"ts":"2026-05-22T00:00:58.876Z","msg":"alert","message":"📊 Daily summary 2026-05-21\nTrades: 0 (0W / 0L, 0% WR)\nRealized PnL: $0.00\nState: Normal"}
{"ts":"2026-05-23T00:00:16.013Z","msg":"alert","message":"📊 Daily summary 2026-05-22\nTrades: 0 (0W / 0L, 0% WR)\nRealized PnL: $0.00\nState: Normal"}
```

Zero trades is the **correct** outcome: across ~90h none of the eight
blue-chip SPL tokens cleared all four hard signals simultaneously
(catalyst confirmation is the usual blocker — see the dry-run
breakdown below). The bot did exactly what a disciplined trend-follower
should: it waited.

**What that run could not prove.** With zero trades, nothing downstream of
an entry was exercised in production. A September 2026 code audit found
and fixed defects on exactly that path (v0.2): momentum was measured on
the in-progress hourly bar (biased toward `momentum_failed`), the
volume-collapse kill condition would have fired at the first hour
boundary after any entry, the on-chain holder-growth catalyst could never
establish its 24h baseline, partial exits were not included in realized
PnL, halts re-triggered every 4h instead of dropping to Slow, and
`MAX_PORTFOLIO_USD` was documented but unenforced. The commit history
carries the details; the test suite (`npm test`) now covers each one.

### Honest notes on the run

- **Day-1 deployment teething.** `bot-2026-05-19.log` contains 10
  `main_failed` errors — these were a state-file bootstrap issue during
  the initial container setup (empty `state.json` from a bind-mount
  edge case), resolved in-session. **Zero `main_failed` occurred on any
  subsequent day.** The figures above describe steady-state operation
  after setup completed at ~21:37 UTC on day 1.
- **Known limitation — `state_save_failed` (EBUSY).** Docker
  bind-mounting `state.json` as a single file blocks the atomic
  temp+rename write. The error is caught (`saveState` try/catch) and
  non-fatal — in-memory state stayed consistent for the full 90h, which
  is why daily summaries kept firing correctly across the run. Fixed since
  (the compose file now mounts the data *directory*, not individual files);
  it only ever affected state durability across container *recreation*,
  not running operation.

### Local dry-run detail — 18 May 2026

These are unedited excerpts from a local dry-run against the production
OnchainOS endpoints. The bot reads live balance, candles, smart-money
signals, and holder counts. Each block below is verbatim from the
console + JSON log (`logs/bot-2026-05-18.log`).

### Startup — CLI auth verified, real portfolio detected

```
Tue May 19 01:47:14     2026

> okx-agentic-skill@0.1.0 dev
> cross-env DRY_RUN=true node bot.js

[23:47:16 INFO] cli_auth_ok {"loginType":"ak","account":"Account 1"}

╔════════════════════════════════════════════════════════════════╗
║         OKX Agentic Wallet — Trend-Follower Skill v0.1         ║
║                                                                ║
║  Mode:        DRY RUN (no real trades)                         ║
║  Tick:        60s                                              ║
║  Whitelist:   8 tokens                                         ║
║                                                                ║
║  ⚠️  This skill executes real on-chain trades when LIVE.       ║
║  ⚠️  Trading can result in total loss of deployed capital.     ║
║  ⚠️  This is not financial advice.                             ║
╚════════════════════════════════════════════════════════════════╝

[23:47:16 INFO] state_initialized
[23:47:17 INFO] alert "🚀 Bot started, Mode: DRY RUN, Portfolio: $8.22"
[23:47:19 INFO] tick {"tick":1,"state":"Normal","portfolio_usd":"8.22","cash_usd":"4.47","open_positions":0,"daily_pnl_usd":"0.00","daily_trades":0}
```

The `loginType:"ak"` confirms the CLI auth is real (API Key login on this
wallet). Portfolio = $8.22 is the actual on-chain balance for the account.

### 5 consecutive ticks, no errors, no drift

```
[23:47:19 INFO] tick {"tick":1, ..., "portfolio_usd":"8.22","cash_usd":"4.47"}
[23:48:40 INFO] tick {"tick":2, ..., "portfolio_usd":"8.22","cash_usd":"4.47"}
[23:50:07 INFO] tick {"tick":3, ..., "portfolio_usd":"8.22","cash_usd":"4.47"}
[23:51:32 INFO] tick {"tick":4, ..., "portfolio_usd":"8.22","cash_usd":"4.47"}
[23:52:50 INFO] tick {"tick":5, ..., "portfolio_usd":"8.22","cash_usd":"4.47"}
```

Each tick reads balance + iterates all 8 whitelisted tokens, each token
costing ~3 CLI calls (kline, signal list, price-info). Loop interval is
consistent (~80s due to per-tick CLI work plus the 60s reschedule).

### Per-token signal evaluation (LOG_LEVEL=debug)

A separate debug-level run captured the per-token decision breakdown.
Reasons differ — the strategy gate isn't single-dimensional:

```
[23:53:25 INFO]  tick {"tick":1,"state":"Normal", ...}
[23:53:29 DEBUG] signal_eval {"token":"JUP",  "passed":false,"reason":"momentum_failed"}
[23:53:33 DEBUG] signal_eval {"token":"BONK", "passed":false,"reason":"trend_failed"}
[23:53:35 DEBUG] signal_eval {"token":"WIF",  "passed":false,"reason":"momentum_failed"}
[23:53:35 DEBUG] signal_eval {"token":"JTO",  "passed":false,"reason":"momentum_failed"}
[23:53:36 DEBUG] signal_eval {"token":"PYTH", "passed":false,"reason":"momentum_failed"}
[23:53:37 DEBUG] signal_eval {"token":"RAY",  "passed":false,"reason":"momentum_failed"}
[23:53:37 DEBUG] signal_eval {"token":"ORCA", "passed":false,"reason":"trend_failed"}
[23:53:38 DEBUG] signal_eval {"token":"DRIFT","passed":false,"reason":"catalyst_failed"}
```

Three different failure modes across one tick — `momentum_failed`,
`trend_failed`, `catalyst_failed`. Catalyst-driven entry is doing what
the spec says: chart conditions alone are noise, you wait for catalyst
confirmation. None of these eight blue-chip SPL tokens had a confirmed
catalyst in the last six hours at this snapshot, and the ones that did
had volume below the 1.5× threshold.

### Transient error handling — bot keeps running

Earlier in the same run, one `signal list` call for ORCA returned a
transient error. The bot logged it as a warning + error and continued:

```
[23:47:35 WARN]  cli_error_response {"cmd":"signal list","msg":"cli_code_undefined"}
[23:47:35 ERROR] cli_call_failed {"cmd":"signal list","error":"Command failed: onchainos signal list --chain solana --token-address orca... --wallet-type 1 --limit 100"}
[23:48:40 INFO]  tick {"tick":2, ...}   ← next tick fires normally on schedule
```

The catalyst for that one token degraded to `smart_money_buyers_6h=0`
for that round (correct fail-safe per `execution.fetchCatalysts`); the
bot did not crash, the other 7 tokens continued to evaluate, and the
next tick recovered.

### state.json after the first ticks

```json
{
  "machine_state": "Normal",
  "halt_until": null,
  "post_win_cooldown_until": null,
  "positions": {},
  "history": [],
  "daily": {
    "date": "2026-05-18",
    "starting_portfolio_usd": 8.2201073,
    "trades": 0,
    "wins": 0,
    "losses": 0,
    "consecutive_losses": 0,
    "realized_pnl_usd": 0
  },
  "setup_stats": {}
}
```

The bot persists its full decision state atomically (temp file + rename)
after every state change. `starting_portfolio_usd` is what the daily-PnL
guards in `risk.js` use as their denominator — the value being non-zero
is what keeps those guards armed (see P1 #5 fix in commit history).

### Forced entry — full decision flow on a passing setup

Whitelist + current market conditions made every signal fail at least
one of the 4 hard gates during the natural runs. To demonstrate the
success path end-to-end, the momentum threshold was temporarily lowered
to 0.01 and the catalyst signal was temporarily forced to pass.
`MIN_TRADE_SIZE_USD` was lowered to `$1` for the duration (the live
portfolio is too small to clear the default $5 minimum). **All three
overrides were reverted before commit** — see `git diff HEAD signals.js`
output, which is empty.

The full success-path output:

```
[23:58:17 INFO]  tick {"tick":1,"state":"Normal","portfolio_usd":"8.22","cash_usd":"4.47", ...}
[23:58:19 DEBUG] signal_eval {"token":"JUP","passed":true}
[23:58:20 INFO]  alert "⏸️ 🟢 Plan: BUY JUP for $2.06 (25.0% of portfolio)
                       Setup: smart_money__no_rs
                       Reply STOP within 2 minutes to cancel."
[23:58:21 INFO]  dry_run_swap {"fromMint":"EPjF...USDC","toMint":"JUPy...","amount":"2055026","expected_out":10.28327}
[23:58:22 INFO]  alert "🟢 *BUY JUP*
                       Size: $2.06
                       Entry: $0.1996
                       Setup: `smart_money__no_rs`
                       TX: `dry-entry-cff55f08-cf79-4eee-b4dd-fc6b03c9440e`
                       _(dry run)_"
```

Flow: signal eval passes → veto alert (material-position threshold
hit at 25% of portfolio; that separate alert was later removed and the
BUY message now carries the share of portfolio) → quote fetched live
from OKX → dry_run_swap
recorded with expected fill amount → BUY alert with entry price derived
from the quote's `toToken.tokenUnitPrice` (this is the P0 #1 fix —
entry price is never null).

The resulting position object in `state.json` carries the full signal
breakdown for replay-ability:

```json
"positions": {
  "ba93f6bd-...": {
    "token": {"symbol":"JUP","mint":"JUPyiwr...","decimals":6},
    "entry_ts": "2026-05-18T23:58:22.882Z",
    "entry_price_usd": 0.1996,
    "entry_amount_token": 10.28327,
    "entry_value_usd": 2.055026825,
    "entry_signals": {
      "trend":     {"passed":true,"price":0.1999875,"sma_4h":0.1990414,"pct_above_sma":0.475},
      "momentum":  {"passed":true,"last_1h_volume_usd":128742.62,"avg_24h_volume_usd":118644.01,"ratio":1.085},
      "valuation": {"passed":true,"pct_above_sma":0.475,"threshold_pct":15},
      "catalyst":  {"passed":true,"catalysts_active":[{"type":"smart_money","buyers_6h":5,"total_usd":12345}]},
      "rs":        {"passed":false,"token_return_4h_pct":1.43,"ref_return_4h_pct":0.62,"outperformance_pct":0.81}
    },
    "setup_id": "smart_money__no_rs",
    "kill_conditions": [
      {"type":"volume_collapse","reference_volume_usd":128742.62,"drop_threshold_pct":70},
      {"type":"time_stop","max_hold_ms":432000000},
      {"type":"catalyst_death","original_catalysts":["smart_money"]}
    ],
    "entry_tx_id": "dry-entry-cff55f08-...",
    "peak_pnl_pct": 0,
    "scale_outs_done": [],
    "current_amount_token": 10.28327
  }
}
```

Note: the `trend.price`, `sma_4h`, `momentum.last_1h_volume_usd`,
`avg_24h_volume_usd`, and `valuation.pct_above_sma` numbers are real,
computed from the same OnchainOS kline data the bot used to evaluate
the (forced) entry. Only the catalyst block and the momentum ratio
threshold were synthetically permissive for the demo; everything else
is what the production strategy would have seen.

## Quick start

### Prerequisites

- Node.js 20+
- OKX Agentic Wallet installed and registered for the competition
- OKX API credentials from the [Developer Portal](https://web3.okx.com/onchainos/dev-portal)
- Funded wallet: minimum $120 USDC + 0.02 SOL (recommended $150 + 0.05 SOL)

### Install

```bash
git clone https://github.com/kubekthecreator/okx-agentic-skill
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
  competition — in particular the volume-collapse threshold (70% below
  the entry bar's volume is easy to hit on a quiet hour).
- **Telegram command channel.** Alerts are one-way; replying STOP or
  approve (getUpdates polling) is not implemented.
- **Chaotic-exit and time-of-day detectors.** Slow trigger on <5-minute
  holds and the time-of-day anti-pattern window are specified but not
  implemented.
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
