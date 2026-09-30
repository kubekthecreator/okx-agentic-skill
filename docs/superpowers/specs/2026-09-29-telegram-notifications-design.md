# Telegram notifications v2 — design

Status: approved by the owner 2026-09-29 ("yes to all": okx-bot only, weekly
heartbeat on quiet days, English copy).

## Why

An audit of the VPS logs for 22–29 Sep 2026 (9,518 ticks, 0 entries) found five problems.

1. **Noise.** The only regular message was a daily "Trades: 0, PnL $0.00".
   It was also sent with a notification sound.
2. **Wrong content.** `checkDailySummary` (60 s interval) races
   `state.rotateDaily` (tick). In 3 of the 7 September summaries the numbers
   came from the new, empty day.
3. **Critical silence.** Several failures only reach the JSON log, or nothing at all:
   - Startup failures `process.exit(1)` without an alert. The "CLI not logged
     in" path does not even write a JSON log line. This caused a silent restart
     loop from 21.09 to 22.09 18:18Z.
   - `tick_failed` is only logged.
   - A tick with no market data for any token (e.g. Market API quota exhausted
     on the shared key) is only logged.
   - `close_swap_failed` is only logged, so a triggered stop silently does not
     execute.
4. **Duplicates.**
   - `alertWithVeto` fires before every Normal-mode entry (25% of the portfolio
     is above its 15% threshold). It cannot veto, it duplicates BUY, and it
     embeds `setup_id` (e.g. `smart_money__rs`) unescaped under legacy Markdown,
     which almost certainly gets a Telegram 400.
   - "WIN cooldown" and "ANTI-PATTERN" arrive in the same second as EXIT.
5. **Spam paths (LIVE).**
   - BUY BLOCKED (CLI confirming) repeats every tick while the signal holds.
   - EXIT BLOCKED repeats about every 10 min.
6. **Fragile transport.**
   - Legacy `parse_mode: 'Markdown'`: an unpaired `_`/`*` gets HTTP 400 and the
     message is lost.
   - Only the status code is logged.
   - Raw codes (`trailing_stop_8pct`), raw floats, ISO UTC times, and
     `TX: dry-entry-<uuid>`.

## Goals / acceptance criteria

1. A quiet DRY RUN week sends at most **one silent message** (the weekly
   heartbeat).
2. Every failure that stops trading or blocks closing a position produces **one
   loud alert within ~6 min**. It never repeats faster than its throttle
   interval, including across a Docker crash-restart loop.
3. No message is lost to formatting: HTML with `esc()` for every dynamic value,
   plus a plain-text retry on HTTP 400.
4. The daily report describes the day that just ended.
5. Every message builder has a test. `npm test` is green, and `node --check`
   passes on every module.

## Non-goals

- Anything in onchain-scout.
- Telegram commands or replies. STOP-polling stays on the roadmap.
- New dependencies.
- Changing `MIN_TRADE_SIZE_USD` or wallet funding. Side finding: with $9.68,
  25% = $2.42 < $5, so the bot cannot size any entry. That is the owner's call.
- The Docker healthcheck.
- An external watchdog.

## Architecture

New module **`notify.js`** holds every Telegram message the bot can send. The
catalog in one file is the single place to review "what can I receive".
`logger.js` goes back to logging only.

`deploy/Dockerfile` copies an explicit module list, so it gains `notify.js`. A
test guards that list: a module missing from the image only shows up on the VPS,
as a silent crash-restart loop.

### Transport

- `send(html, { silent = false, key = null, everyMs = 0 })`
  - Calls Bot API `sendMessage` with `parse_mode: 'HTML'`, a 5 s timeout, and
    `disable_notification: silent`.
  - On HTTP 400 it retries **once** as plain text (tags stripped, entities
    unescaped).
  - Other failures log `telegram_send_failed` with `status` and Telegram's
    `description`. There is no retry loop.
  - It never throws.
  - It reads `TELEGRAM_BOT_TOKEN` / `TELEGRAM_CHAT_ID` at call time. Missing
    either means log only.
- Every send logs `alert` (message, silent). A suppressed send logs
  `alert_throttled` (key).
