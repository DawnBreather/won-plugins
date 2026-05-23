---
name: ibkr-monitor
description: Live tail of strategy + Gateway logs to watch order submission, fills, exits, pyramid adds, stop updates in real time. Filter noise. Use during market hours to observe bot behavior. Triggers - "watch IBKR", "monitor live trading", "/ibkr:monitor".
---

# IBKR Live Monitor

## Live tail (filtered, useful events only)

```bash
docker logs -f ib-strategy 2>&1 | grep --line-buffered -E \
  "NIGHTLY JOB|PRE-OPEN|ORB SCAN|FLATTEN|EOD STATUS|new ET day|\
   tier=A|tier=B|POSITION OPEN|REHYDRATED|EXIT |PYRAMID |STOP UPDATED|\
   FLAT |ERROR|monitor_cycle failed|connected to IBKR|Socket disconnect|\
   SELL MKT|BUY LIMIT|SHORT LIMIT|CANCEL|emergency nightly"
```

## Common log patterns

| Pattern | Meaning |
|---|---|
| `tier=A pivot=X entry=Y stop=Z shares=N rs=R` | Daily candidate found in scan |
| `BUY LIMIT XYZ qty=N px=P` | Pre-open order submitted |
| `STOP XYZ qty=N stop=P` | GTC stop submitted |
| `POSITION OPEN: XYZ long shares=N entry=P stop=S` | Tracker recorded entry |
| `PYRAMID XYZ: +N shares @ P, total=T, avg_entry=A, add #1/2/3` | Position scaled |
| `STOP UPDATED XYZ: stop=P qty=N` | Trail stop moved up + qty matches broker |
| `EXIT XYZ: <reason> (qty=N)` | Position closed via market sell |
| `FLAT XYZ qty=N` | EOD intraday flatten |
| `REHYDRATED: XYZ qty=N entry=E stop=S (broker truth)` | Tracker restored from broker on restart |
| `Socket disconnect` then `attempt #1/2/3` | Reconnect decorator firing |
| `failed_breakout` | EXIT reason — usually EOD-only after fix |
| `hard_stop` | Day low hit GTC stop — IBKR triggered, strategy noticed |
| `time_stop` | 21d held + < +3% gain |
| `pop_and_drop` | EOD-gated, gain > 7% but stalling |

## Watch for danger signals

```bash
docker logs ib-strategy --since 1h 2>&1 | grep -iE \
  "ERROR|exception|traceback|Socket disconnect|Not connected|\
   broker.*has.*tracker doesn't|tracker has.*broker doesn't|\
   exhausted.*attempts|cannot connect" | tail -30
```

If ANY of these:
- `Socket disconnect` repeating > 3 times → Gateway needs restart (`docker compose restart ib-gateway`)
- `BROKER has X but tracker doesn't` → run `/ibkr:stops` for reconciliation
- `monitor_cycle failed` → temporary; retry next cycle, but if persistent restart strategy
- `Unrecognized Username or Password` → manual re-login via VNC

## Watch order book intraday

```bash
watch -n 15 'python -c "
from ib_insync import IB
ib = IB(); ib.connect(\"100.x.x.x\", 4004, clientId=98, timeout=10)
import time; time.sleep(2); ib.reqAllOpenOrders(); time.sleep(2)
for t in ib.openTrades():
  s = t.orderStatus.status
  if s not in (\"Filled\", \"Cancelled\"):
    print(f\"  {t.contract.symbol} {t.order.orderType} {t.order.action} qty={t.order.totalQuantity} aux={t.order.auxPrice} lmt={t.order.lmtPrice} status={s}\")
ib.disconnect()
"'
```

## Healthcheck periodic summary

```bash
docker logs -f ib-healthcheck 2>&1 | grep --line-buffered -E "HEALTHCHECK|REACHABLE|connections|disconnect events|running"
```

Every 6h dumps full snapshot. Useful for daily review without staring at strategy stream.

## Capture screenshot of Gateway UI

```bash
docker exec ib-2fa-agent bash -c "cat > /tmp/snap.py << 'PYEOF'
from vncdotool import api
c = api.connect('127.0.0.1::5900', password='<vnc-pw>', timeout=10)
c.captureScreen('/tmp/gw.png')
c.disconnect()
PYEOF
python /tmp/snap.py" && docker cp ib-2fa-agent:/tmp/gw.png /tmp/gw.png
```

Check `/tmp/gw.png` — connection status rows should be all GREEN, no error/warning dialogs blocking.

## Stop monitoring

`Ctrl+C` on `docker logs -f`. Containers keep running.
