---
name: ibkr-supervisor
description: View ib-supervisor state, dispatch history, and force-classify Gateway. Truth source for Gateway readiness — replaces TCP-only healthcheck. Triggers - "supervisor state", "is the gateway healthy", "supervisor stuck", "/ibkr:supervisor".
---

# IBKR Supervisor State

`ib-supervisor` is the 7th container that classifies Gateway every 15s and dispatches recovery. This skill reads its state.

## Quick state

```bash
docker exec ib-healthcheck cat /supervisor-state/supervisor.json | python -m json.tool
```

Or via volume host inspect:

```bash
docker run --rm -v ibkr-gateway_supervisor-state:/s alpine cat /s/supervisor.json
```

Expected when healthy:
```json
{
  "state": "LOGGED_IN_OK",
  "farms": {"api_server": "green", "market_data": "green", "historical": "green"},
  "action": null,
  "last_error": null,
  "streak_state": "LOGGED_IN_OK",
  "streak_count": 42
}
```

## State table

| State | Meaning | Auto-action |
|---|---|---|
| `LOGGED_IN_OK` | 3 farms green/yellow | none |
| `FARMS_BROKEN` | api green, market_data red | IBC `RECONNECTDATA` |
| `DEAD_SESSION_MODAL` | "Connection to server failed" | dismiss + `RECONNECTACCOUNT` |
| `EXISTING_SESSION_MODAL` | "Existing Session Detected" | dismiss (Reconnect focused) |
| `AUTORESTART_MODAL` | "Auto-restart will be enabled" | dismiss (No focused) |
| `LOGIN_SCREEN` | password empty | type `$TWS_PASSWORD` + Enter |
| `BAD_CREDS` | red banner | **halt** until `/state/ack-creds` touched |
| `RELOGIN_REQUIRED` | "Re-login is required" modal | escalate (no auto-restart) |
| `STUCK` | same non-OK state ≥6 cycles in 10min | VNC `esc` (24h min, blackout-window-guarded) |
| `UNKNOWN_MODAL` | OCR text not in allow-list | log only, never click Yes |

## Recent activity

```bash
docker logs ib-supervisor --tail 30 2>&1 | grep -E "supervisor]" | tail -15
```

Look for `state=X(raw=Y, streak=N)` lines. Useful when:
- raw state cycling: classifier flapping; pixel coords may need tuning
- streak rising past 3: bounded-retry building toward STUCK
- action=STUCK_GAMBIT_ESCAPE: gambit fired (rare, expect Gateway restart)

## Manual dry-run mode

Test classifier safely without dispatching actions:

```bash
docker compose -f ~/lab/streams/experiments/trading/ibkr-gateway/docker-compose.yml \
  run --rm -e DISPATCH_DRY_RUN=true supervisor python /app/supervisor.py
```

Or persistent dry-run:
```bash
SUPERVISOR_DRY_RUN=true docker compose up -d supervisor
```

## Force-reclassify single screenshot

Useful for debugging classifier regressions:

```bash
docker exec ib-supervisor python -c "
from PIL import Image
import classify
img = Image.open('/tmp/gw_supervisor.png')
r = classify.classify(img)
print(r)
"
```

## Acknowledge BAD_CREDS halt

If supervisor halted because of bad-creds, after fixing `.env` and `docker compose up -d`:

```bash
docker exec ib-supervisor touch /state/ack-creds
```

Or wipe the volume to reset history:

```bash
docker volume rm ibkr-gateway_supervisor-state
docker compose up -d supervisor
```

## VNC repair (manual)

If supervisor reports `CAPTURE_FAILED` repeatedly (auto-repair couldn't fix):

```bash
docker exec ib-gateway sh -c '
  pkill x11vnc 2>/dev/null
  DISPLAY=:1 x11vnc -display :1 -forever -shared -bg -noipv6 \
    -passwd "$VNC_SERVER_PASSWORD" >/tmp/x11vnc.log 2>&1
'
```

## Common questions

**Q: supervisor shows STUCK but Gateway looks fine on VNC**
→ Pixel-sample coords may have shifted (Gateway version bump). Run dry-run, inspect the snapshot, update `classify.py` ROW_*_Y constants.

**Q: state=UNKNOWN_MODAL with new modal text**
→ Add the text fragment + handler to `classify.py`/`supervisor.py`, rebuild + restart supervisor. Log lines show OCR text in `detail`.

**Q: gambit not firing on STUCK**
→ Check ET clock against blackout windows (09:25-09:35, 10:00-10:10, 15:55-16:05) and `/state/gambit_history.json` for last_gambit_at (24h min).

## Files / paths

- Source: `~/lab/streams/experiments/trading/ibkr-gateway/supervisor/{Dockerfile, classify.py, actions.py, supervisor.py}`
- State: `/state/supervisor.json` inside supervisor + `:ro` mount in healthcheck and strategy
- Gambit history: `/state/gambit_history.json`
- IBC CommandServer: 127.0.0.1:7462 inside ts netns (telnet `RECONNECTDATA` / `RECONNECTACCOUNT`)
