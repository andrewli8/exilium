# Architect review — 2026-07-19

CRITICAL: C1 no schema migrations (CREATE IF NOT EXISTS never alters; next change bricks user DBs). C2 unbounded snapshot growth + hot-path full hydration in latestAll. C3 backtest statistics unsound (consecutive-tick double counting, tick-count horizons over irregular spacing, no null baseline). C4 journal add silently records expectedEdge 0 for decayed ids.

HIGH: H1 no persisted opportunity log (root cause: plan/journal/watch correlation all fail on history). H2 find_opportunities exposes no track record (backtest/journal stats invisible to agents). H3 rate-limit state per-process while docs encourage 3 processes. H4 cli.ts 515-line god module, import-time side effects. H5 live-search reconnects forever on dead cookie. H6 record_outcome not idempotent.

MEDIUM: M1 pollWatchResults mutates on read. M2 no freshness envelope on MCP responses. M3 no delta affordance. M4 list_items sparklines always included (token weight). M5 watch-eval recomputes sweeps per watch. M6 no golden-count regression on recorded fixtures. M7 upstreamHealth surfaced nowhere. M8 league rows never archived.

Top 5 for agentic accuracy: opportunity log; track record in find_opportunities + run_backtest tool; fix backtest stats; freshness envelope + delta cursors; idempotent record_outcome + decayed-id handling.
