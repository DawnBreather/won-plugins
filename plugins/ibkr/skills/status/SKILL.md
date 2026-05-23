---
name: ibkr-status
description: Snapshot of IBKR trading stack — container statuses, API reachability, NAV, positions, open orders, recent strategy phase events. Use as quick health check. Triggers - "what's the IBKR status", "show paper account", "/ibkr:status".
---

# IBKR Status Snapshot

## One-shot status

```bash
echo "=== ET time ==="
python -c "from datetime import datetime; from zoneinfo import ZoneInfo; print(datetime.now(ZoneInfo('America/New_York')).strftime('%H:%M %A %Y-%m-%d'))"

echo "=== Containers ==="
docker ps --format "table {{.Names}}\t{{.Status}}" | grep ib-

echo "=== Account + Positions ==="
python <<'PY'
from ib_insync import IB
ib = IB()
ib.connect('100.x.x.x', 4004, clientId=99, timeout=10)  # update IP
import time; time.sleep(2)
vals = {v.tag: v.value for v in ib.accountSummary()}
print(f"NAV:           ${float(vals.get('NetLiquidation', 0)):,.2f}")
print(f"Cash:          ${float(vals.get('TotalCashValue', 0)):,.2f}")
print(f"GrossPosVal:   ${float(vals.get('GrossPositionValue', 0)):,.2f}")
print(f"RealizedPnL:   ${float(vals.get('RealizedPnL', 0)):,.2f}")
print(f"UnrealizedPnL: ${float(vals.get('UnrealizedPnL', 0)):,.2f}")
print()
print(f"Positions ({len(ib.positions())}):")
for p in ib.positions():
    print(f"  {p.contract.symbol}: {p.position:.0f} sh @ avg ${p.avgCost:.4f}")
print()
ib.reqAllOpenOrders(); time.sleep(3)
trades = [t for t in ib.openTrades() if t.orderStatus.status not in ('Filled', 'Cancelled')]
print(f"Open orders ({len(trades)}):")
for t in trades:
    print(f"  {t.contract.symbol} {t.order.orderType} {t.order.action} qty={t.order.totalQuantity} aux={t.order.auxPrice} lmt={t.order.lmtPrice} status={t.orderStatus.status}")
ib.disconnect()
PY

echo "=== Strategy phase ==="
docker logs ib-strategy --tail 30 2>&1 | grep -E "NIGHTLY|PRE-OPEN|ORB SCAN|FLATTEN|EOD STATUS|tier=A|REHYDRATED" | tail -10

echo "=== Healthcheck ==="
docker logs ib-healthcheck --tail 50 2>&1 | tail -25
```

## What to look for

| Signal | Healthy | Warning |
|---|---|---|
| All 6 containers `Up` | ✓ | any `Exited` or restarting |
| Gateway uptime | < 24h | > 24h (paper session expires) |
| API connection | `connected to IBKR` recent | `Socket disconnect` errors |
| NAV vs $1M | drift ±2% | sudden 5%+ drop |
| Open orders | qty matches positions | qty > position (orphan stop) |
| Recent disconnect events | 0 in last hour | > 5 |

## Find current tailnet IP

```
tailscale status | grep -E "ib-gw\s+.*active"
```

If multiple `ib-gw-N` entries, only the `active` one is current. Stale ones were orphaned by `down -v` cycles.

## ET time-aware expectations

| ET window | Expected state |
|---|---|
| 00:00-09:24 | Strategy idle in `wait_until 09:25` log spam |
| 09:25-09:30 | `PRE-OPEN: submitting daily entries` once |
| 09:30-10:00 | Limit orders Submitted, no fills yet (waiting for breakouts) |
| 10:00-10:05 | `ORB SCAN: scanning opening range breakouts` once |
| 10:00-15:55 | Monitor cycle every 30/120/300s, fills + pyramids + trail updates |
| 15:55-16:00 | `FLATTEN: closing all intraday positions` |
| 16:00-16:30 | Idle |
| 16:30-17:05 | `NIGHTLY JOB`, ~33min EOD pull, then candidates printed |

## Quick health from healthcheck logs only

```
docker logs ib-healthcheck --since 24h 2>&1 | grep -E "HEALTHCHECK|REACHABLE|UNREACHABLE" | tail -8
```

## NAV drift inspection

```
docker logs ib-strategy 2>&1 | grep "account NAV" | tail -10
```

Should be roughly monotonic with small T-bill accrual + trade PnL.
