#!/usr/bin/env bash
# Compile standalone Exilium binaries for every platform with Bun. No Node,
# no native rebuild: bun:sqlite is embedded, so one machine builds all three.
set -euo pipefail
cd "$(dirname "$0")/.."
mkdir -p dist

VERSION="$(node -p "require('./package.json').version" 2>/dev/null || echo dev)"
COMMON=(./src/cli.ts --compile --minify --external better-sqlite3)

build() { # <bun-target> <outfile>
  echo "building $2 ..."
  bun build "${COMMON[@]}" --target="$1" --outfile "dist/$2"
}

build bun-linux-x64        "exilium-linux-x64"
build bun-linux-arm64      "exilium-linux-arm64"
build bun-darwin-x64       "exilium-darwin-x64"
build bun-darwin-arm64     "exilium-darwin-arm64"
build bun-windows-x64      "exilium-windows-x64.exe"

echo
echo "built exilium $VERSION:"
ls -lh dist/exilium-*
