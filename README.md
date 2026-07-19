# Exilium

A market terminal for the **Path of Exile** economy with an **agent-native MCP server**.

Exilium ingests live Currency Exchange market data (via poe.ninja), stores it locally, runs signal detectors over it, and exposes everything three ways: a CLI, a local web dashboard, and an MCP server that lets AI agents (Claude Code, Claude Desktop, any MCP client) watch markets, price items, find opportunities, and draft trade plans.

**Exilium never executes trades.** It's decision support — every trade is performed by you, in-game. No automation, no session cookies, no game-file access.

Supports **PoE1 (default)** and **PoE2** (`EXILIUM_GAME=poe2`). Prices are in each game's primary currency: **chaos** for PoE1, **divine** for PoE2.

## Requirements

- **Node.js 20+** (`node --version`)
- ~5 minutes

## Install

```bash
git clone https://github.com/andrewli8/exilium.git
cd exilium
npm install
npm link        # makes `exilium` a global command (sudo npm link if /usr/local/bin is root-owned,
                # or: ln -s "$PWD/bin/exilium.js" ~/.local/bin/exilium)
```

Then from anywhere:

```bash
exilium              # launches the terminal UI — ingests and stays live on its own
exilium ingest       # or pull data explicitly
EXILIUM_GAME=poe2 exilium ingest   # optional: PoE2 into the same database
```

Data lives in `~/.exilium/exilium.db` regardless of where you run it. The TUI and dashboard keep it fresh automatically; `exilium ingest` and watch mode also work if you prefer explicit control.

*(Not yet on the npm registry — `npm install -g exilium` will work once published; until then `npm link` gives the identical experience.)*

## Using it

### Terminal UI — the Bloomberg-style front door

```bash
npx exilium        # `tui` is the default command
```

A full-screen terminal UI (built with Ink, the React-for-CLIs library) over the local market store:

- **1 · MOVERS** — biggest price moves with a 7-day unicode sparkline detail pane for the selected row
- **2 · OPPORTUNITIES** — live detector signals with edge, confidence, and rationale
- **3 · ARBITRAGE** — listed vs implied cross-rate table per market
- `↑/↓` select · `←/→` cycle item categories (All → Currency → Scarab → …) · `r` refresh now · `q` quit
- **Stays live on its own**: refetches market data every 5 minutes (`EXILIUM_REFRESH`, floor 300s) and shows a freshness dot — green under 10 min, amber under 30, red beyond. Leave it on a second monitor while you map.

### CLI commands

After `npm install`, run via `npx exilium <command>` (or `npm run <command>` for the long-running ones):

| Command | What it does |
|---|---|
| `exilium` / `exilium tui` | Full-screen terminal UI (default) |
| `exilium ingest` | Pull the latest market snapshots (PoE1: 13 categories, ~600 markets) |
| `exilium snapshot` | Top movers and top-volume markets in your terminal |
| `exilium categories` | Item categories with market counts and volume |
| `exilium list <category> [--sort value\|volume\|change]` | Browse every market in a category (Scarabs, Fragments, …) |
| `exilium opps [--min-edge N] [--experimental] [--category C]` | Current detector signals |
| `exilium arb [--min-gap N] [--limit N] [--category C]` | Cross-rate arbitrage table: listed vs implied price per market |
| `exilium price <item name>` | Price any currency/stackable |
| `exilium watch` | Notification loop (below) |
| `exilium dashboard` | Local web dashboard |
| `exilium mcp` | MCP server on stdio for AI agents |

### Arbitrage detection — honest scope

`exilium arb` (and the `find_arbitrage` MCP tool) compares every market's **listed price** against the **price implied by its highest-volume quote pair** and the core cross-rates — a two-leg cross-rate consistency check. Findings so far: the in-game exchange is *efficient* — gaps run under 0.5% in practice, which wouldn't survive gold fees. When a wide gap does appear (league start, low-volume markets, breaking news), `arb` and the watch loop will surface it. What Exilium deliberately does **not** claim: multi-leg triangular routes (the data source only quotes each market against the primary + one quote currency) and latency-race arbitrage (our data is minutes old and execution is human — see [PRD.md](./PRD.md) §2 for why we target durable edges instead).

