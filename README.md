# Exilium

A terminal market tracker for the Path of Exile economy. It pulls live prices from poe.ninja, stores them locally, alerts you on the price moves you care about, and prices your items and stash. It also runs as an MCP server, so you can drive all of it from Claude.

**It never trades for you.** Everything is read-only market data and alerts. You make every trade yourself, in-game. No botting, no automation, no reading game files.

Free and open source (MIT). Runs entirely on your machine.

Covers PoE1 (default: 39 categories, ~35,000 markets including currency, uniques, gems, maps, jewels, beasts, and base types) and PoE2 (12 categories, set `EXILIUM_GAME=poe2`). PoE1 prices are in chaos, PoE2 in divine.

## What it does

- **The whole market in your terminal.** Top movers with 24h and 7d change, plus a searchable, sortable table of every tracked item. Press Enter on a row to open its trade search in your browser.
- **Price alerts.** Set a watch like "ping me if Mageblood drops below 100 div" and get a desktop notification or Discord message when it hits.
- **Price anything.** `exilium price headhunter` returns the going rate in chaos and divine.
- **Snipe live searches.** Point it at a pathofexile.com live search and it copies the trade whisper to your clipboard the moment a listing appears. You paste it in-game.
- **Value your stash.** See what a tab is worth and what changed since last time.
- **Ask Claude.** Register the MCP server, then ask "what are the biggest movers right now?" or "find me a flip with 50%+ edge and write out the steps."

## Install

You need Node.js 20 or newer (`node --version`). Takes about five minutes.

```bash
git clone https://github.com/andrewli8/exilium.git
cd exilium
npm install
npm link
```

`npm link` makes `exilium` a command you can run from anywhere. If `/usr/local/bin` is root-owned on your machine, use `sudo npm link`, or symlink it yourself:

```bash
ln -s "$PWD/bin/exilium.js" ~/.local/bin/exilium
```

Then, from any directory:

```bash
exilium setup    # pick your game and pull the first batch of data
exilium          # open the terminal UI
exilium help     # every command
```

Your data lives in `~/.exilium/`, and the terminal UI keeps itself refreshed every five minutes. Not on npm yet; once it is, `npm install -g exilium` will do the same thing.

## The terminal UI

`exilium` (or `exilium tui`) opens a full-screen terminal app over your local market data.

- **1 · MOVERS** the biggest price moves, with a 7-day sparkline for the selected row
- **2 · OPPORTUNITIES** detector signals with an edge estimate, confidence, and the reasoning
- **3 · ARBITRAGE** listed price vs implied cross-rate per market
- **4 · WATCHES** your fired price alerts

Keys: `s` search as you type, `f` sort a column, `w` set a watch on the selected row (threshold prefilled, direction inferred, divines for high-value items), `c` pick a category, `l` switch league, `Enter` open the item on the trade site, `↑↓` scroll (`Shift+↑↓` jumps ten), `r` refresh now, `q` quit.

A dot in the top corner shows how fresh the data is: green under 10 minutes, amber under 30, red beyond. It refetches every 5 minutes on its own, so you can leave it on a second monitor while you map.

## Commands

Run any of these as `exilium <command>` from anywhere after `npm link`.

| Command | What it does |
|---|---|
| `exilium setup` | One-time setup: game, first data pull, optional account and cookie |
| `exilium` / `exilium tui` | The terminal UI (default) |
| `exilium ingest` | Pull fresh market data now (the UI does this on its own; cron it if you like) |
| `exilium price <item>` | Price a currency, stackable, unique, gem, or map |
| `exilium snapshot` | Top movers and top-volume markets |
| `exilium categories` | Every category with market counts and volume |
| `exilium list <category>` | Browse one category. `--sort value\|volume\|change` |
| `exilium rising` | Volume-weighted top gainers, the league-start view |
| `exilium opps` | Detector signals. `--min-edge N` `--category C` `--experimental` |
| `exilium arb` | Cross-rate arbitrage table. `--min-gap N` `--limit N` |
| `exilium watch` | Foreground alert loop (desktop and Discord) |
| `exilium watches [add\|rm\|events]` | Manage saved watches, the same ones agents create |
| `exilium live <trade-url>` | Watch a trade-site live search; whispers land on your clipboard |
| `exilium stash --account "Name#1234"` | Value your stash, track net worth, see what changed |
| `exilium sellsheet --file counts.txt` | Price a dump tab into a bulk WTS message. `--discount N` |
| `exilium journal [add]` | Record trade outcomes and see your fill rate |
| `exilium backtest` | Score the detectors against your stored history. `--horizon N` |
| `exilium simulate [--live]` | Test watches and the snipe flow on fake market moves |
| `exilium dashboard` | Local web dashboard on http://localhost:4321 |
| `exilium mcp` | MCP server for Claude and other AI clients |

## Price alerts

```bash
exilium watch
```

Every 10 minutes (configurable, minimum 5 for API politeness) it refreshes the market, runs the detectors, and when a new signal crosses your edge threshold it sends a desktop notification, prints the reasoning, and optionally posts to a Discord webhook (`EXILIUM_WEBHOOK=...`). Each signal fires once. Tune it:

```bash
EXILIUM_MIN_EDGE=50 EXILIUM_WATCH_INTERVAL=300 exilium watch   # 50%+ edges, every 5 min
```

