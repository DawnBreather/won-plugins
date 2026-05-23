---
name: ibkr-debug
description: Systematic debug playbook for IBKR stack anomalies — order rejections, qty mismatches, premature exits, disconnect cascades, login failures, position drift. Use when something looks wrong. Triggers - "debug IBKR", "investigate trade anomaly", "/ibkr:debug".
---

# IBKR Stack Debug Playbook

**Iron Law**: Phase 1 (root cause) before any fix. Symptoms ≠ cause.

## Phase 1 — Reproduce + gather evidence

### Multi-component chain

```
[strategy run.py] → [broker.py / ib_insync] → [Gateway socat 4004→4002]
   → [Gateway JVM] → [IBKR servers]
```

For ANY anomaly, instrument each layer:

```bash
echo "=== L1: Strategy log (last 50, filtered) ==="
docker logs ib-strategy --tail 200 2>&1 | grep -E "ERROR|EXIT|tier=A|POSITION|REHYDRATED|disconnect|Submitted|Filled|Cancelled" | tail -50

echo "=== L2: Gateway socat alive? ==="
docker exec ib-gateway pgrep -f "socat TCP-LISTEN:4004"
docker exec ib-gateway cat /proc/net/tcp | python3 -c "
import sys
for line in sys.stdin:
    p=line.split()
    if len(p)<4 or p[3]!='0A': continue
    port=int(p[1].split(':')[1],16); ip=':'.join(reversed(['.'.join(str(b) for b in bytes.fromhex(p[1].split(':')[0]))]))
    print(f'  LISTEN port {port}')
"

echo "=== L3: Gateway connection state (VNC screenshot) ==="
docker exec ib-2fa-agent bash -c "echo 'from vncdotool import api; c=api.connect(\"127.0.0.1::5900\", password=\"$VNC_PW\"); c.captureScreen(\"/tmp/gw.png\"); c.disconnect()' | python"
docker cp ib-2fa-agent:/tmp/gw.png /tmp/gw.png
# Read /tmp/gw.png — expect 3 green rows or red banner with error

echo "=== L4: Broker truth ==="
python <<'PY'
from ib_insync import IB
ib=IB(); ib.connect('100.x.x.x', 4004, clientId=99, timeout=15)
import time; time.sleep(2); ib.reqAllOpenOrders(); time.sleep(2)
print('positions:', [(p.contract.symbol, p.position, p.avgCost) for p in ib.positions()])
print('open orders:', [(t.contract.symbol, t.order.orderType, t.order.totalQuantity, t.order.auxPrice or t.order.lmtPrice, t.orderStatus.status) for t in ib.openTrades() if t.orderStatus.status not in ('Filled','Cancelled')])
ib.disconnect()
PY
```

## Known bug catalog (if any of these match, jump to fix)

### Symptom: realized PnL exceeds hard-stop dollar limit

→ **partial-fill flip-to-short** (qty mismatch). Strategy submitted exit qty=initial-qty but only N<initial filled. Sell of initial qty flips position short.

Fix: see `/ibkr:stops` reconcile + verify `engine.py` exit path uses `broker.positions()` qty not `pos.shares`.

### Symptom: position exited within minutes of entry, reason=failed_breakout

→ **intraday quote evaluated as EOD close**. positions.py `_check_exit_rules` should EOD-gate `failed_breakout`, `climax_volume`, `pop_and_drop` to last 10 min of session + days_held >= 1.

Verify positions.py has `_is_eod_window()` + `if not eod or pos.days_held < 1: return None` before those rules.

### Symptom: pre-open ran > 30min late after midnight

→ **boolean flag reset overnight** invalidating yesterday's nightly. Fix: timestamp-based `nightly_recently_done()` with 18h validity window.

### Symptom: hundreds of `Error 300, reqId NNN: Can't find EId`

→ **explicit cancelMktData after snapshot=True**. Remove `cancelMktData` call; `reqMktData(snapshot=True)` auto-cancels.

### Symptom: `Unrecognized Username or Password` after `docker compose restart ib-gateway`

→ **paper session cannot re-login** within 24h window. Restart the FULL container (not Gateway internal restart). If repeating: wait 24h or run `docker compose down -v && docker compose up -d` (wipes Gateway state).

### Symptom: `BROKER has X but tracker doesn't`

→ **container restarted, in-memory state lost**. Verify engine.startup calls `tracker.rehydrate_from_broker(positions, open_trades)`.

### Symptom: TWO stop orders for same symbol, one with stale qty

→ **partial-fill stop drift**. Fix: monitor cycle should compare stop.totalQuantity vs broker.position and update via `placeOrder` (modify-in-place).

### Symptom: Tailscale `no matching peer` from host

→ **container TS session expired** but compose health check passed. Run `docker compose restart ts` then verify `tailscale ping ib-gw`.

### Symptom: IBKR market data shows "Requested market data is not subscribed. Displaying delayed market data"

→ **paper account default** — delayed feed is OK for backtest validation. Real-time costs $10-20/mo via IBKR market data sub.

## Phase 2 — Pattern check

If novel anomaly, find a known-working comparable case:
- Compare strategy.log fragment from anomaly to fragment from healthy day
- Diff env vars: `docker compose config | diff - <known-good-snapshot>`
- Check git log for recent changes: `cd ~/lab/streams/experiments/trading/ibkr-gateway && git log --oneline -20`

## Phase 3 — Hypothesis + minimal test

State explicitly: "I think X is the root cause because Y (evidence)."

Before fixing: write minimal repro test. For trading bug, that means:
- Construct exact market_data dict + Position state
- Call `tracker._check_exit_rules(pos, ...)` directly
- Confirm it returns the bad reason
- Apply fix, confirm now returns None

## Phase 4 — Apply ONE fix, verify

```bash
# After code change
docker compose up -d --build strategy
sleep 30
docker logs ib-strategy --tail 30
# Confirm fix observable in next monitor cycle
```

If fix doesn't work: STOP. Don't add more fixes. Re-enter Phase 1 with new evidence.
If 3+ fixes failed: question the architecture, not the symptom.

## Quick health snapshot

```bash
docker logs ib-healthcheck --tail 50 2>&1 | grep -A20 "HEALTHCHECK $(date +'%a %b %_d')" | tail -30
```

## When to halt strategy entirely

If you see ANY of these, run `/ibkr:rollback` immediately:
- Realized PnL drops > 5% in single session unexplained
- Position qty doesn't match any submitted order qty
- Strategy logs show ENTRY without prior NIGHTLY scan
- Gateway shows red banner persistent after restart