### Watch mode — get pinged when a trade is available

```bash
npm run watch
```

Every 10 minutes (configurable, floored at 5 for API politeness) Exilium refreshes market data, runs the detectors, and when a **new** opportunity crosses your edge threshold it:

- sends a **desktop notification** (macOS/Linux),
- prints the full rationale to the terminal,
- optionally posts to a **Discord webhook** (`EXILIUM_WEBHOOK=https://discord.com/api/webhooks/...`).

Each opportunity notifies once — no repeat pings for the same signal. Tune it:

```bash
EXILIUM_MIN_EDGE=50 EXILIUM_WATCH_INTERVAL=300 npm run watch   # ≥50% edges, every 5 min
```

### Dashboard

```bash
npm run dashboard        # → http://localhost:4321
```

Opportunities (with rationale and confidence), **price-history charts for the top-volume markets** (drawn from your local snapshot history — they deepen the longer Exilium runs), top movers, and top-volume tables. **Self-sufficient**: ingests on boot, refetches every 5 minutes in the background, and the page reloads itself every 30s with a freshness badge — one tab replaces your poe.ninja tab pile.

### With Claude Code (recommended)

Register the MCP server once:

```bash
claude mcp add exilium -- npx tsx /path/to/exilium/src/cli.ts mcp
```

Then just talk to Claude in any session:

- *"What are the biggest movers in the PoE1 economy right now?"*
- *"Price a Divine Orb and an Awakened Sextant."*
- *"Find opportunities with at least 50% edge and draft me a trade plan for the best one."*
- *"Compare chaos/divine trends over the stored history."*

### With Claude Desktop or any MCP client

```json
{
  "mcpServers": {
    "exilium": {
      "command": "npx",
      "args": ["tsx", "/path/to/exilium/src/cli.ts", "mcp"]
    }
  }
}
```

### MCP tools

| Tool | What it does |
|---|---|
| `get_leagues` | Leagues with ingested data, per game |
| `get_market_snapshot` | Top movers + top volume for a league |
| `get_pair_history` | Stored price history + trailing sparkline for one item |
| `get_categories` | Item categories with market counts and volume |
| `list_items` | Every market in one category, sorted by value/volume/change |
| `find_arbitrage` | Cross-rate arbitrage table (listed vs implied), sorted by gap; category-filterable |
| `create_watch` | Persistent server-side watch: price_above/below, change_abs, or opportunity; once/repeat modes; optional webhook; idempotent by id |
| `list_watches` / `delete_watch` | Manage watches |
| `poll_watch_results` | Evaluate due watches and page fired events by cursor — agents without webhooks poll this |
| `price_item` | Price a currency/stackable by name, with conversions and confidence |
| `find_opportunities` | Current detector signals, filterable by edge; experimental signals are opt-in |
| `draft_trade_plan` | Turn an opportunity into an ordered, human-executable plan (gold fees flagged) |

Every tool takes an optional `game` (`poe1`/`poe2`) defaulting to the server's configured game. All tools serve locally cached data only — an agent can never trigger upstream API calls or spend anyone's rate limit. Watches are evaluated after every data refresh (TUI, dashboard, and watch-mode loops all evaluate them) and on each `poll_watch_results` call; fired events dedupe per data snapshot, and `once`-mode watches deactivate after firing.

**Rate-limit citizenship:** on a 429 from poe.ninja the client honors `Retry-After`, enters a cooldown (requests fail fast without hitting the network), and reports upstream health — if you see cooldown errors, raise `EXILIUM_REFRESH`.

## Configuration

