#!/bin/sh
# Regenerates the PNG icons from scripts/icon.svg (needs rsvg-convert, e.g. brew install librsvg).
set -e
cd "$(dirname "$0")/.."
out=public/icons
mkdir -p "$out"
cp scripts/icon.svg "$out/favicon.svg"
rsvg-convert -w 180 -h 180 scripts/icon.svg -o "$out/apple-touch-icon-180.png"
rsvg-convert -w 192 -h 192 scripts/icon.svg -o "$out/icon-192.png"
rsvg-convert -w 512 -h 512 scripts/icon.svg -o "$out/icon-512.png"
# The wave already sits inside the 80% safe zone, so the maskable icon is the same art.
cp "$out/icon-512.png" "$out/icon-maskable-512.png"
