# Status

Working backlog for the looptight loop. Each task carries evidence from the repo and an observable acceptance check.

## Next

- [ ] Trade journal: record and review trade-plan outcomes
  Evidence: src/signals/trade-plan.ts final step tells users to "Record the outcome (filled / partial / no-fill)" but nothing in the codebase stores outcomes; examples/03-common-workflows.md asks users to report outcomes to Claude with nowhere for them to land.
  Acceptance: `record_outcome` MCP tool and `exilium journal` CLI command exist; outcomes persist in SQLite with opportunity id, action, outcome, and note; `exilium journal` prints recorded outcomes with a realized-vs-expected summary; npm test green with new coverage.

- [ ] CLI management for watches (list, add, remove)
  Evidence: src/mcp/server.ts exposes create_watch/list_watches/delete_watch to agents, but src/cli.ts has no watches command, so a human cannot see or manage the watches an agent created without an MCP client.
  Acceptance: `exilium watches` lists active watches with kind/threshold/mode; `exilium watches add --kind price_above --item divine --threshold 750` creates one; `exilium watches rm <id>` deletes; `exilium watches events` shows recent fired events; npm test green.

- [ ] TUI pane for fired watch events
  Evidence: src/cli.ts dispatchWatchEvents runs inside the TUI refresh loop and records events to watch_events, but src/tui/app.tsx has no view that shows them; a TUI user cannot see what their watches fired without switching tools.
  Acceptance: pressing 4 in the TUI shows a WATCHES view listing recent fired events (item, kind, value, time) read from the watch events store; covered by a tui test; npm test green.

- [ ] Dashboard opportunity list should respect min-edge and exclude experimental by default
  Evidence: src/cli.ts cmdDashboard calls service.opportunities(config.game, league, true) with no minimum edge, so the web dashboard shows experimental cross-rate rows and sub-1% edges that every other surface filters (server.ts find_opportunities defaults include_experimental=false; cmdOpps applies config.minEdgePct).
  Acceptance: dashboard uses config.minEdgePct and excludes experimental signals unless EXILIUM_EXPERIMENTAL=1; behavior covered by a test on the wiring or render inputs; npm test green.