- **Throttle:**
  - Key → last-sent epoch ms, persisted in `<OKX_BOT_LOG_DIR or ./logs>/alerts_sent.json`.
    The data dir is mounted on the VPS, so the file survives restarts; this is
    what stops crash-loop spam.
  - A missing or corrupt file is treated as empty. Worst case is one duplicate.
  - Keys older than 7 days are pruned on write.
- Dynamic text is clipped to 300 chars (the Telegram limit is 4096).

### Tiers

| Tier | Sound | Messages |
|---|---|---|
| loud | yes | bot can't start, crashed, unhandled error, BLIND, EXIT BLOCKED, EXIT FAILING, BUY not tracked, HALTED, stopped **with** open positions |
| normal | yes | BUY, EXIT, BUY BLOCKED |
| silent | no | started, stopped (flat), recovered, scale-out, SLOW, back to NORMAL, daily profit target, daily report, weekly heartbeat |

### Throttle keys

| Message | Key | Interval |
|---|---|---|
| can't start | `cannot_start:<stable id>` (`tokens_unreadable`, `cli_not_logged_in`, `cli_unrunnable`, `balance_unreadable`, `startup_crash`); cleared by a successful start | 6 h |
| BLIND | in memory, per process | 30 min between BLIND alerts (flapping upstream) |
| message failed to build (fallback) | `alert_build_failed:<builder>` | 1 h |
| crashed | `crash:<message>` | 1 h |
| unhandled rejection | `unhandled:<message>` | 1 h |
| EXIT BLOCKED | `exit_blocked:<position id>` | 1 h |
| EXIT FAILING | `exit_failing:<position id>` | 1 h |
| BUY BLOCKED | `buy_blocked:<symbol>` | 6 h |

The other messages are one-off events and are not throttled.

### Blind detector (edge-triggered, in `notify.js`)

- `tickResult(ok, error)` is called once per main tick.
- A tick **fails** when it throws, or when it evaluated ≥1 token and none of
  them returned enough candles.
- On the **5th** consecutive failure: one loud "BLIND" alert with the duration
  and the last error.
- On the next success after an alert: one silent "recovered after X".
- The same function counts ticks and failures for the reports.

### Formatting

- Times: `toLocaleString('en-GB', { day: 'numeric', month: 'short', hour:
  '2-digit', minute: '2-digit', timeZoneName: 'short' })` in the process time
  zone, set via the standard `TZ` env var.
  - Verified on the `okx-bot:latest` image (Node 20.20.2, ICU 78.2):
    `TZ=Europe/Warsaw` gives `29 Sept, 23:40 CEST`; unset gives `29 Sept, 21:40 GMT+0`.
- Prices: `toLocaleString('en-US', { maximumSignificantDigits: 4 })`, which
  never uses exponent notation (`1.234e-7` gives `0.0000001234`).
- Money: `fmtSigned` (moved from strategy.js), using the Unicode minus sign.
- Durations: `45m`, `5h 12m`, `1d 6h`.
- `humanReason(code)` maps exit and state reason codes to words:
  - `hard_stop` → hard stop
  - `trailing_stop_<n>pct` → trailing stop (−n% from peak)
  - `time_stop_5d` → time stop (held 5 days)
  - `volume_collapse_<n>pct` → volume collapsed n% vs entry bar
  - `catalyst_death` → catalyst gone
  - `three_consecutive_losses` → 3 losses in a row
  - `daily_loss_limit` → daily loss limit hit
  - `two_losses_today` → 2 losses today
  - `half_daily_loss` → daily loss past half the limit
  - `low_exit_quality` → recent exits gave back most of their peak gains
  - unknown codes pass through.
- `humanSetup(id)`: `smart_money+on_chain_spike__rs` → `smart money + on chain
  spike · RS boost`.
- The DRY tag (`· DRY`) goes in the title of every trade message while
  `DRY_RUN !== 'false'`.
- A Solscan link is added only when the tx id looks like a Solana signature
  (base58, 80–90 chars).

### Message catalog (after)

