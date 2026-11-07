# Futures pivot: top-1 dossier, idea card, plan (2026-11-07)

Status: **PLAN ONLY, awaiting owner approval.** No bot code changed, nothing deployed, `DRY_RUN` untouched, VPS container `okx-bot` left stopped.

Labels: **M2** = measured two independent ways; **M1** = measured once; **V** = vendor/leaderboard's word; **J** = judgment or derived; **unverified** = no primary source. Research, not investment, legal or tax advice.

## 0. Summary

- **"Top-1 agent on OKX Agentic" = `1M · 斯巴达`**, winner of the OKX.AI Trading Hackathon S1 (trading 2026-08-11..08-25). It is the latest ranked trading contest on OKX's agent platform; no S2 is listed on okx.ai as of 2026-11-07, and the agent marketplace has no PnL ranking.
- **It traded leveraged perps on majors through Agent Trade Kit** (OKX CEX USDT-margined swaps), made +2,319.52 % (+$24,907.62) on about $1,074 in 14 days, **with an 82.6 % drawdown on the way** (6-hour samples), during a market where ETH rose 30.4 % and BTC 22.8 %. One six-hour window gave +372 % while ETH rose 8.7 %: effective leverage of roughly 33-58x (J). This is one lottery draw in one rally regime, not a repeatable process we can verify.
- **The population says the same.** 57 valid entrants: median +3.38 % while BTC was +22.8 %; summed trading PnL without #1 is **-$3,309** (-8.7 % pooled). For 38 of the 40 prize winners the $500-$7,000 prize was larger than their trading profit. The money in S1 came from OKX's $40,000 prize pool and signal subscriptions, not from the market.
- **Venue:** a Polish retail account cannot use the venue #1 used. okx.com redirects PL visitors to the EEA site; OKX Europe (Malta, MiFID II) offers **X-Perps** (5-year futures with perp-style funding), not perpetual swaps. Agent Trade Kit officially supports the EEA site and OKX simulated trading there. Whether the owner's account actually gets X-Perps needs an in-app check (KYC + appropriateness test).
- **Plan:** refute cheaply first. A historical replay on public OKX data (cost $0, no account) decides whether there is anything to paper-trade. Only if it passes do we refactor the bot into a perp **paper** bot (no live-order code in the repo at all) and run it forward for at least 90 days. Real money needs a separate, dated owner decision.

## 1. Top-1 agent dossier

### 1.1 Which leaderboard

| Candidate | Finding | Source (read 2026-11-07) |
|---|---|---|
| Agentic Wallet trading competitions (`onchainos competition list --status 2`) | Only one ever: #113 "Agentic Trading Contest", 2026-05-07..05-21, **spot** on Solana/X Layer, ended. #1 `Agentic....a1eb`, PnL% 9.29 (ratio, +929 %; unit inferred from the same platform's rendering). This is the contest this repo entered. | `onchainos competition rank --activity-id 113` (read-only) |
| okx.ai hackathons | **Trading Hackathon S1** (registration 07-31..08-11, trading 08-11 12:00 .. 08-25 12:00 UTC+8, 40,000 USDT): ranks agents (ASPs) by PnL % and PnL. Genesis (07-28, 100,000 USDT) is a product hackathon, not PnL-ranked. | https://www.okx.ai/hackathon, https://www.okx.ai/hackathon/trading-01 |
| okx.ai agent marketplace | Sorted by sales/ratings; "Trading" is a category, not a PnL ranking. Hackathon ASP IDs (8136, 2083) return 404 as `/agents/<id>`; current listing status of the winners is unverified. | https://www.okx.ai/agents |
| Agent Trade Kit | A toolkit (MCP/CLI for OKX CEX: spot, swap, futures, options, grid), not a ranking. | https://github.com/okx/agent-trade-kit |

**S1 rules that matter:** start with at least 300 USDT; choose one accounting basis at registration: **Onchain OS** (bind an Agentic Wallet address, any on-chain instrument) or **Agent Trade Kit** (bind an OKX UID, **only USDT perpetuals** counted). The ASP must stay online and sell a subscription service during the contest.

