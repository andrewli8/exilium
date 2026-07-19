#!/usr/bin/env sh
# Portable launcher shipped at the root of a release tarball.
# Runs exilium directly from the extracted directory, no install step needed:
#   ./run.sh <command> [args...]
here="$(cd "$(dirname "$0")" && pwd)"
exec node "$here/bin/exilium.js" "$@"
