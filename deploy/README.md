# Deployment

Two supported paths: **systemd** (recommended for bare VPS) and
**docker-compose** (recommended if the host already runs other Docker
workloads).

Both require the `onchainos` CLI installed and logged in on the host —
the bot shells out to it for every market read and every swap. See the
"Prerequisites" section below before either path.

---

## Prerequisites

### 1. Node.js 20+

```bash
node --version   # must be v20.x or later
```

If your distro ships an older Node, use [nvm](https://github.com/nvm-sh/nvm)
or NodeSource. Avoid `apt install nodejs` on Debian/Ubuntu — it's
typically several majors behind.

### 2. OnchainOS CLI installed + logged in

Install per the [OKX dev-portal docs](https://web3.okx.com/onchainos/dev-portal),
then verify:

```bash
onchainos --version
onchainos wallet status
```

`wallet status` must return `"loggedIn": true`. If not:

```bash
# Email + OTP flow
onchainos wallet login your-email@example.com

# Or API Key flow (silent, no email):
# Set OKX_API_KEY / OKX_SECRET_KEY / OKX_PASSPHRASE in env first.
onchainos wallet login --force
```

The bot's preflight (`bot.js → preflightConfig`) will refuse to start
until `wallet status` reports `loggedIn: true`.

### 3. Wallet funded

Minimum recommended (per main `README.md`):
- ~$120 USDC on Solana
- ~0.02 SOL for gas

Bot will skip entries below `MIN_TRADE_SIZE_USD` (default $5).

---

## Option A — systemd

The unit file is at [`okx-bot.service`](okx-bot.service).

### 1. Lay out the install

```bash
sudo useradd --system --create-home --shell /usr/sbin/nologin okxbot

sudo mkdir -p /opt/okx-bot
sudo chown okxbot:okxbot /opt/okx-bot

sudo -u okxbot git clone https://github.com/YOUR_USER/okx-agentic-skill /opt/okx-bot
cd /opt/okx-bot
sudo -u okxbot npm ci --omit=dev
```

### 2. Configure `.env`

```bash
sudo -u okxbot cp .env.example .env
sudo -u okxbot ${EDITOR:-nano} .env
```

Required entries: `TELEGRAM_BOT_TOKEN`, `TELEGRAM_CHAT_ID` (optional but
strongly recommended), `MAX_PORTFOLIO_USD`, `MIN_TRADE_SIZE_USD`. Keep
`DRY_RUN=true` until you've watched it run for at least 24h.

### 3. Log the CLI in **as the okxbot user**

The bot inherits the user's CLI auth state from `~/.onchainos`.

```bash
sudo -iu okxbot
onchainos wallet login your-email@example.com  # or --force for API Key
onchainos wallet status   # must show loggedIn: true
exit
```

### 4. Install the unit

```bash
sudo cp /opt/okx-bot/deploy/okx-bot.service /etc/systemd/system/
# If you installed the CLI under ~/.local/bin (not /usr/local/bin), edit
# the Environment=PATH line in the unit file before reloading.
sudo systemctl daemon-reload
sudo systemctl enable --now okx-bot
```

### 5. Verify

```bash
sudo systemctl status okx-bot
sudo journalctl -u okx-bot -f         # follow logs (Ctrl-C to stop tailing)
sudo -u okxbot /opt/okx-bot/scripts/status.js  # live snapshot via the bundled status command
```

You should see (within ~5s of start):
```
[INFO] cli_auth_ok {"loginType":"ak","account":"Account 1"}
[INFO] tick {"tick":1,"state":"Normal","portfolio_usd":"...","cash_usd":"..."}
```

---

## Option B — docker-compose

Files: [`Dockerfile`](Dockerfile), [`docker-compose.yml`](docker-compose.yml).

### 1. Clone + configure

```bash
git clone https://github.com/YOUR_USER/okx-agentic-skill
cd okx-agentic-skill
cp .env.example .env
${EDITOR:-nano} .env
```

### 2. Confirm host paths

The compose file bind-mounts two paths from the host:

```bash
# 1. CLI binary — confirm and adjust docker-compose.yml if different
command -v onchainos
# Expect: /usr/local/bin/onchainos  (or your install path)

# 2. CLI auth state — must exist and contain a logged-in session
ls ~/.onchainos/
onchainos wallet status   # loggedIn must be true
```

If the CLI lives somewhere other than `/usr/local/bin/onchainos`, edit
the matching `volumes:` line in [`docker-compose.yml`](docker-compose.yml).

### 3. Build + start

```bash
mkdir -p deploy/data deploy/data/logs
touch deploy/data/state.json deploy/data/holders_history.json
# Files must pre-exist as files (not directories) for bind-mount to work
# as expected.
echo '{}' > deploy/data/holders_history.json

docker compose -f deploy/docker-compose.yml up -d --build
docker compose -f deploy/docker-compose.yml logs -f
```

### 4. Verify

```bash
docker compose -f deploy/docker-compose.yml ps
docker compose -f deploy/docker-compose.yml exec okx-bot node scripts/status.js
```

Look for `cli_auth_ok` and the first `tick` log line — same as systemd.

---

## Day-2 operations

### Updating the bot without losing state

Both deployment paths keep `state.json` outside the code tree, so a
fast-forward update is safe:

**systemd:**
```bash
sudo systemctl stop okx-bot
sudo -u okxbot git -C /opt/okx-bot pull --ff-only
sudo -u okxbot npm --prefix /opt/okx-bot ci --omit=dev
sudo systemctl start okx-bot
sudo journalctl -u okx-bot -f
```

**docker-compose:**
```bash
git pull --ff-only
docker compose -f deploy/docker-compose.yml up -d --build
docker compose -f deploy/docker-compose.yml logs -f
```

The bot's graceful-shutdown handler (`bot.js`) flushes `state.json`
atomically on `SIGTERM`, then leaves open positions intact for the next
start to resume monitoring.

### Log rotation

**systemd**: logs go to journald automatically. Cap journal size:

```bash
sudo journalctl --vacuum-time=14d
# Or persistently in /etc/systemd/journald.conf:
#   SystemMaxUse=500M
```

**docker**: the compose file already caps each log stream at 5 × 10 MB
via the `json-file` driver. Logs also live at `deploy/data/logs/bot-*.log`
(JSON one-line-per-event), with the bot rotating daily on its own.

To purge old daily log files:

```bash
find deploy/data/logs/ -name 'bot-*.log' -mtime +14 -delete
```

### Checking that the CLI is still authenticated

The bot's auth lives in the **host's** `~/.onchainos` directory (Option B
mounts it read-only into the container). If the CLI session expires:

```bash
# systemd: log in as the bot user
sudo -iu okxbot onchainos wallet status
sudo -iu okxbot onchainos wallet login your-email@example.com

# docker-compose: log in as your host user
onchainos wallet status
onchainos wallet login your-email@example.com
docker compose -f deploy/docker-compose.yml restart okx-bot
```

### Switching DRY_RUN → LIVE

1. **Read at least 24h of dry-run logs.** Confirm: entries match the
   strategy spec, no spurious errors, balance reads stable.
2. Edit `.env`: `DRY_RUN=false`.
3. **systemd:** `sudo systemctl restart okx-bot`
   **docker:** `docker compose -f deploy/docker-compose.yml restart okx-bot`
4. Watch logs for the next entry decision. The first live swap will
   exercise the CLI's `swap execute` path — if the OKX backend asks for
   a confirming gate (risk warning 81362), the bot will alert to
   Telegram and NOT auto-force; act on the alert manually.

### Emergency stop

**systemd:**
```bash
sudo systemctl stop okx-bot
```

**docker:**
```bash
docker compose -f deploy/docker-compose.yml stop
```

Both send SIGTERM. The bot's shutdown handler flushes state and exits
within 20s. Open positions remain in `state.json` — they are NOT
auto-closed. To liquidate, run swaps manually:

```bash
onchainos swap execute --chain solana --from <SPL_MINT> --to <USDC_MINT> ...
```

---

## Troubleshooting

| Symptom | Likely cause | Fix |
|---|---|---|
| Boot exits with `Could not run \`onchainos wallet status\`` | CLI not on PATH for the bot user | systemd: edit `Environment=PATH=` in the unit file. docker: check the `/usr/local/bin/onchainos` bind-mount path |
| Boot exits with `onchainos CLI is not logged in` | Session expired / fresh install | Run `onchainos wallet login` **as the bot user** (systemd: `sudo -iu okxbot`; docker: host user) |
| Boot exits with `Could not read wallet balance twice in a row` | Network down, or `wallet status` lies about login state (unusual) | Run `onchainos wallet balance --chain solana` manually; share the error |
| Endless `candles_fallback` warnings for one token | Token mint changed / removed from OKX | Remove the entry from `tokens.json`, restart |
| `state_load_failed_backup_saved` in logs | `state.json` corrupted (e.g. disk full mid-write) | A `state.json.corrupted-<ts>` was saved. Inspect; if recoverable, fix and rename back. Otherwise let the bot start fresh |
| Bot logs `telegram_timeout` | Telegram API slow / blocked | Non-fatal, decisions still execute. Check connectivity if persistent |
| `swap_confirming_required` alert | OKX backend wants human confirmation on a swap | Run the suggested CLI command manually OR ignore (position stays in `exit_pending` for 10min then retries) |

For anything else, the JSON log at `logs/bot-YYYY-MM-DD.log` is the
source of truth — every decision is recorded with full input data.
