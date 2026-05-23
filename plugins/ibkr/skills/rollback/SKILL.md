---
name: ibkr-rollback
description: Emergency halt — cancel all open orders, flatten all positions to cash, stop strategy container. Use only when something is materially wrong (positions diverging from intent, repeated execution errors, manual intervention needed). Triggers - "halt strategy", "flatten everything", "kill switch", "/ibkr:rollback".
---

# IBKR Emergency Rollback

> **Warning**: This skill cancels orders, sells positions to market, and stops the strategy container. Effects are immediate and irreversible (paper money is fake, but discipline matters — practice the rollback the same way you would on live).

## When to use

- Bug detected with capital risk (qty mismatch, orphan stops, flip-to-short)
- Strategy entered position not in nightly candidate list (stale state)
- Gateway / API behaving unpredictably and you need clean slate
- Paper-trading day-end cleanup before switching to live
- Before code changes that touch order submission logic

## When NOT to use

- Single losing trade (let stops do their job)
- Container restart needed (use `docker compose restart ib-strategy` instead)
- Routine maintenance (use `docker stop ib-strategy` to pause; positions stay protected by GTC stops on Gateway)

## Sequence

### 1. Stop strategy container (prevents new orders)

```bash
docker stop ib-strategy
```

Strategy is now paused. Existing positions + GTC stops on Gateway remain intact.

### 2. Cancel all open orders (clientId=1 since strategy stopped)

```bash
python <<'PY'
from ib_insync import IB
ib = IB()
ib.connect('100.x.x.x', 4004, clientId=1, timeout=15)
import time; time.sleep(2)
ib.reqAllOpenOrders(); time.sleep(3)
n = 0
for t in ib.openTrades():
    if t.orderStatus.status not in ('Cancelled', 'Filled'):
        print(f"cancel {t.contract.symbol} {t.order.orderType} {t.order.action} qty={t.order.totalQuantity}")
        ib.cancelOrder(t.order)
        n += 1
        time.sleep(0.5)
print(f"cancelled {n} orders")
time.sleep(5)
ib.disconnect()
PY
```

### 3. Flatten all positions to market

```bash
python <<'PY'
from ib_insync import IB, Stock, MarketOrder
ib = IB()
ib.connect('100.x.x.x', 4004, clientId=1, timeout=15)
import time; time.sleep(2)
n = 0
for p in ib.positions():
    qty = p.position
    if qty == 0:
        continue
    contract = Stock(p.contract.symbol, 'SMART', 'USD')
    ib.qualifyContracts(contract)
    if qty > 0:
        order = MarketOrder('SELL', abs(qty))
    else:
        order = MarketOrder('BUY', abs(qty))   # cover short
    order.tif = 'DAY'
    trade = ib.placeOrder(contract, order)
    print(f"flatten {p.contract.symbol} {'SELL' if qty>0 else 'COVER'} qty={abs(qty)}")
    n += 1
    time.sleep(0.5)
print(f"flattened {n} positions")
time.sleep(10)
print("--- post-flatten positions ---")
for p in ib.positions():
    print(f"  {p.contract.symbol}: {p.position}")
ib.disconnect()
PY
```

### 4. Verify flat

```bash
python <<'PY'
from ib_insync import IB
ib = IB()
ib.connect('100.x.x.x', 4004, clientId=99, timeout=15)
import time; time.sleep(3)
positions = [p for p in ib.positions() if p.position != 0]
ib.reqAllOpenOrders(); time.sleep(2)
orders = [t for t in ib.openTrades() if t.orderStatus.status not in ('Cancelled', 'Filled')]
print(f"positions: {len(positions)}, open orders: {len(orders)}")
nav = next((float(v.value) for v in ib.accountSummary() if v.tag == 'NetLiquidation'), 0)
cash = next((float(v.value) for v in ib.accountSummary() if v.tag == 'TotalCashValue'), 0)
print(f"NAV: ${nav:,.2f}, Cash: ${cash:,.2f} (should be ~equal after flatten)")
ib.disconnect()
PY
```

Expect: 0 positions, 0 orders, cash ≈ NAV.

### 5. Decision: restart or stay halted

**Restart strategy** (continue paper trading):
```bash
docker start ib-strategy
sleep 30
docker logs ib-strategy --tail 20
```
On startup, rehydrate finds 0 positions, tracker is empty, ready for next pre-open.

**Stay halted** (debug / disable):
```bash
# Already stopped. Strategy stays down until manual `docker start`.
# To prevent auto-start on host reboot:
docker update --restart=no ib-strategy
```

## Partial rollback (one symbol only)

Sometimes only one position is the issue:

```bash
SYM=ENS
python <<PY
from ib_insync import IB, Stock, MarketOrder
ib = IB()
ib.connect('100.x.x.x', 4004, clientId=1, timeout=15)
import time; time.sleep(2)

# Cancel orders for this symbol
ib.reqAllOpenOrders(); time.sleep(3)
for t in ib.openTrades():
    if t.contract.symbol == "$SYM" and t.orderStatus.status not in ('Cancelled', 'Filled'):
        ib.cancelOrder(t.order)
        print(f"cancelled {t.order.orderType} qty={t.order.totalQuantity}")
        time.sleep(0.5)

# Flatten this symbol
for p in ib.positions():
    if p.contract.symbol == "$SYM" and p.position != 0:
        contract = Stock("$SYM", 'SMART', 'USD'); ib.qualifyContracts(contract)
        order = MarketOrder('SELL' if p.position > 0 else 'BUY', abs(p.position))
        ib.placeOrder(contract, order)
        print(f"flatten {p.contract.symbol} qty={abs(p.position)}")
        time.sleep(2)
ib.disconnect()
PY
```

Then notify strategy by `docker restart ib-strategy` so it picks up the new state on rehydrate.

## Audit trail

After rollback, document why:
```
echo "$(date) ROLLBACK: <reason>" >> ~/lab/streams/experiments/trading/ibkr-gateway/ROLLBACK_LOG
git -C ~/lab/streams/experiments/trading/ibkr-gateway add ROLLBACK_LOG
git -C ~/lab/streams/experiments/trading/ibkr-gateway commit -m "ops: rollback — <reason>"
```

## NEVER

- Skip Phase 1 of `/ibkr:debug` because rollback is "easier" — you'll trigger it again next session
- Use `cancelAll()` then immediately re-place — race conditions create duplicate orders
- Run rollback while market closed (after-hours fills behave differently — wait for next session if possible)
