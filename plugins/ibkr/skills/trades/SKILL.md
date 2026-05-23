---
name: ibkr-trades
description: Show today's executions, fill detail, realized + unrealized PnL by symbol, win/loss attribution. Use to review trading session results. Triggers - "show today's trades", "PnL breakdown", "executions today", "/ibkr:trades".
---

# IBKR Trade Stats

## Today's executions + PnL

```bash
python <<'PY'
from ib_insync import IB
from collections import defaultdict
ib = IB()
ib.connect('100.x.x.x', 4004, clientId=87, timeout=15)
import time; time.sleep(3)

# Account totals
vals = {v.tag: v.value for v in ib.accountSummary()}
print('=== ACCOUNT ===')
print(f"NAV:           ${float(vals.get('NetLiquidation', 0)):>14,.2f}")
print(f"Cash:          ${float(vals.get('TotalCashValue', 0)):>14,.2f}")
print(f"GrossPosVal:   ${float(vals.get('GrossPositionValue', 0)):>14,.2f}")
print(f"RealizedPnL:   ${float(vals.get('RealizedPnL', 0)):>14,.2f}")
print(f"UnrealizedPnL: ${float(vals.get('UnrealizedPnL', 0)):>14,.2f}")

# Per-symbol fills
fills = ib.fills()
print(f"\n=== FILLS TODAY ({len(fills)}) ===")
by_sym = defaultdict(lambda: {'bot_qty': 0, 'bot_dollars': 0.0, 'sld_qty': 0, 'sld_dollars': 0.0, 'commission': 0.0, 'realized': 0.0})
for f in fills:
    sym = f.contract.symbol
    side = f.execution.side  # BOT or SLD
    qty = f.execution.shares
    px = f.execution.price
    if side == 'BOT':
        by_sym[sym]['bot_qty'] += qty
        by_sym[sym]['bot_dollars'] += qty * px
    else:
        by_sym[sym]['sld_qty'] += qty
        by_sym[sym]['sld_dollars'] += qty * px
    if f.commissionReport:
        by_sym[sym]['commission'] += f.commissionReport.commission or 0
        by_sym[sym]['realized'] += f.commissionReport.realizedPNL or 0

for sym, s in sorted(by_sym.items()):
    avg_buy = s['bot_dollars']/s['bot_qty'] if s['bot_qty'] else 0
    avg_sell = s['sld_dollars']/s['sld_qty'] if s['sld_qty'] else 0
    print(f"  {sym:6}  bought {s['bot_qty']:>7.0f} @ ${avg_buy:>7.2f}  "
          f"sold {s['sld_qty']:>7.0f} @ ${avg_sell:>7.2f}  "
          f"realized ${s['realized']:>+9.2f}  comm ${s['commission']:>5.2f}")

# Open positions snapshot
print(f"\n=== OPEN POSITIONS ===")
for p in ib.positions():
    val = p.position * p.avgCost
    print(f"  {p.contract.symbol}: {p.position:>8.0f} sh @ ${p.avgCost:.4f}  cost basis ${val:,.0f}")
ib.disconnect()
PY
```

## Strategy log perspective

```bash
docker logs ib-strategy 2>&1 | grep -E "BUY LIMIT|SELL MKT|SHORT LIMIT|COVER MKT|PYRAMID|EXIT |FLAT |REHYDRATED" | tail -30
```

## Win rate / R-multiple by exit reason

```bash
docker logs ib-strategy 2>&1 | grep "EXIT " | awk '{print $NF}' | sort | uniq -c
```

Common reasons:
- `hard_stop` → max loss hit
- `failed_breakout` → close below pivot at EOD (post-fix only fires after 15:50 ET + days_held >= 1)
- `time_stop` → 21 days, < +3%
- `pop_and_drop` → EOD; gain ≥ 7% but stalling
- `climax_volume` → EOD; high volume + topping wick
- `ma50_break` → gain > 30% then breaks below MA50

## Pyramid stats

```bash
docker logs ib-strategy 2>&1 | grep "PYRAMID" | awk '{print $4, $11}' | sort | uniq -c | head
```

## Cancel-rate (orders submitted vs filled)

```bash
SUBMITTED=$(docker logs ib-strategy 2>&1 | grep -c "BUY LIMIT\|SHORT LIMIT")
FILLED=$(docker logs ib-strategy 2>&1 | grep -c "POSITION OPEN")
echo "submitted=$SUBMITTED filled=$FILLED hit-rate=$(python -c "print(f'{$FILLED/$SUBMITTED:.1%}')")"
```

Low fill rate (< 30%) is normal for VCP breakouts — many limits don't trigger because pivots not touched.

## Find specific symbol's full lifecycle

```bash
SYM=LION
docker logs ib-strategy 2>&1 | grep -E "${SYM}.*(BUY LIMIT|STOP|PYRAMID|EXIT|REHYDRATED|POSITION)" | head -20
```

## Realized PnL math sanity check

For each closed symbol:
- buy_qty * avg_buy_px should equal sell_qty * avg_sell_px (modulo partial fills)
- realized = sell_qty * (avg_sell_px - avg_buy_px) - commission
- If realized exceeds expected hard-stop loss → may be the partial-fill flip-to-short bug; check `/ibkr:stops` for orphan order qty

## Notable historic trades log

Look for outlier PnL events:
```bash
docker logs ib-strategy 2>&1 | grep "realizedPNL=" | grep -v "realizedPNL=0\b" | tail -10
```
