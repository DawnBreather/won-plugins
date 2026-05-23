---
name: ibkr-setup
description: Bootstrap the full IBKR paper trading stack from scratch — Tailscale sidecar + Gateway + 2FA agent + strategy bot + watchdog + healthcheck. Use when starting fresh or onboarding new machine. Triggers - "set up IBKR", "bootstrap trading stack", "/ibkr:setup".
---

# IBKR Stack Setup

## Goal

Stand up a 6-container stack at `/home/won/lab/streams/experiments/trading/ibkr-gateway/` that paper-trades the Minervini blend strategy 24/7 against IBKR's Java Gateway, reachable only via Tailscale.

## Stack components

| Container | Role |
|---|---|
| ib-ts | Tailscale sidecar — provides netns, no host ports |
| ib-gateway | gnzsnz/ib-gateway:stable — Java Gateway running headless via Xvfb |
| ib-2fa-agent | Polls SMS relay, types code into Gateway VNC |
| ib-strategy | Python loop running blend strategy via ib_insync |
| ib-gateway-watchdog | Daily 3:00 AM ET `docker restart ib-gateway` to refresh paper session |
| ib-healthcheck | 6h status snapshot to docker logs |

## Prerequisites

- IBKR paper account (live username + password; paper inherits live creds)
- Tailscale account + auth key (ephemeral, reusable=no, tagged `tag:ib-gw`)
- Tailscale ACL: `{ "src": ["autogroup:member"], "dst": ["tag:ib-gw:4002,4004,5900"] }`
- IBKR account with SMS 2FA enabled (push 2FA blocks headless)
- Android Connector Relay reachable + token
- Docker + docker compose v2

## Steps

1. Create dirs:
   ```
   mkdir -p ~/lab/streams/experiments/trading/ibkr-gateway/{strategy,two-fa-agent}
   ```

2. Copy templates from existing repo or recreate from this skill (see ANNEX). Required files:
   ```
   ibkr-gateway/
   ├── docker-compose.yml
   ├── config.ini.tmpl       # IBC config — must have OverrideTwsApiPort=4002
   ├── jts.ini.tmpl          # LocalServerPort=4002, TrustedIPs= (empty)
   ├── healthcheck.sh
   ├── .env.example          # template
   ├── .env                  # populated, gitignored
   ├── two-fa-agent/{Dockerfile,requirements.txt,agent.py}
   └── strategy/{Dockerfile,requirements.txt,broker.py,config.py,
                 data_feed.py,daily_signals.py,intraday_signals.py,
                 positions.py,regime.py,engine.py,run.py,universe.txt}
   ```

3. Populate `.env`:
   ```
   TWS_USERID=<live-ibkr-username>
   TWS_PASSWORD=<live-ibkr-password>
   TRADING_MODE=paper
   VNC_SERVER_PASSWORD=<random-strong>
   TS_AUTHKEY=<tailscale-auth-key>
   TS_HOSTNAME=ib-gw
   SMS_RELAY_URL=<sms-relay-base-url>
   SMS_RELAY_TOKEN=<bearer-token>
   IBKR_SMS_SENDER_REGEX=ibkr|interactive|^\d{5,6}$
   IBKR_SMS_FRESHNESS_SEC=180
   ```

4. Critical Gateway settings (already in config.ini.tmpl + jts.ini.tmpl):
   - `AUTO_RESTART_TIME=""` (empty — paper re-login post-restart fails with "Unrecognized Username or Password")
   - `OverrideTwsApiPort=4002` — IBC propagates this to Gateway after login
   - `TrustedIPs=` empty — but Gateway overwrites to 127.0.0.1 anyway. socat (gnzsnz built-in) bridges 4004→127.0.0.1:4002 to expose API to tailnet.

5. Bring up:
   ```
   cd ~/lab/streams/experiments/trading/ibkr-gateway
   docker compose up -d --build
   ```

6. Verify (~75s for Gateway login):
   ```
   docker logs ib-gateway 2>&1 | grep -E "Configuration tasks completed|Login attempt"
   docker exec ib-gateway grep -E "LocalServerPort|TrustedIPs" /home/ibgateway/Jts/jts.ini
   docker exec ib-2fa-agent timeout 10 python -c "from vncdotool import api; c=api.connect('127.0.0.1::5900', password='<vnc-pw>'); c.captureScreen('/tmp/gw.png'); c.disconnect(); print('OK')"
   docker cp ib-2fa-agent:/tmp/gw.png /tmp/gw.png
   ```
   Read /tmp/gw.png — expect three green rows: API Server connected, Market Data Farm ON, Historical Data Farm ON. No blocking dialogs.

7. Smoke test connection:
   ```
   python -c "from ib_insync import IB; ib=IB(); ib.connect('100.x.x.x', 4004, clientId=99, timeout=15); print(ib.managedAccounts()); ib.disconnect()"
   ```
   Use tailnet IP from `tailscale status | grep ib-gw`. NOT 100.92.184.121 (stale).

## Common failures

- "Connection refused on 4004" → Gateway socat not running. `docker exec ib-gateway pgrep -f socat`. Restart: `docker compose restart ib-gateway`.
- "Unrecognized Username or Password" on Gateway dialog → wrong creds OR auto-restart cycle (paper invalidates re-login). Cancel auto-restart.
- TS device shows `offline` in `tailscale status` → key expired or container netns lost peer. `docker compose restart ts`.
- VNC password rejected → check `.env` VNC_SERVER_PASSWORD matches what's in compose.

## After setup

- Strategy starts in monitor cycle, idles until 4:30 PM ET nightly scan.
- `/ibkr:status` for snapshot, `/ibkr:monitor` to tail logs.
- First trades fire at 9:25 AM ET next market open (if candidates found).
