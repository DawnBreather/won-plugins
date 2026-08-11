#!/usr/bin/env bash
# Decode every QR code on every extracted slide page.
#
# Usage:  decode-qr.sh <YYYYMMDD.church-ads dir>
#
# Uses zbarimg (brew install zbar), NOT jsQR. This matters: jsQR fails on
# photographed/projected slides that zbar reads instantly at plain 150 dpi.
# On 2026-08-09 jsQR returned nothing for 5 QR codes even at 600 dpi with
# tiling, inversion and thresholding; zbarimg decoded all 5 on the first try.
# Fall back to OpenCV only if zbar comes up empty.
set -euo pipefail

DIR="${1:?usage: decode-qr.sh <YYYYMMDD.church-ads dir>}"
RAW="$DIR/raw"
[ -d "$RAW" ] || { echo "no raw/ under $DIR" >&2; exit 1; }

command -v zbarimg >/dev/null || { echo "zbarimg missing: brew install zbar" >&2; exit 1; }

echo "page,url"
for f in "$RAW"/page-*.png; do
  [ -f "$f" ] || continue
  page=$(basename "$f" .png)

  # zbar first: fastest and most tolerant of photographed slides.
  # NB: zbarimg exits 4 when a page simply has no barcode — that is not an
  # error here, so swallow it (`|| true`) or `set -e` aborts the whole loop.
  url=$(zbarimg -q --raw "$f" 2>/dev/null | head -1 | tr -d '\r' || true)

  # OpenCV fallback (handles a few cases zbar misses, e.g. low-contrast prints)
  if [ -z "$url" ] && command -v python3 >/dev/null; then
    url=$(python3 - "$f" <<'PY' 2>/dev/null || true
import sys
try:
    import cv2
except ImportError:
    sys.exit(0)
img = cv2.imread(sys.argv[1])
if img is None:
    sys.exit(0)
ok, decoded, _, _ = cv2.QRCodeDetector().detectAndDecodeMulti(img)
if ok:
    for d in decoded:
        if d:
            print(d)
            break
PY
)
  fi

  [ -n "$url" ] && echo "$page,$url"
done
