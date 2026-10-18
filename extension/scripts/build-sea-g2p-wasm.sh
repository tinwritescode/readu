#!/usr/bin/env bash
# Builds sea-g2p (Vietnamese text normalisation + G2P, Rust, Apache-2.0) as a WebAssembly module in
# vendor/sea-g2p, for reading on this computer. sea-g2p.patch adds a "wasm" feature: the dictionary is passed
# in as bytes, because a browser has no file to map, and both stages share one copy of it.
# Needs rustup with the wasm32-unknown-unknown target and wasm-pack:
#   rustup target add wasm32-unknown-unknown && cargo install wasm-pack
set -euo pipefail

VERSION=0.10.0
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
OUT="$ROOT/vendor/sea-g2p"
WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT

TOOLCHAIN="$(dirname "$(rustup which cargo)")"
export PATH="$TOOLCHAIN:$PATH"

curl -sSL "https://files.pythonhosted.org/packages/source/s/sea_g2p/sea_g2p-$VERSION.tar.gz" | tar xz -C "$WORK"
SRC="$WORK/sea_g2p-$VERSION"
patch -d "$SRC" -p1 < "$ROOT/scripts/sea-g2p-wasm.patch"
(cd "$SRC" && wasm-pack build --release --target web --out-dir "$WORK/pkg" --no-default-features --features wasm)

mkdir -p "$OUT"
cp "$WORK/pkg/sea_g2p_rs.js" "$WORK/pkg/sea_g2p_rs_bg.wasm" "$WORK/pkg/sea_g2p_rs.d.ts" "$OUT/"
cp "$SRC/LICENSE" "$OUT/LICENSE"
echo "Built $OUT"
