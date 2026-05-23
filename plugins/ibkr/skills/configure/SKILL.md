---
name: ibkr-configure
description: Edit IBKR stack configuration — secrets in .env (creds, TS key, SMS token, VNC pw), strategy params (RS threshold, stop loss, sizing, blend weights), Gateway/IBC config (port override, trusted IPs). Use when rotating creds, tuning strategy, or adjusting infra. Triggers - "rotate IBKR password", "update strategy config", "change RS threshold", "/ibkr:configure".
---

# IBKR Stack Configuration

## Files + what they control

| File | Controls | Restart needed |
|---|---|---|
| `~/lab/streams/experiments/trading/ibkr-gateway/.env` | TWS creds, TS auth key, SMS token, VNC pw, trading mode | `docker compose up -d` |
| `strategy/config.py` | RS threshold, stop loss, sizing, blend weights, ORB params, pyramid | strategy rebuild + restart |
| `strategy/universe.txt` | Universe of tickers (one per line) | strategy restart |
| `config.ini.tmpl` | IBC settings — OverrideTwsApiPort, ReadOnlyApi, ReloginAfterTwoFaTimeout | gateway restart |
| `jts.ini.tmpl` | Gateway settings — LocalServerPort, TrustedIPs, ApiOnly | gateway full teardown (`docker compose down -v` to wipe vol) |
| `docker-compose.yml` | Service env, volumes, ports, restart policy | per-service restart |
| `healthcheck.sh` | 6h check intervals, what to log | `docker compose restart healthcheck` |
| `two-fa-agent/agent.py` | SMS regex, freshness window, VNC inject logic | agent rebuild + restart |

## Common rotations

### Rotate TWS password
```
$EDITOR .env   # update TWS_PASSWORD
docker compose restart ib-gateway
sleep 60
docker logs ib-gateway --tail 20  # verify Login success
```

### Rotate Tailscale auth key
```
# Generate new ephemeral, reusable=no, tagged tag:ib-gw key at admin.tailscale.com
$EDITOR .env   # update TS_AUTHKEY
docker compose down  # full down (TS state volume needs purge)
docker volume rm ibkr-gateway_ts-state
docker compose up -d
```

### Adjust strategy params
Common knobs in `strategy/config.py`:
- `rs_threshold` (default 0.75) — base candidate filter
- `stop_loss_pct` (0.07) — initial stop distance
- `risk_per_trade_*` — % NAV risked per entry by regime
- `max_cap_*` — % NAV cap per position
- `pyramid_triggers` — gain thresholds for adds (default 0.04, 0.08, 0.12)
- `blend_*_bull/bear` — daily/intraday weight tuples
- `si_dtc_threshold` (10) + `si_boost` (1.15) — short-interest squeeze sizing

After edit:
```
docker compose up -d --build strategy
docker logs ib-strategy --tail 20
```

### Update universe
```
$EDITOR strategy/universe.txt
docker compose restart ib-strategy   # picks up at next nightly scan
```

### Switch paper → live (DANGEROUS)
```
$EDITOR .env   # TRADING_MODE=live
# CHANGE the Gateway port mapping: live uses 4001/4003 not 4002/4004
$EDITOR docker-compose.yml   # update OVERRIDE_TWS_API_PORT, socat target
$EDITOR jts.ini.tmpl         # LocalServerPort=4001
docker compose down -v        # wipe state — fresh login required
docker compose up -d
```
WARNING: live secrets must NEVER be in plain `.env`. Use Docker secrets or `op run`.

## Inspect current config without editing

```
docker exec ib-gateway grep -E "LocalServerPort|TrustedIPs|ApiOnly" /home/ibgateway/Jts/jts.ini
docker exec ib-gateway grep -E "^OverrideTwsApiPort|^ReadOnlyApi|^IbLoginId" /home/ibgateway/ibc/config.ini
docker compose config | grep -A2 "TWS_USERID\|TRADING_MODE"
```

## Validate after change

1. Containers running: `docker ps | grep ib-`
2. Strategy connected: `docker logs ib-strategy --tail 5 | grep "connected to IBKR"`
3. API smoke: `python -c "from ib_insync import IB; ib=IB(); ib.connect('100.x.x.x', 4004, clientId=99, timeout=10); print(ib.managedAccounts()); ib.disconnect()"`

## Secrets hygiene

- `.env` is in `.gitignore` — **never commit**
- VNC pw should be ≥20 random chars; weak VNC = backdoor into Gateway via tailnet
- TS auth keys: ephemeral + reusable=no + auto-expire 90 days
- SMS relay token: rotate if relay phone changes
- Live credentials: use 1Password CLI `op run -- docker compose up -d` instead of `.env`

## NEVER

- Set `READ_ONLY_API: "yes"` for live trading bot — orders silently dropped
- Set `AUTO_RESTART_TIME` non-empty for paper — IBKR invalidates session, re-login fails
- Bind Gateway ports to host (`ports: "4004:4004"`) — defeats Tailscale isolation
- Edit `jts.ini` inside running container — Gateway overwrites on every login
