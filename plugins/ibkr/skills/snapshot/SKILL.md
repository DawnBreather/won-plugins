---
name: ibkr-snapshot
description: VNC-screenshot the IBKR Gateway UI for visual verification — login state, connection rows, blocking dialogs, error banners. Use when API behavior is unclear or after restarts. Triggers - "screenshot Gateway", "show me the Gateway UI", "/ibkr:snapshot".
---

# Gateway UI Snapshot

## One-liner

```bash
docker exec ib-2fa-agent bash -c "cat > /tmp/snap.py << 'PYEOF'
from vncdotool import api
c = api.connect('127.0.0.1::5900', password='${VNC_SERVER_PASSWORD:?need vnc pw}', timeout=10)
c.captureScreen('/tmp/gw.png')
c.disconnect()
print('OK')
PYEOF
timeout 20 python /tmp/snap.py" && \
docker cp ib-2fa-agent:/tmp/gw.png /tmp/gw.png && \
ls -la /tmp/gw.png
```

Then read /tmp/gw.png with the Read tool — it's a PNG.

## What to look for

### Healthy login screen (3 green rows)
```
| Purpose                       | Status     |
|-------------------------------|------------|
| Interactive Brokers API Server| connected  |
| Market Data Farm              | ON: usfarm |
| Historical Data Farm          | ON: ushmds |
```

### Pending dialogs (blocks API binding!)
- `Auto-restart will be enabled the next time you log in. Would you like to restart now?` → click No (Tab, Tab, Enter — Yes is left, No is right and is default focus)
- `Connection to server failed: Invalid username or password` → bad creds in `.env`
- `Re-login is required` → IBKR forced restart, broke session. Full container restart needed.
- `Unrecognized Username or Password` (red banner) → fresh creds + container down → up cycle

### Login screen (not yet logged in)
```
API Type: [FIX CTCI] [IB API]
Trading Mode: [Live Trading] [Paper Trading]
Username: <pre-filled or empty>
Password: <empty>
[Paper Log In] (red button)
```
IBC fills + clicks within 60s. If stuck here > 90s, IBC failed. Check `docker logs ib-gateway | grep "Login attempt"`.

## Send keystrokes via VNC (dismiss dialog)

```bash
docker exec ib-2fa-agent bash -c "cat > /tmp/click.py << 'PYEOF'
from vncdotool import api
import time
c = api.connect('127.0.0.1::5900', password='<vnc-pw>', timeout=10)
c.keyPress('enter')   # accept default focus (usually No)
# Or to click Yes: c.keyPress('tab'); time.sleep(0.2); c.keyPress('enter')
c.disconnect()
PYEOF
timeout 15 python /tmp/click.py"
```

## VNC viewer (interactive)

From any tailnet device:
```
vncviewer ib-gw:5900
# password: $VNC_SERVER_PASSWORD from .env
```

Or macOS Finder → ⌘K → `vnc://ib-gw:5900`.

For mouse control + persistent session, this is fastest.

## Live screen-watching (multiple snapshots)

```bash
for i in 1 2 3; do
  docker exec ib-2fa-agent bash -c "
from vncdotool import api
c = api.connect('127.0.0.1::5900', password='<vnc-pw>', timeout=10)
c.captureScreen('/tmp/gw_$i.png')
c.disconnect()
"
  docker cp ib-2fa-agent:/tmp/gw_$i.png /tmp/gw_$i.png
  sleep 30
done
```

## Resolution

Default Xvfb screen 1024x768x16. To change: edit gnzsnz image XVFB_OPTIONS env (rare need).

## Capturing during specific event

Time critical capture (e.g., during pre-open at 9:25):
```bash
# Wait until 9:25 ET
while [ $(TZ=America/New_York date +%H%M) -lt 925 ]; do sleep 30; done
# Capture every 5s for 5min
for i in $(seq 1 60); do
  docker exec ib-2fa-agent bash -c "..."   # snap.py
  docker cp ib-2fa-agent:/tmp/gw.png /tmp/gw_$(date +%H%M%S).png
  sleep 5
done
```
