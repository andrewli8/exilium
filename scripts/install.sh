#!/usr/bin/env bash
#
# exilium installer.
#
#   curl -fsSL https://raw.githubusercontent.com/andrewli8/exilium/main/scripts/install.sh | bash
#
# Installs exilium into ~/.exilium/app and symlinks the launcher into
# ~/.local/bin/exilium. Prefers a prebuilt release tarball for the current
# platform (better-sqlite3 is a native module built per platform); if none is
# available it falls back to a git clone plus a production npm install.
#
# Safe to re-run: the app directory is replaced cleanly and the symlink is
# refreshed each time.

set -euo pipefail

REPO="andrewli8/exilium"
MIN_NODE_MAJOR=20
APP_DIR="${EXILIUM_HOME:-$HOME/.exilium}/app"
BIN_DIR="${EXILIUM_BIN_DIR:-$HOME/.local/bin}"
LAUNCHER="$BIN_DIR/exilium"

TMP_DIR=""
cleanup() { [ -n "$TMP_DIR" ] && rm -rf "$TMP_DIR"; }
trap cleanup EXIT

info() { printf '  %s\n' "$*"; }
step() { printf '\n==> %s\n' "$*"; }
warn() { printf 'warning: %s\n' "$*" >&2; }
die()  { printf 'error: %s\n' "$*" >&2; exit 1; }

have() { command -v "$1" >/dev/null 2>&1; }

# Fetch a URL to stdout using whichever downloader is available.
http_get() {
  if have curl; then
    curl -fsSL "$1"
  elif have wget; then
    wget -qO- "$1"
  else
    return 1
  fi
}

# Download a URL to a file.
http_download() {
  if have curl; then
    curl -fsSL "$1" -o "$2"
  elif have wget; then
    wget -qO "$2" "$1"
  else
    return 1
  fi
}

check_node() {
  step "Checking Node.js"
  have node || die "Node.js >= ${MIN_NODE_MAJOR} is required but 'node' was not found. Install it from https://nodejs.org and re-run."
  local raw major
  raw="$(node -v)"                 # e.g. v22.14.0
  major="${raw#v}"
  major="${major%%.*}"
  case "$major" in
    ''|*[!0-9]*) die "Could not parse Node.js version from '${raw}'." ;;
  esac
  [ "$major" -ge "$MIN_NODE_MAJOR" ] || die "Node.js >= ${MIN_NODE_MAJOR} is required, found ${raw}."
  info "Found Node.js ${raw}"
}

# Sets the global TARGET (e.g. linux-x64) or leaves it empty for platforms with
# no prebuilt tarball, which forces the git-clone fallback.
detect_target() {
  local os arch
  os="$(uname -s)"
  arch="$(uname -m)"
  case "$os" in
    Linux)  os="linux" ;;
    Darwin) os="darwin" ;;
    *)      os="" ;;
  esac
  case "$arch" in
    x86_64|amd64)  arch="x64" ;;
    arm64|aarch64) arch="arm64" ;;
    *)             arch="" ;;
  esac

  TARGET=""
  case "${os}-${arch}" in
    linux-x64|darwin-arm64) TARGET="${os}-${arch}" ;;
  esac
}

# Echoes the release asset download URL for TARGET, or nothing if unavailable.
find_release_asset() {
  local api json url
  api="https://api.github.com/repos/${REPO}/releases/latest"
  json="$(http_get "$api" 2>/dev/null)" || return 0
  url="$(printf '%s' "$json" | grep -o "https://[^\"]*-${TARGET}\.tar\.gz" | head -n1)"
  printf '%s' "$url"
}

install_from_tarball() {
  local url="$1"
  step "Downloading prebuilt release for ${TARGET}"
  info "$url"
  http_download "$url" "$TMP_DIR/exilium.tar.gz" || die "Download failed."

  step "Extracting"
  mkdir -p "$TMP_DIR/unpack"
  tar -xzf "$TMP_DIR/exilium.tar.gz" -C "$TMP_DIR/unpack"

  # The tarball contains a single top-level directory; move its contents in.
  local inner
  inner="$(find "$TMP_DIR/unpack" -mindepth 1 -maxdepth 1 -type d | head -n1)"
  [ -n "$inner" ] || die "Unexpected tarball layout."

  rm -rf "$APP_DIR"
  mkdir -p "$(dirname "$APP_DIR")"
  mv "$inner" "$APP_DIR"
}

install_from_git() {
  step "No prebuilt tarball available; installing from source"
  have git || die "git is required for the source install but was not found."
  have npm || die "npm is required for the source install but was not found."

  git clone --depth 1 "https://github.com/${REPO}.git" "$TMP_DIR/app"
  (
    cd "$TMP_DIR/app"
    info "Installing production dependencies (builds better-sqlite3 for this platform)"
    npm install --omit=dev --no-audit --no-fund
    # bin/exilium.js needs tsx at runtime; it is a devDependency, so add it
    # explicitly at the version pinned in package.json.
    local tsx_version
    tsx_version="$(node -p "require('./package.json').devDependencies.tsx")"
    npm install --no-save --no-audit --no-fund "tsx@${tsx_version}"
  )

  rm -rf "$APP_DIR"
  mkdir -p "$(dirname "$APP_DIR")"
  mv "$TMP_DIR/app" "$APP_DIR"
}

link_launcher() {
  step "Linking launcher"
  [ -f "$APP_DIR/bin/exilium.js" ] || die "Launcher not found at $APP_DIR/bin/exilium.js after install."
  chmod +x "$APP_DIR/bin/exilium.js"
  mkdir -p "$BIN_DIR"
  ln -sf "$APP_DIR/bin/exilium.js" "$LAUNCHER"
  info "Linked $LAUNCHER -> $APP_DIR/bin/exilium.js"

  case ":${PATH}:" in
    *":${BIN_DIR}:"*) : ;;
    *) warn "${BIN_DIR} is not on your PATH. Add this to your shell profile:"
       # shellcheck disable=SC2016  # $PATH is meant to be shown literally to the user
       printf '\n    export PATH="%s:$PATH"\n' "$BIN_DIR" >&2 ;;
  esac
}

main() {
  TMP_DIR="$(mktemp -d)"

  check_node
  detect_target

  local asset=""
  if [ -n "$TARGET" ]; then
    asset="$(find_release_asset)"
  fi

  if [ -n "$asset" ]; then
    install_from_tarball "$asset"
  else
    install_from_git
  fi

  link_launcher

  step "Done"
  info "Installed exilium to $APP_DIR"
  if have exilium || [ -x "$LAUNCHER" ]; then
    info "Run 'exilium --help' to get started (open a new shell if the command is not found yet)."
  fi
}

main "$@"