| Env var | Default | Meaning |
|---|---|---|
| `EXILIUM_GAME` | `poe1` | `poe1` or `poe2` |
| `EXILIUM_LEAGUE` | auto | League name; auto-detects the current challenge league |
| `EXILIUM_DB` | `~/.exilium/exilium.db` | SQLite database path (one DB holds both games) |
| `EXILIUM_PORT` | `4321` | Dashboard port |
| `EXILIUM_REFRESH` | `300` | TUI/dashboard auto-refetch cadence in seconds (min 300) |
| `EXILIUM_MIN_EDGE` | `25` | Watch mode: minimum edge (%) to notify on |
| `EXILIUM_WATCH_INTERVAL` | `600` | Watch mode: seconds between cycles (min 300) |
| `EXILIUM_WEBHOOK` | — | Watch mode: Discord-compatible webhook URL |
| `EXILIUM_CONTACT` | — | Optional: appended to the User-Agent poe.ninja sees. The tool already identifies itself via the repo URL; set this only if you operate a fork/deployment and want API operators to reach *you* |

## Feature status vs the PRD

| PRD feature | Status |
|---|---|
| Market ingestion (poe.ninja exchange, PoE1 + PoE2) | ✅ 13 + 7 categories |
| Signal engine: mean-reversion | ✅ |
| Cross-rate arbitrage (`arb`, `find_arbitrage`) | ✅ (two-leg; markets are usually efficient) |
| MCP server (13 tools incl. agent watches) | ✅ |
| Watch/alerts (desktop, terminal, Discord webhook) | ✅ |
| Agent watches via MCP (create/list/delete/poll, webhooks) | ✅ |
| Pair price-history charts | ✅ dashboard; deepens as history accumulates |
| 429 backoff + upstream health telemetry | ✅ |
| Dashboard | ✅ lean web + full terminal UI (Ink) |
| Price history accumulation | ✅ grows with each ingest |
| Bulk↔single spread detector | ⛔ blocked: poe.ninja retired listing-based price APIs (everything is exchange-based now); needs a listing data source |
| Backtesting, fill-likelihood | 🕐 deferred until a full league of history is accumulated |
| OAuth stash valuation | 🕐 P1 — needs GGG application approval |
| Rare-item valuation | ⛔ out of scope by design (multi-month subsystem) |

## What the signals are (and aren't)

- **mean-reversion** — flags items whose latest daily move is a statistical outlier vs their trailing week (z-score), suggesting a pullback or recovery. A heuristic on minutes-to-hours-old data, not financial advice for your exalts.
- **cross-rate-divergence** *(experimental, opt-in)* — checks whether an item's price disagrees with the price implied by its highest-volume quote pair. In practice the in-game exchange keeps these tight (<0.5%), so flags are rare; it's a research signal.
- Every trade plan reminds you about **gold fees** (the in-game exchange charges gold per order) and tells you to re-verify the live ratio before confirming — data freshness is minutes at best.
- **Pricing covers currency/stackables only** — rare-item (mod-based) valuation is explicitly out of scope; see [PRD.md](./PRD.md).

## Development

```bash
npm test                       # vitest suite
npm run coverage               # enforces 80% thresholds
npx tsx scripts/smoke-mcp.ts   # end-to-end: spawns the real MCP server and exercises every tool
```

Architecture (full spec in [PRD.md](./PRD.md)): poe.ninja client → zod-validated normalizer → SQLite snapshot store → signal detectors → one service layer shared by the dashboard and the MCP server.

Non-negotiable design anchors:

1. Human-in-the-loop execution — no trade automation, ever.
2. Durable edges, not latency races.
3. MCP serves cached data only — never triggers upstream calls.
4. No POESESSID server-side, ever.

## Compliance

- Read-only market analytics from public community APIs, with a proper User-Agent.
- No trade execution, no game automation, no POESESSID handling, no game-file interaction — in line with GGG's third-party tool expectations.
- poe.ninja is a community resource: Exilium caches aggressively and polls politely. Don't cron faster than every 5 minutes.

## License

MIT
