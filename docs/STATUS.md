# Status

Working backlog for the looptight loop. Each task carries evidence from the repo and an observable acceptance check.

## Done

- Trade journal (record_outcome MCP tool, `exilium journal` / `journal add` CLI, fill-rate summary). Landed with tests/journal.test.ts.
- CLI watch management (`exilium watches` list/add/rm/events). Landed with formatter tests and WatchRepository.latestEvents.
- TUI WATCHES pane (press 4) showing fired watch events. Landed with a tui test.

## Next

1. Dashboard opportunity list should respect min-edge and exclude experimental by default.
   Evidence: src/cli.ts:239; cmdDashboard calls service.opportunities(config.game, league, true) with no minimum edge, so the dashboard shows experimental rows and sub-1% edges that every other surface filters (src/mcp/server.ts find_opportunities defaults include_experimental to false; cmdOpps applies config.minEdgePct).
   Acceptance: dashboard wiring uses config.minEdgePct and excludes experimental unless EXILIUM_EXPERIMENTAL=1; the diff of src/cli.ts shows the corrected call and a config test covers the new flag; npm test green.
