#!/usr/bin/env bash
# Record the phone's playback of the diagnostic file through a Mac audio input.
#   record_mac.sh --list                       list avfoundation devices
#   record_mac.sh DEVICE [DURATION_S] [OUT]    record (default 29400 s = 8 h 10 min)
# DEVICE is the avfoundation audio index (or exact name) from --list.
# Output: mono FLAC, 24 kHz, 16 bit (~0.8-1 GB for 8 h) in renders/recordings/ (not in Git),
# plus OUT.ffmpeg.log (warnings, e.g. input overruns) and OUT.progress.txt (speed every 30 s).
set -euo pipefail

if [[ "${1:-}" == "--list" || $# -eq 0 ]]; then
  ffmpeg -hide_banner -f avfoundation -list_devices true -i "" 2>&1 | sed -n '/audio devices/,$p' || true
  [[ $# -eq 0 ]] && echo "usage: $0 DEVICE [DURATION_S] [OUT]" >&2
  exit 0
fi

DEVICE=$1
DURATION=${2:-29400}
ROOT=$(cd "$(dirname "$0")/../../.." && pwd)
mkdir -p "$ROOT/renders/recordings"
[[ -f "$ROOT/renders/.gitignore" ]] || printf '*\n' > "$ROOT/renders/.gitignore"
OUT=${3:-$ROOT/renders/recordings/fala-diag-$(date +%Y%m%d-%H%M).flac}
LOG="${OUT%.*}.ffmpeg.log"
PROGRESS="${OUT%.*}.progress.txt"

echo "recording device :$DEVICE for ${DURATION} s -> $OUT"
echo "log: $LOG   progress: $PROGRESS   (stop early with q or Ctrl+C; the FLAC stays valid)"
# caffeinate keeps the Mac (and its disk) awake for the whole night; the large
# thread_queue_size absorbs scheduling hiccups before they become input overruns.
caffeinate -ims ffmpeg -hide_banner -nostdin -n -loglevel level+info -nostats \
  -f avfoundation -thread_queue_size 8192 -i ":$DEVICE" \
  -t "$DURATION" -vn -ac 1 -ar 24000 -c:a flac -sample_fmt s16 \
  -progress "$PROGRESS" -stats_period 30 \
  "$OUT" 2> "$LOG"
echo "done: $OUT"
grep -iE 'overrun|drop|queue|discontinu|non-monoton|error' "$LOG" || echo "no input warnings in $LOG"
