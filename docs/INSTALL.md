# Installing exilium

exilium is a Node.js CLI. It needs **Node.js 20 or newer** on your `PATH`
(check with `node -v`). It uses `better-sqlite3`, a native module, so installs
are platform-specific — the tooling below handles that for you.

## Quick install (recommended)

```sh
curl -fsSL https://raw.githubusercontent.com/andrewli8/exilium/main/scripts/install.sh | bash
```

This will:

1. Verify Node.js >= 20 is installed.
2. Download the prebuilt release tarball for your platform
   (`linux-x64` or `darwin-arm64`), falling back to a git clone + production
   `npm install` if no matching release exists yet.
3. Install into `~/.exilium/app`.
4. Symlink the launcher to `~/.local/bin/exilium`.

If `~/.local/bin` is not on your `PATH`, the installer prints the line to add to
your shell profile, for example:

```sh
export PATH="$HOME/.local/bin:$PATH"
```

Then open a new shell (or `source` your profile) and run:

```sh
exilium --help
```

The installer is idempotent — re-run it any time to upgrade or repair an
install. You can override locations with `EXILIUM_HOME` (default `~/.exilium`)
and `EXILIUM_BIN_DIR` (default `~/.local/bin`).

## Manual install (git clone)

If you prefer to manage the checkout yourself:

```sh
git clone https://github.com/andrewli8/exilium.git
cd exilium
npm install                 # installs all dependencies, incl. the tsx runtime
node bin/exilium.js --help  # or: npm link, then `exilium --help`
```

`npm install` (without `--omit=dev`) is the simplest manual route because the
launcher runs the TypeScript sources through **tsx**, which is a
`devDependency`. If you install production-only with `npm install --omit=dev`,
add tsx afterwards:

```sh
npm install --omit=dev
npm install --no-save tsx
```

## Portable tarball

Each GitHub Release attaches a self-contained tarball per platform
(`exilium-<version>-<platform>.tar.gz`) plus a `.sha256` checksum. To use it
without the installer:

```sh
tar -xzf exilium-<version>-linux-x64.tar.gz
cd exilium-<version>-linux-x64
./run.sh --help
```

The tarball bundles the source, a platform-native `node_modules`, and the `tsx`
runtime, so it runs with only a Node.js runtime present.

## Windows

Native Windows is **untested**. Use [WSL](https://learn.microsoft.com/windows/wsl/install)
(Windows Subsystem for Linux) and follow the Linux instructions above — the
quick-install one-liner works inside a WSL shell. Running under native
PowerShell/CMD is not currently supported because the installer and launcher
assume a POSIX shell.
