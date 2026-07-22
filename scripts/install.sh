#!/usr/bin/env bash
# One-line installer for Exilium. Downloads the standalone binary for your
# platform (no Node.js required) and puts `exilium` on your PATH.
#   curl -fsSL https://raw.githubusercontent.com/andrewli8/exilium/main/scripts/install.sh | bash
set -euo pipefail

REPO="andrewli8/exilium"
BIN_DIR="${EXILIUM_BIN_DIR:-$HOME/.local/bin}"

uname_s="$(uname -s)"
uname_m="$(uname -m)"
case "$uname_s" in
  Darwin) os="darwin" ;;
  Linux)  os="linux" ;;
  *) echo "Unsupported OS: $uname_s. On Windows, download exilium-windows-x64.exe from the releases page." >&2; exit 1 ;;
esac
case "$uname_m" in
  x86_64|amd64) arch="x64" ;;
  arm64|aarch64) arch="arm64" ;;
  *) echo "Unsupported architecture: $uname_m" >&2; exit 1 ;;
esac
asset="exilium-${os}-${arch}"

echo "Fetching the latest Exilium release ($asset)..."
url="https://github.com/${REPO}/releases/latest/download/${asset}"
mkdir -p "$BIN_DIR"
tmp="$(mktemp)"
if command -v curl >/dev/null 2>&1; then
  curl -fSL "$url" -o "$tmp"
elif command -v wget >/dev/null 2>&1; then
  wget -qO "$tmp" "$url"
else
  echo "Need curl or wget to download." >&2; exit 1
fi
chmod +x "$tmp"
mv "$tmp" "$BIN_DIR/exilium"

echo "Installed to $BIN_DIR/exilium"
# shellcheck disable=SC2016  # the $PATH in the hint is meant to stay literal
case ":$PATH:" in
  *":$BIN_DIR:"*) : ;;
  *) printf 'Add it to your PATH: export PATH="%s:$PATH"\n' "$BIN_DIR" ;;
esac
echo "Run 'exilium setup' to get started."
