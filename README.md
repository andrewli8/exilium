# Exilium

A trading terminal for the Path of Exile economy with an agent-native MCP server — AI agents watch markets, detect durable-edge opportunities, and draft trade plans; humans execute in-game.

- **Product spec & architecture:** [PRD.md](./PRD.md) (v2.1, approved)
- **Status:** v0 working. **PoE1 by default** (PoE2 via `EXILIUM_GAME=poe2`) — poe.ninja exchange API, SQLite storage, two detectors, 6-tool MCP server, lean dashboard. Prices are in the game's primary currency: **chaos for PoE1, divine for PoE2**.

## Quick start

```bash
npm install
EXILIUM_CONTACT="you@example.com" npm run ingest   # pull latest market snapshots
npm run dashboard                                   # http://localhost:4321
npm run mcp                                         # MCP server on stdio
npm test                                            # 53 tests; npm run coverage for the 80% gate
npx tsx scripts/smoke-mcp.ts                        # end-to-end MCP smoke test
```

Config via env: `EXILIUM_GAME` (`poe1` default | `poe2`), `EXILIUM_CONTACT` (identifies you to poe.ninja — set it), `EXILIUM_LEAGUE` (default: auto-detect current challenge league), `EXILIUM_DB` (default `exilium.db`), `EXILIUM_PORT` (default 4321). One database holds both games; ingest each with its own `EXILIUM_GAME` run.

### Use with Claude Code / any MCP client

```json
{
  "mcpServers": {
    "exilium": {
      "command": "npx",
      "args": ["tsx", "src/cli.ts", "mcp"],
      "cwd": "/path/to/exilium"
    }
  }
}
```

Tools: `get_leagues`, `get_market_snapshot`, `get_pair_history`, `price_item`, `find_opportunities`, `draft_trade_plan`. Every tool takes an optional `game` (`poe1`|`poe2`) defaulting to the server's configured game (poe1 unless `EXILIUM_GAME=poe2`). All serve cached snapshot data only — run `npm run ingest` (cron it every 5–10 min if you like) to refresh.

## v0 scope notes

- **Detectors:** mean-reversion (z-score of latest daily change vs trailing window) and cross-rate divergence (experimental, opt-in via `include_experimental`). The PRD's bulk↔single spread detector needs a single-listing data source that PoE2 currently lacks (POE2 Scout's API returned empty; poe.ninja has no PoE2 item overviews) — revisit when one exists.
- **Pricing:** currency/stackables only, by design. Rare-item valuation is explicitly out of scope (PRD §6).
- **`get_pair_history`** accumulates real history as ingestion runs repeatedly; day one it leans on poe.ninja's 7-point sparkline.

## Non-negotiable design anchors

1. Human-in-the-loop execution — no trade automation, ever.
2. Durable edges, not latency races.
3. MCP serves cached data only — never triggers upstream GGG calls.
4. No POESESSID server-side, ever.
