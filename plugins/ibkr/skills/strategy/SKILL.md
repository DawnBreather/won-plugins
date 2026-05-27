---
name: ibkr-strategy-selector
description: View current strategy, switch between Minervini ↔ ETF Momentum, trigger manual ETF rebalance. Triggers - "switch to ETF", "what strategy is running", "rebalance now", "/ibkr:strategy".
---

# IBKR Strategy Selector

Two strategies coexist in the live container, selected by `STRATEGY` env var.

| value | engine | rebalance |
|---|---|---|
| `minervini` (default) | stock pyramid (Minervini SEPA) | intraday daily + ORB + monitor + flatten |
| `etf_momentum` | top-5 ETF blend | monthly, first market day ~10:00 ET |

Backtest stats (see `~/lab/streams/experiments/trading/.docs/strategies.md`):

| | Minervini | ETF |
|---|---|---|
| CAGR | 19.7% | **50.9%** |
| Sharpe | 1.37 | **3.34** |
| Max DD | -17.5% | **-8.5%** |

## Current strategy

```bash
docker exec ib-strategy printenv STRATEGY
docker logs ib-strategy --tail 1 2>&1 | grep "STRATEGY ACTIVE"
```

## Switch Minervini → ETF

**Pre-flight:**
- Market open (09:30-15:45 ET) — script enforces
- supervisor LOGGED_IN_OK — script enforces
- No pending Minervini orders mid-flight
- LION (or other) positions OK to flatten to market

**Run:**
```bash
bash ~/lab/streams/experiments/trading/ibkr-gateway/scripts/switch_to_etf.sh
```

**What it does:**
1. Stop Minervini container (clean state save)
2. Cancel all open orders (clientId=1)
3. Flatten all positions to market (clientId=86)
4. Wipe strategy-state volume (Minervini Position dataclass irrelevant for ETF)
5. Inject `STRATEGY=etf_momentum` into docker-compose.yml
6. Start ETF container
7. Trigger first manual rebalance

**Rollback to Minervini:**
```bash
# Edit docker-compose.yml: change STRATEGY back to minervini
sed -i 's/STRATEGY: "etf_momentum"/STRATEGY: "minervini"/' \
  ~/lab/streams/experiments/trading/ibkr-gateway/docker-compose.yml
docker compose up -d strategy
```
Note: Minervini state lost on previous wipe — re-runs nightly + new candidates fresh.

## ETF manual rebalance

```bash
docker compose exec strategy python /app/run.py --rebalance        # live
docker compose exec strategy python /app/run.py --rebalance-dry    # dry-run
```

Or one-shot in fresh container:
```bash
cd ~/lab/streams/experiments/trading/ibkr-gateway
docker compose run --rm \
  -e STRATEGY=etf_momentum \
  -e IBKR_CLIENT_ID=86 \
  --entrypoint python strategy /app/run.py --rebalance-dry
```

## ETF status

```bash
docker compose exec strategy python /app/run.py --status
```

Shows: engine, NAV, current positions, target weights, last rebalance date, regime.

Or via supervisor file:
```bash
docker exec ib-healthcheck cat /supervisor-state/supervisor.json
```

## What ETF strategy does

Monthly rebalance (first market day at 10:00 ET):

1. Pull EOD bars for 18 ETF universe + 8 risk-off candidates
2. Compute vol-adjusted blended momentum (12mo + 6mo + 3mo blend, weights 1:1:2)
3. Apply Minervini Trend Template filter (MA50 > MA150 > MA200, near 52w high, off 52w low)
4. Rank top-5 with cluster-dedup (skip if >0.85 corr to already-selected)
5. Inverse-vol weight selected
6. Stress overlay — count amber signals (VIX backwardation, momentum breadth, stocks-bonds correlation), scale exposure 1.0/0.7/0.5/0.0 per amber=0/2/3/4+
7. Remainder to dynamic risk-off basket (top-3 momentum from BIL/SHY/IEF/TLT/GLD/TIP/UUP/BTAL)
8. Diff vs current positions, submit market orders for changes > 2% NAV

## Universe (18 equity ETFs)

SPY QQQ IWM EFA EEM TLT IEF GLD DBC PDBC VNQ TIP HYG XLE INDA SMH UUP BTAL

## Risk-off candidates (8 safe-haven ETFs)

BIL SHY IEF TLT GLD TIP UUP BTAL

## Files

- `strategy/engine_etf.py` — engine
- `strategy/etf_lib/` — bundled signal/data lib (forex-trading port)
- `strategy/etf_stress.py` — stress amber-signal overlay
- `strategy/run.py` — selector + ETF loop
- `scripts/switch_to_etf.sh` — automated switchover
