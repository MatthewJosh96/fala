#!/bin/bash
cd "$(dirname "$0")"
for n in a-mobile a-desktop b-mobile; do
  ( start=$(date +%s); codex exec -m gpt-6.1-sol -c 'model_reasoning_effort="medium"' -s workspace-write -C "$PWD" - < $n.txt > $n.log 2>&1; rc=$?
    m=$( [ -f $n.png ] && stat -f %m $n.png || echo 0 ); echo "$n rc=$rc fresh=$([ $m -ge $start ] && echo yes || echo no) secs=$(( $(date +%s)-start ))" >> status.txt ) &
done
wait