| Function | Tier | Content |
|---|---|---|
| `started({portfolio_usd, open_positions})` | silent | mode, portfolio, open positions |
| `stopped({signal, open_positions})` | silent if 0, loud if >0 | signal; with positions: "stops are NOT enforced until it runs again" |
| `crashed(message)` / `unhandled(message)` | loud, throttled | message |
| `cannotStart(id, reason, hint)` | loud, 6 h | reason, "Docker keeps restarting it; nothing is traded or managed", fix hint |
| `tickResult(ok, error)` | loud BLIND / silent recovered | streak, duration, last error |
| `buy({...})` | normal | size $ + % of portfolio, entry price, setup in words, exit plan (stop price at −hard%, trail %, scale-out levels), tx |
| `buyBlocked({...})` | normal, 6 h | CLI message, next step, "bot will not force it" |
| `untracked({...})` | loud | swap fired but entry price unknown; stops NOT managed; close manually |
| `scaleOut({...})` | silent | level, % sold, proceeds, booked PnL |
| `exit({...})` | normal | PnL % and $, reason in words, peak, hold time, "kept X% of peak gain", today's running PnL W/L, notes (post-win cooldown until…, setup halted 24h) |
| `exitBlocked({...})` | loud, 1 h/position | exit reason, CLI message, next step, "position still open" |
| `exitFailing({...})` | loud, 1 h/position | exit reason, current PnL %, error, "retrying every tick" |
| `halted({reason, until, trailing_pct})` | loud | reason in words, until (local time), tighter trail, then Slow |
| `slow({reason})` / `normal()` | silent | reason in words |
| `profitTarget({pct})` | silent | "no new entries until 00:00 UTC (local time)" |
| `dailyReport({day, portfolio_usd, open_positions})` | silent | **only if** the day had trades, open positions, or failed ticks. Content: trades W/L, realized PnL, portfolio (delta vs day start in LIVE only), open positions with last PnL % and hold time, ticks/failed |
| `weeklyHeartbeat({portfolio_usd, week, funnel})` | silent | sent every Monday rotation regardless of activity: since, ticks/failed, portfolio, trades this week, "why no entries" funnel counts |

### Removed

- `alertWithVeto`: the "% of portfolio" figure moves into BUY.
- The separate WIN-cooldown and ANTI-PATTERN messages: `risk.onPositionClosed`
  now **returns** `{ cooldown_until, setup_halt }` and EXIT renders them.
- `checkDailySummary` and `last_summary_date`: the report is built from the
  return value of `state.rotateDaily()` (the day just ended).

### Entry funnel (for the heartbeat)

- `strategy.evaluateNewEntries` counts every token check by outcome in
  memory: `no_data`, the price/entry reason (`trend_failed`,
  `momentum_failed`, `valuation_failed`, `catalyst_failed`,
  `slow_mode_requires_smart_money`, …), `risk_gate`, `size_below_min`,
  `no_gas`, `entered`, `entry_failed`.
- `takeFunnel()` returns the counts and resets them.
- It also returns `{ evaluated, withData }` for the blind detector.
- `lastMarks` (a Map from position id to the latest pnl %) feeds the daily report.
- In-memory state resets on restart. The heartbeat states "since <time>".

## Testing

`test/notify.test.js` uses a stubbed `globalThis.fetch`, plus a temp
`OKX_BOT_LOG_DIR` and Telegram env. It covers:

- HTML body and the `disable_notification` value per tier;
- the plain-text retry on 400;
- throttle suppression and expiry, via a pre-seeded `alerts_sent.json`;
- the blind detector edges (4 failures → 0 sends, 5th → 1 loud, 6th → 0,
  success → 1 silent, success → 0);
- escaping, `humanReason`, `fmtPrice`;
- `exit` notes and the DRY tag;
- `dailyReport` skipping a quiet day;
- `weeklyHeartbeat` always sending.

`risk`/`state` tests cover:

- the `onPositionClosed` return value;
- `rotateDaily` returning the previous day.

`bot.js` (it runs `main()` on import) is verified manually: start with a
nonexistent CLI and no Telegram env, then check that an `alert` line is in the
JSON log before exit.

## Deploy

Separate step, with the owner's consent:

1. PR, then merge.
2. On the VPS: `git stash`, `pull --ff-only`, `stash pop`, keeping the local
   compose patch.
3. Add `TZ=Europe/Warsaw` to the VPS `.env`.
4. `up -d --build`.
5. Check the logs for `cli_auth_ok` + `tick`. The restart sends one silent
   "started".
