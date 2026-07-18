# Exilium

A market terminal for the **Path of Exile** economy with an **agent-native MCP server**.

Exilium ingests live Currency Exchange market data (via poe.ninja), stores it locally, runs signal detectors over it, and exposes everything three ways: a CLI, a local web dashboard, and an MCP server that lets AI agents (Claude Code, Claude Desktop, any MCP client) watch markets, price items, find opportunities, and draft trade plans.

**Exilium never executes trades.** It's decision support — every trade is performed by you, in-game. No automation, no session cookies, no game-file access.

Supports **PoE1 (default)** and **PoE2** (`EXILIUM_GAME=poe2`). Prices are in each game's primary currency: **chaos** for PoE1, **divine** for PoE2.

## Requirements

- **Node.js 20+** (`node --version`)
- ~5 minutes

## Setup

```bash
git clone https://github.com/andrewli8/exilium.git
cd exilium
npm install

# Pull the latest market data (PoE1, current challenge league auto-detected)
EXILIUM_CONTACT="you@example.com" npm run ingest

# Optional: also pull PoE2 data into the same database
EXILIUM_CONTACT="you@example.com" EXILIUM_GAME=poe2 npm run ingest
```

`EXILIUM_CONTACT` identifies you to poe.ninja in the User-Agent header (API etiquette — please set it to a real way to reach you).

Data is a snapshot at ingest time. Re-run `npm run ingest` whenever you want fresh prices — each run also builds up price history. If you want it hands-off, cron it every 5–10 minutes:

```
*/10 * * * * cd /path/to/exilium && EXILIUM_CONTACT="you@example.com" npm run ingest
```

## Using it

### Dashboard

```bash
npm run dashboard        # → http://localhost:4321
```

Opportunities (with rationale and confidence), top movers, and top-volume markets for your configured game/league.

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
| `price_item` | Price a currency/stackable by name, with conversions and confidence |
| `find_opportunities` | Current detector signals, filterable by edge; experimental signals are opt-in |
| `draft_trade_plan` | Turn an opportunity into an ordered, human-executable plan (gold fees flagged) |

Every tool takes an optional `game` (`poe1`/`poe2`) defaulting to the server's configured game. All tools serve locally cached data only — an agent can never trigger upstream API calls or spend anyone's rate limit.

## Configuration

| Env var | Default | Meaning |
|---|---|---|
| `EXILIUM_GAME` | `poe1` | `poe1` or `poe2` |
| `EXILIUM_CONTACT` | — | Contact info sent in the User-Agent to poe.ninja (please set) |
| `EXILIUM_LEAGUE` | auto | League name; auto-detects the current challenge league |
| `EXILIUM_DB` | `exilium.db` | SQLite database path (one DB holds both games) |
| `EXILIUM_PORT` | `4321` | Dashboard port |

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
