#!/bin/sh
# Publishes the audio files listed in media/catalogue.json as assets of a GitHub release whose
# tag is the catalogue's "release" field (e.g. media-v1). The Pages workflow downloads exactly
# that release, so the site and its media stay in step.
#
#   scripts/publish-media.sh --dry-run   stage and verify only, nothing leaves the machine
#   scripts/publish-media.sh             create the release and upload the files
#
# FALA_REPO=owner/name overrides the repository (default: the one `gh` sees for this checkout).
# Releases are immutable: an existing tag is never modified. Changed audio needs a new tag
# in media/catalogue.json and a new file name (see docs/DEPLOY.md).
# Needs: node (>= 22.12), ffprobe, and for publishing an authenticated gh.
set -eu

dry_run=0
case "${1:-}" in
  --dry-run) dry_run=1 ;;
  '') ;;
  *) echo "usage: $0 [--dry-run]" >&2; exit 2 ;;
esac

root=$(cd "$(dirname "$0")/.." && pwd)
app="$root/apps/fala"
catalogue="$root/media/catalogue.json"
media() { node --no-warnings --experimental-strip-types "$app/scripts/media.ts" "$@"; }

release=$(node -p 'JSON.parse(require("fs").readFileSync(process.argv[1], "utf8")).release' "$catalogue")
case "$release" in
  media-v[0-9]*) ;;
  *) echo "unexpected release tag '$release' in $catalogue" >&2; exit 1 ;;
esac

stage=$(mktemp -d "${TMPDIR:-/tmp}/fala-media.XXXXXX")
trap 'rm -rf "$stage"' EXIT INT TERM

# Symlinks to the renders plus sidecars (size, SHA-256, duration); then the same strict check
# the Pages workflow runs on the downloaded release.
media stage --catalogue "$catalogue" --root "$root" --out "$stage"
media index "$stage" --strict --verify-sha --catalogue "$catalogue" --out "$stage/index.preview.json"
rm "$stage/index.preview.json"

echo "release $release:"
ls -lL "$stage"

if [ "$dry_run" -eq 1 ]; then
  echo "dry run: nothing uploaded"
  exit 0
fi

repo=${FALA_REPO:-$(cd "$root" && gh repo view --json nameWithOwner -q .nameWithOwner)}
gh auth status >/dev/null

if gh release view "$release" --repo "$repo" >/dev/null 2>&1; then
  echo "release $release already exists in $repo; releases are immutable." >&2
  echo "Bump \"release\" in media/catalogue.json (and rename changed files) to publish new audio." >&2
  exit 1
fi

# --latest=false: media releases are data, not app versions.
gh release create "$release" --repo "$repo" --latest=false \
  --title "Media $release" \
  --notes "Audio files for Fala (media/catalogue.json, release $release). Each .json sidecar holds the file's size, SHA-256 and duration." \
  "$stage"/*

echo "published $release to $repo; deploy the site: gh workflow run pages.yml --repo $repo"
