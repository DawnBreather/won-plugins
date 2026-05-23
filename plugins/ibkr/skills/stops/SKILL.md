---
name: ibkr-stops
description: Audit + reconcile GTC stop orders against actual positions. Detects orphan stops (cancelled position but stop alive), qty drift (stop qty != position qty), missing stops (position with no protection). Auto-fixes via cancel+replace. Use after restart, after partial-fill incidents, or as periodic risk audit. Triggers - "audit stops", "reconcile stop orders", "/ibkr:stops".
---

# IBKR Stop Order Reconciliation

## Audit script

```python
from ib_insync import IB, StopOrder, Stock
ib = IB()
ib.connect('100.x.x.x', 4004, clientId=86, timeout=15)
import time; time.sleep(3)

# Force pull all open orders (some may be from other clientIds)
ib.reqAllOpenOrders(); time.sleep(3)

positions = {p.contract.symbol: abs(p.position) for p in ib.positions() if abs(p.position) > 0}
stops_by_sym = {}
for t in ib.openTrades():
    if t.orderStatus.status in ('Cancelled', 'Filled'):
        continue
    if t.order.orderType != 'STP' or t.order.action != 'SELL':
        continue
    sym = t.contract.symbol
    stops_by_sym.setdefault(sym, []).append(t)

# Check each position has exactly 1 stop with matching qty
print('=== STOP RECONCILIATION ===')
for sym, qty in positions.items():
    stops = stops_by_sym.get(sym, [])
    total_stop_qty = sum(t.order.totalQuantity for t in stops)
    if not stops:
        print(f"  ⚠️  {sym}: position={qty}, NO STOP (UNPROTECTED)")
    elif len(stops) > 1:
        print(f"  ⚠️  {sym}: position={qty}, {len(stops)} stops totalling {total_stop_qty} — duplicates")
        for t in stops:
            print(f"      oid={t.order.orderId} qty={t.order.totalQuantity} aux={t.order.auxPrice}")
    elif abs(total_stop_qty - qty) > 0.5:
        print(f"  ⚠️  {sym}: position={qty} but stop qty={total_stop_qty} (drift)")
    else:
        print(f"  ✓  {sym}: position={qty} stop@{stops[0].order.auxPrice} qty matches")

# Check for stops without positions (orphans)
for sym, stops in stops_by_sym.items():
    if sym not in positions:
        print(f"  ⚠️  {sym}: ORPHAN stops (no position)")
        for t in stops:
            print(f"      oid={t.order.orderId} qty={t.order.totalQuantity} aux={t.order.auxPrice}")

ib.disconnect()
```

## Auto-fix: cancel orphans + redo mismatched stops

```python
from ib_insync import IB, StopOrder, Stock
ib = IB()
ib.connect('100.x.x.x', 4004, clientId=85, timeout=15)
import time; time.sleep(3)
ib.reqAllOpenOrders(); time.sleep(3)

positions = {p.contract.symbol: abs(p.position) for p in ib.positions() if abs(p.position) > 0}

# 1. Cancel all stop SELL orders (we'll re-place w/ correct qty)
existing_stops = {}  # sym -> [aux_prices]
for t in ib.openTrades():
    if t.orderStatus.status in ('Cancelled', 'Filled'):
        continue
    if t.order.orderType != 'STP' or t.order.action != 'SELL':
        continue
    sym = t.contract.symbol
    existing_stops.setdefault(sym, []).append(t.order.auxPrice)
    print(f"cancelling {sym} STP qty={t.order.totalQuantity} aux={t.order.auxPrice}")
    ib.cancelOrder(t.order)
    time.sleep(0.5)

time.sleep(5)

# 2. Place fresh stop per position at the BEST (highest) prior stop level
#    or default to entry * (1 - 0.07) if no prior stop
for sym, qty in positions.items():
    contract = Stock(sym, 'SMART', 'USD')
    ib.qualifyContracts(contract)
    if existing_stops.get(sym):
        stop_px = max(existing_stops[sym])  # highest = most protection
    else:
        # Need entry price — read from position avgCost
        pos = next(p for p in ib.positions() if p.contract.symbol == sym)
        stop_px = round(pos.avgCost * 0.93, 2)
    order = StopOrder('SELL', qty, stop_px)
    order.tif = 'GTC'
    trade = ib.placeOrder(contract, order)
    print(f"placed {sym} STP qty={qty} stop=${stop_px}")
    time.sleep(0.5)

ib.disconnect()
```

**Caveat**: must be run with strategy STOPPED or use clientId=1 (strategy's). Otherwise `Error 10147: cannot cancel order owned by other client`.

```bash
docker stop ib-strategy
# run reconcile script with clientId=1
docker start ib-strategy
```

## Why orphan stops happen

| Cause | Detection |
|---|---|
| Position exit without cancelling stop (engine bug) | Orphan w/ symbol not in positions |
| Container restart loses tracker.stop_order_id but stop persists on Gateway | Orphan after rehydrate, plus matching position |
| Partial-fill original stop has wrong qty, monitor placed second | 2 stops same symbol, different qty |
| Manual order placed during debug session | Orphan with non-strategy clientId |

## Periodic audit (cron-like)

Add to healthcheck loop or run weekly. Detect EARLY before stop fires with wrong qty.

## Fail-safe: emergency flatten

If reconcile finds positions WITHOUT stops, choose one:
1. Manually place tight stop at avgCost * 0.95
2. Run `/ibkr:rollback` to flatten everything

NEVER leave a position open without a stop.

## Verification after reconcile

Re-run audit. Expect ALL `✓` rows, no warnings.