For alerts that survive restarts, use saved watches instead. `exilium watches add`, or press `w` in the terminal UI, or have Claude create them. Any running surface evaluates them.

## Snipe a live search

```bash
EXILIUM_POESESSID=<cookie> exilium live "https://www.pathofexile.com/trade/search/Mirage/AbC123xyz"
```

Build a search on pathofexile.com, copy the URL, and hand it to Exilium. When a listing appears it prints the item and price, sends a desktop notification, and copies the game's own whisper text to your clipboard. In-game that is one paste and Enter.

It copies the whisper, it does not send it. Auto-sending is the automation line GGG bans, and a paste is a single keypress like every other accepted tool. This needs your own POESESSID cookie (see [Your session cookie](#your-session-cookie) below); `exilium setup` can store it once.

## Use it from Claude

Register the MCP server once:

```bash
claude mcp add exilium -- exilium mcp
```

Then talk to Claude in any session:

- *"What are the biggest movers in PoE1 right now?"*
- *"Price a Divine Orb and a Headhunter."*
- *"Find opportunities with at least 50% edge and draft me a trade plan for the best one."*
- *"Watch for Mirror of Kalandra under 1500 div and tell me when I ask."*

For Claude Desktop or any other MCP client, add this to the client's config:

```json
{
  "mcpServers": {
    "exilium": { "command": "exilium", "args": ["mcp"] }
  }
}
```

The server exposes 15 tools: `get_leagues`, `get_market_snapshot`, `get_pair_history`, `get_categories`, `list_items`, `price_item`, `find_opportunities`, `find_arbitrage`, `draft_trade_plan`, `create_watch`, `list_watches`, `delete_watch`, `poll_watch_results`, `record_outcome`, and `run_backtest`. They serve only your local cached data, so an agent can never trigger an upstream request or spend anyone's rate limit.

## Configuration

| Env var | Default | Meaning |
|---|---|---|
| `EXILIUM_GAME` | `poe1` | `poe1` or `poe2` |
| `EXILIUM_LEAGUE` | auto | League name; auto-detects the current challenge league |
| `EXILIUM_DB` | `~/.exilium/exilium.db` | Database path (one DB holds both games) |
| `EXILIUM_PORT` | `4321` | Dashboard port |
| `EXILIUM_REFRESH` | `300` | UI auto-refresh cadence in seconds (minimum 300) |
| `EXILIUM_MIN_EDGE` | `25` | Watch mode: minimum edge (%) to notify on |
| `EXILIUM_WATCH_INTERVAL` | `600` | Watch mode: seconds between cycles (minimum 300) |
| `EXILIUM_WEBHOOK` | none | Watch mode: Discord-compatible webhook URL |

`exilium setup` writes these (and your optional cookie) to `~/.exilium/config.json`. Environment variables always override the file.

## What the signals actually mean

Be skeptical, because the market is efficient and this is a heuristic on data that is minutes old.

- **mean-reversion** flags an item whose latest daily move is a statistical outlier against its trailing week and is at least 10 percentage points off trend. The idea is it may snap back. It is not advice for your exalts.
- **cross-rate arbitrage** checks whether an item's price disagrees with the price implied by its busiest quote pair. In practice the in-game exchange keeps these gaps under half a percent, so real ones are rare and mostly show up at league start or on thin markets.

Every trade plan reminds you about the gold fee the exchange charges and tells you to re-check the live price before you commit. `exilium backtest` scores how often the detectors actually pointed the right way, with a same-window baseline to compare against, so you can decide how much to trust them.

## Your session cookie

Two commands, `stash` and `live`, need your pathofexile.com session cookie (POESESSID). Everything else works without one. Here is exactly how it is handled:

- Stored in `~/.exilium/config.json` with 600 permissions, outside any git repo. Exilium re-tightens the permissions if they ever loosen.
- Sent to one host only, `www.pathofexile.com`, over HTTPS. There is no Exilium server; the cookie never goes anywhere else, including poe.ninja.
- Never written to the database, never logged, never shown in errors.
- Optional. Skip it in setup and pass `EXILIUM_POESESSID` per run, or skip it entirely.
- Revocable. Log out of pathofexile.com in your browser and the cookie is dead.

`exilium setup` prints where to find it (F12, Application or Storage, Cookies, pathofexile.com, POESESSID). This is the same session-cookie approach Awakened PoE Trade and similar tools use.

## Compliance

Read-only analytics from public community APIs, with a proper User-Agent. No trade execution, no game automation, no game-file access. Whispers are copied, never auto-sent. Stash reads are your own account only. Exilium caches aggressively and does not poll faster than every five minutes.

## Examples

Step-by-step walkthroughs with real output live in [examples/](examples/): [checking prices](examples/01-checking-prices.md), [a tour of every command](examples/02-cli-tour.md), [common workflows](examples/03-common-workflows.md), [arbitrage](examples/04-arbitrage.md), and [live search](examples/05-live-search.md).

## For developers

```bash
npm test          # test suite
npm run eval      # detector accuracy checks against planted data
npm run coverage  # coverage (80% threshold)
```

The flow is: poe.ninja client, a zod-validated normalizer, a SQLite snapshot store, the signal detectors, and one service layer shared by the dashboard and the MCP server. Full design notes are in [PRD.md](./PRD.md).

## License

MIT