### 1.2 #1 `1M · 斯巴达` (ASP id 8136)

| Field | Value | Label |
|---|---|---|
| What it trades | Perps on BTC/ETH/SOL. OKX: "market analysis and trading signals for major cryptocurrencies such as BTC, ETH and SOL", subscribers "configure OKX Agent Trade Kit to automatically open, close or adjust trades". Contest feed: "Perp ETH-USDT-SWAP, short, market order, reference price 2481.47 to 2506.41". | V ([OKX Learn](https://www.okx.com/en-us/learn/okx-ai-2)), M1 (feed) |
| Venue | OKX global CEX USDT swaps via Agent Trade Kit (`-USDT-SWAP` instrument IDs) | M1 |
| Leverage | Not published. Inferred **≈ 33-58x effective**: equity x4.72 (+372 %) between 2026-08-19 10:00 and 16:00 UTC while ETH-USDT-SWAP went +8.7 % (high +11.2 %), BTC +6.4 %, SOL +5.9 % in the same 6-hour candle | J from M1 data |
| Holding time, trade count | Not published (unmeasured). The public feed shows only the last ~30 signals of all ASPs. | unverified |
| Result | +2,319.52 %, +$24,907.62 | V (leaderboard) |
| Principal | $1,074, the same from every one of 56 chart samples (`returnAmountUsd / returnRate`), so no deposits or withdrawals moved the base | M2 |
| Max drawdown | **82.6 %** on 6-hour samples: equity 6.11x at 08-17 16:00 UTC → 1.07x at 08-19 10:00 UTC. Intra-window drawdown can only be worse. | M1 |
| Concentration | Best three 6-hour windows = 61 % of final PnL; without the best five windows: +$3,974 | M1 |
| Track record | 14 days (one contest, one regime: ETH +30.4 %, BTC +22.8 % from 08-11 open to 08-25 close; breakout started 08-19) | M2 (OKX public candles) |
| Revenue besides trading | $10,000 prize; subscription $20/month, "Total sold" 157 (lifetime count, revenue unverified); rating 4.0 | V |
| Independent verification | **None possible.** CEX account bound by UID; no trade list, no address, agent page 404. The PnL is the leaderboard's word. | J |

### 1.3 #2-#5 for contrast (all from the same leaderboard, V)

| # | ASP | PnL % / PnL | Principal (derived) | Service / what it trades | Verifiable? |
|---|---|---|---|---|---|
| 2 | Pools Sentine | +244.95 % / +$748.51 | ~$306 (at the 300 USDT floor) | "TradePools Early Trading Signal"; feed shows Solana spot limit buys of fresh memecoins at ~0.0000065 (launch-curve price): the launch-sniping class onchain-scout killed after costs | On-chain in principle (Onchain OS), address not published |
| 3 | 磐衡量化 | +110.15 % / +$782.02 | ~$710 | "Mainstream Coin Perpetual Contract Signal", 2 sold | No (CEX) |
| 4 | Metagents | +79.37 % / +$792.95 | ~$999 | "Trade Kit Smart Money Signals" (perps), 6 sold | No (CEX) |
| 5 | PREX · 合约信号 | +27.56 % / +$86.78 | ~$315 | "Prex AI Trading Signals" (contract signals) | No (CEX) |
| 6 | Tachyo | +16.13 % / +$99.24 | ~$615 | "Onchain Smart Money Signals", $249/month | On-chain in principle |

Leverage, holding time and drawdown for #2-#6 are unmeasured: the chart API returns them, but the response was truncated in the browser tool and direct calls require a request signature.

### 1.4 Population and survivorship (M1, script in the evidence log)

- 57 valid entrants (at least one trade and online for the whole contest). Registrations that dropped out are invisible, so even this list is survivor-biased.
- 46 positive, 11 negative. **Median +3.38 %** over 14 days in which an unlevered BTC long made +22.8 %.
- Sum of trading PnL: +$21,599 (re-summed by a second parser: $21,598.69); **without #1: -$3,309** on ~$37,800 of principal (-8.7 %); without the top 5: -$5,719. #57 lost $5,896.59 (-74.7 %).
- Prizes: $40,000 in total, ranks 4-40 got $500 each. **For 38 of the 40 prize winners the prize exceeded the trading profit** (median trading PnL of ranks 4-40: $18.90).

**Reading (J):** the "agents that make money on OKX Agentic" made it from the prize pool and from selling signals. Trading itself was a negative-sum lottery that one high-leverage long-biased account won in a rally. Ranking first after 14 days with ~40x effective leverage and an 83 % drawdown is the textbook survivorship case.

### 1.5 What "operating like the top-1" would mean

| Component | Reachable for a Polish retail owner? |
|---|---|
| High-leverage directional perps on BTC/ETH/SOL via Agent Trade Kit on OKX global | **No as is**: global USDT swaps are not offered to PL; the EEA equivalent is X-Perps, marketed "up to 10x" (instrument field `lever` 50; retail cap unverified; ESMA treats perp-like crypto derivatives as likely CFDs with leverage limits) |
| Selling a signal subscription as an ASP on okx.ai | Technically yes, but needs marketplace writes (out of scope here) and a strategy worth selling. Selling unproven signals means subscribers pay for noise (J). |
| Winning a hackathon prize | No S2 announced; EEA eligibility for the Agent Trade Kit track unverified |
| Measuring the trading idea on paper | **Yes, today, at $0** (public data, no account) |

## 2. Idea card (owner format)

### H-F1: trend-following on BTC/ETH/SOL X-Perps, leverage ≤ 3x

| Field | Content |
|---|---|
| Mechanism (who pays us) | Time-series momentum: traders who under-react to persistent moves and late trend-chasers who exit at the wrong end. Literature finds crypto time-series momentum at **1-4 week** horizons (L, e.g. Liu & Tsyvinski 2021, "Risks and Returns of Cryptocurrency", RFS). Our own hourly momentum test was gross -0.34 bp vs a 10 bp round trip (M1, onchain-scout a4 §5), so the horizon must be daily, not intraday. Leverage does not create the edge; it only scales it, and scales ruin. |
| What the top-1 adds | Nothing we can measure: one 14-day draw at ~40x. We test the mechanism, not the agent. |
| Measured latency | Not latency-sensitive: signals on closed 1D (primary) / 4H (secondary) candles; a 60 s tick is irrelevant at this horizon (J). Public OKX REST from the dev box: 0.07-0.25 s (EEA candles), 0.31-0.35 s (global history candles, 100 rows), 3 calls each (M1). |
| Prior | **10-15 % (J)** that a pre-registered simple daily trend rule beats cash after costs out-of-sample on three coins. Reasons for low: every reachable mechanism in Aug-Oct failed after costs; carry was only a rate (40-45 % of rolling windows beat T-bills); the trend premium is well known and crowded. |
| Cheapest refutation | **Historical replay on public OKX data, $0, ~1 working session.** Parameters frozen in a pre-registration file before any out-of-sample bar is read. In-sample 2021-01-01..2024-12-31, out-of-sample 2025-01-01..2026-10-31. Price: global `BTC/ETH/SOL-USDT-SWAP` history candles (X-Perps exist only since April 2026; same index, perp-style funding). Costs: X-Perp taker 0.05 % per side + 3 bp slippage per side + funding 0.01 %/8 h paid on longs and 0 received on shorts (the X-Perp `interestRate` floor; conservative). |
| Cost limit | Money: $0 for replay and paper. No paid data, no x402, no new paid infra (VPS already paid). Time: replay ≤ 2 sessions; bot refactor ≤ 3 sessions and only if the replay passes. |

### Rejected card: copy the top-1 at 30x+

Payer unclear (the contest pool, not the market); track record 14 days; drawdown 83 %; leverage above what PL retail can legally use. **Not tested** except as a counterfactual column in the replay output (see 4.2).

## 3. Venue access (blocking question 1)

| Venue | Product | PL retail | Max leverage | Entity | Confidence |
|---|---|---|---|---|---|
| OKX global | USDT perpetual swaps | **No.** okx.com shows PL visitors "Wygląda na to, że jesteś w Polska. Przejdź do witryny Europa" | n/a | n/a | M1 (observed redirect 2026-11-07) |
| **OKX Europe** | **X-Perps** (`BTC-USD_UM_XPERP-310404` etc., expiry 2031-04-04, funding 0.01 %/8 h, `lever` 50; 287 FUTURES listed on the EEA API, 259 of them expiring in > 3 years) | "All 30 EEA countries", PL not named; KYC + MiFID appropriateness test | "up to 10x" marketed | OKX Europe Markets Ltd, Malta, MiFID II | Official for mechanism; PL by name unverified |
| Kraken EEA | Perps + dated futures | EEA residents, PL not named | up to 10x (press) | Payward Europe Digital Solutions (CY), CySEC 342/17 | Official entity; PL unverified |
| Binance | Futures | Restricted in PL since 2026-07-01 (no MiCA licence); owner's experience matches | n/a | n/a | Press |
| Hyperliquid | On-chain perps | Not geoblocked per third-party guides; **unlicensed** | venue max | none | Unverified vs primary terms |
| OnchainOS 4.2.1 | No perp commands. Hyperliquid only via a community plugin ("Created by GeoGu360") in the plugin store | Unlicensed venue path | n/a | n/a | M1 (CLI help), official page for plugin |
| Agent Trade Kit | CLI/MCP for OKX CEX API; **supports `eea.okx.com` and OKX simulated trading on EEA** (only `swap_get_leverage` 404s there) | Tool, not a venue | n/a | OKX | Official (`docs/site-compatibility.md`) |

Rules context: ESMA (2026-02-24) says crypto "perpetual" derivatives are likely CFDs under national product-intervention measures (leverage limits, negative-balance protection). MiCA does not cover derivatives. Tax in PL: PIT-38, 19 % (secondary source; confirm individually).

**Verdict:** paper trading needs no account and is legal today. The only lawful real-money path that keeps the OKX stack is OKX Europe X-Perps, after the owner passes KYC and the appropriateness test in the app. Hyperliquid is a conscious grey-zone choice. VPN or location masking is out.

## 4. Repo audit and paper design

### 4.1 What survives (read-only audit, verified: `npm test` 142/142 pass, offline)

| File | LOC | Verdict | Why |
|---|---|---|---|
| `logger.js` | 117 | Keep | Venue-neutral |
| `state.js` | 298 | Keep, edit schema | Atomic write (`saveState` temp+rename), corrupted-file backup, daily rotation survive; position becomes `{instId, side, qty, entryPx, leverage, margin, liqPx, fundingPaid}` plus an `account {balance}` block |
| `risk.js` | 277 | Keep, rework sizing | Normal/Slow/Halted machine, daily-loss halt are venue-neutral; `computePositionSize` becomes risk-per-trade / stop distance, capped by max leverage |
| `notify.js` | 622 | Keep, prune builders | Transport, secret scrubbing, throttle, tick-health are tested (80 tests); drop swap/Solscan/untracked builders, add `open`/`close`/`liquidated` |
| `signals.js` | 229 | Keep core, delete catalyst | `sma`, `completedCandles`, `signalTrend`, `signalMomentum` survive; `signalCatalyst`, `signalRelativeStrength`, `setupId` go; add `atr` (no EMA/ATR exists today) |
| `strategy.js` | 532 | Heavy edit (~60 %) | Keep per-position mutex, exit ordering, funnel counters, `computeRealizedPnl` (add side and fees); delete swap calls, `CliConfirmingError` paths, `catalyst_death`, `exit_pending` (a simulated fill cannot fail) |
| `bot.js` | 321 | Edit | Keep the non-overlapping runners and shutdown handlers; delete `onchainos wallet status` preflight, holder loop, wallet balances |
| `execution.js` | 434 | **Delete** | Every line is the onchainos swap/wallet wrapper. It holds the only live-order call (`swap execute`, `execution.js:361`) |
| `tokens.json` | 72 | **Delete** | 8 SPL tokens; replaced by a ~10-line `markets.json` |
| `docs/superpowers/*` | 2,943 | **Delete** | Finished Telegram plan/spec, history is in git |
| `test/execution.test.js` | 7 tests | Delete | Dies with `execution.js`; ~25-30 of 142 tests die in total |
| `deploy/*` | | Keep, trim | Drop the two onchainos binary/auth mounts and `OKX_BOT_HOLDERS_FILE`; the VPS keeps its local compose patch (it exists: `git status` there shows `M deploy/docker-compose.yml`) |
| `README.md` (683), `SKILL.md` (147) | | Rewrite later | Competition write-up and spot strategy; README to ~80 lines after Stage B starts |

### 4.2 Paper engine (no live code anywhere)

- `DRY_RUN` disappears. The paper bot contains **no order-sending code**, so no env flag can make it trade. Live trading would be a separate PR after a separate owner decision.
- Fills on the next bar's open plus slippage; taker fee both sides; funding accrued every 8 h of holding; isolated-margin liquidation price from leverage and the maintenance-margin rate; if stop and liquidation fall in the same candle, take the worse.
- Each closed trade records its maximum adverse excursion, so results at 1x, 3x and 10x (and a "top-1-like" 40x counterfactual) are computed from the same trades. One simulation, several leverage columns, no extra engine.

## 5. Kill criteria and budgets (written before any real order is considered)

**Stage A, replay (out-of-sample 2025-01-01..2026-10-31):**

| ID | Kill if | Why |
|---|---|---|
| K-A1 | Net OOS return at 1x ≤ T-bill (~4.1 %/year pro-rated) | A rate is not an edge |
| K-A2 | OOS net with the 5 best trades removed ≤ 0 | Outlier dependence (same rule as onchain-scout) |
| K-A3 | OOS max drawdown at 3x > 30 % | Leverage claim fails; owner can only see a 1x result |
| K-A4 | Fewer than 60 OOS trades on the primary 1D rule | No power; inconclusive counts as kill |
| — | Reported, not a kill: buy-and-hold BTC 1x over the same window | So the owner sees what doing nothing earned |

Primary rule = 1D; 4H is a secondary pre-registered variant and cannot rescue a failed primary.

**Stage B, forward paper (only if A passes; at least 90 days on the VPS, started only with the owner's OK to run the container):**

| ID | Kill if |
|---|---|
| K-B1 | Paper fills differ from a replay of the same bars by > 5 bp (simulator bug: fix and restart the clock) |
| K-B2 | Forward mean net per trade below the replay OOS mean minus 2 standard errors |
| K-B3 | Paper drawdown > 20 % at the configured leverage |
| K-B4 | Any paper liquidation at ≤ 3x |

At 1D, 90 days gives roughly 10-20 trades: Stage B checks that the model and plumbing match reality; it cannot prove an edge on its own (J).

**Stage C, real money: not part of this plan.** Needs a separate, dated owner decision. Proposal for that decision only: OKX Europe X-Perps after in-app eligibility check; isolated margin ≤ $100; leverage ≤ 3x; daily loss halt 5 %; total loss stop -$30 then stop and review; live code as its own PR with high-tier review (code-reviewer + security-reviewer + a second model).

## 6. Refactor plan (order, files, signatures)

1. **Stage A, replay only (touches no bot code):**
   - `docs/prereg/H-F1.json`: frozen rule, parameters, costs, windows, kill thresholds, committed before the OOS run.
   - `market.js` (new, ~90 lines): `getCandles(instId, bar, {after, before, limit})`, `getFundingHistory(instId, {after, before})`; base URL `https://www.okx.com` for history, `https://eea.okx.com` for X-Perps; built-in `fetch`, no new dependency.
   - `paper.js` (new, ~150 lines, pure functions): `fillPrice(side, px, slipBps)`, `fee(notional, rate)`, `liqPrice({side, entryPx, leverage, mmr})`, `fundingCost({side, notional, rate})`, `stepPosition(pos, candle, fundingRate) -> {pos, events}`.
   - `scripts/replay.js` (new): reads the pre-registration, pulls candles once into `data/replay/` (add `data/` to `.gitignore`; today only `deploy/data/` is ignored), writes trades JSONL + a summary with every kill metric.
   - `test/paper.test.js`: liquidation price long/short, funding sign, fee and slippage arithmetic, one hand-checked 5-candle replay.
2. **Gate A readout** to the owner. Fail → stop; the refactor below is never written.
3. **Stage B pivot (one PR):** delete `execution.js`, `tokens.json`, `test/execution.test.js`, `docs/superpowers/`, catalyst/holder code; add `markets.json`; wire `strategy.js` to `paper.js` (long/short); edit `state.js`, `risk.js`, `notify.js`, `bot.js`, `scripts/status.js`, `deploy/*`; update `dockerfile.test.js`. Estimated ~1,300-1,500 lines deleted (2,943 more with the docs), ~800 added.
4. **Deploy** as a paper bot on the VPS after the owner's OK to start a container; Telegram reports equity, open paper positions and kill-metric status daily.
5. **Gate B readout** after ≥ 90 days.

Alternatives rejected: OKX EEA simulated trading as the paper engine (needs an owner account and demo key first, and demo books do not show real slippage; kept as an optional cross-check in Stage B); Hyperliquid as the paper venue (the real-money path would be unlicensed); a new repo (loses tested modules and deploy history for no gain).

## 7. Evidence log (all read-only, 2026-11-07)

- `onchainos competition list --status 2`, `competition detail/rank --activity-id 113` (CLI 4.2.1).
- okx.ai pages above; leaderboard and 6-hour chart from `priapi/v1/wallet/activity/hackathon/{rank,chart,activity}` as loaded by the page (direct calls need a signature).
- OKX public REST: `www.okx.com/api/v5/market/history-candles` (ETH/BTC/SOL-USDT-SWAP, 6H and 1Dutc, August 2026); `eea.okx.com/api/v5/public/instruments?instType=FUTURES`; `eea.okx.com/api/v5/public/funding-rate?instId=BTC-USD_UM_XPERP-310404`.
- `gh api repos/okx/agent-trade-kit/contents/docs/site-compatibility.md`.
- VPS (read-only `ssh`): `okx-bot | Exited (0) 4 weeks ago | okx-bot:latest`, repo at `313268d`.
- Prior research: onchain-scout `reports/Przewaga w memecoinach i perpach.md` and `research_notes/.../a4_okx_perps.md`, `v2_carry_cost_check.md`.
- Venue sources: [OKX X-Perps EEA eligibility](https://www.okx.com/en-eu/help/okx-x-perps-eea-regional-availability-eligibility) (updated 2026-09-04); [ESMA statement](https://www.esma.europa.eu/node/228326) (2026-02-24); [Kraken EEA derivatives eligibility](https://support.kraken.com/articles/derivatives-eligibility-requirements-eea); [money.pl on Binance PL](https://www.money.pl/gospodarka/to-juz-oficjalne-binance-ogranicza-uslugi-w-polsce-7300403340150784a.html) (2026-06-24); [OnchainOS Hyperliquid plugin](https://web3.okx.com/onchainos/plugins/detail/hyperliquid-plugin); [Agent Trade Kit](https://github.com/okx/agent-trade-kit).
- Population and drawdown scripts: computed in this session from the leaderboard and chart rows quoted above; principal and drawdown were each checked two ways (both chart columns; hand recomputation of the peak-to-trough ratio).
