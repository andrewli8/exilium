# Exilium

A trading terminal for the Path of Exile economy with an agent-native MCP server — AI agents watch markets, detect durable-edge opportunities, and draft trade plans; humans execute in-game.

- **Product spec & architecture:** [PRD.md](./PRD.md) (v2.1, approved)
- **Status:** pre-implementation. P0 scope: PoE2 only — ingestion (GGG Currency Exchange digests, poe.ninja, POE2 Scout), quota governor, two durable-edge detectors, watches/alerts, MCP server (~8 tools), lean terminal UI.

## Non-negotiable design anchors

1. Human-in-the-loop execution — no trade automation, ever.
2. Durable edges, not latency races.
3. MCP serves cached data only — never triggers upstream GGG calls.
4. No POESESSID server-side, ever.
