#!/usr/bin/env bash
# Generate (or verify) a fala-diag-v1 diagnostic file.
#   generate.sh --duration-s 28800 --out renders/diag/fala-diag-8h.m4a --verify
#   generate.sh verify renders/diag/fala-diag-8h.m4a
set -euo pipefail
ROOT=$(cd "$(dirname "$0")/../../.." && pwd)
# Some __pycache__ files are tracked in this repo; do not let a run rewrite them.
export PYTHONDONTWRITEBYTECODE=1
if [[ "${1:-}" == "verify" ]]; then
  exec uv run --project "$ROOT/analysis" python -m fala_audio_check.diagnostic "$@"
fi
exec uv run --project "$ROOT/analysis" python -m fala_audio_check.diagnostic generate "$@"
