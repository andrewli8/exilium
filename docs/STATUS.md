# Status

Working backlog for the looptight loop. Each task carries evidence from the repo and an observable acceptance check.

## Done

- Trade journal (record_outcome MCP tool, `exilium journal` / `journal add` CLI, fill-rate summary). Landed with tests/journal.test.ts.

## Next

1. CLI management for watches (list, add, remove, events).
   Evidence: src/mcp/server.ts:169; create_watch/list_watches/delete_watch exist for agents but src/cli.ts has no watches command, so a human cannot inspect or manage agent-created watches without an MCP client.
   Acceptance: `exilium watches` lists active watches, `exilium watches add`/`rm` manage them, `exilium watches events` shows recent fired events; formatter covered by a new failing-then-passing test in tests/cli-format.test.ts; npm test green.

2. TUI pane for fired watch events.
   Evidence: src/cli.ts:52; dispatchWatchEvents records events during the TUI refresh loop, but src/tui/app.tsx has no view that shows them, so a TUI user cannot see what their watches fired.
   Acceptance: pressing 4 in the TUI shows a WATCHES view listing recent fired events read from the watch-events store; a new test in tests/tui.test.tsx fails before implementation and passes after; npm test green.

3. Dashboard opportunity list should respect min-edge and exclude experimental by default.
   Evidence: src/cli.ts:239; cmdDashboard calls service.opportunities(config.game, league, true) with no minimum edge, so the dashboard shows experimental rows and sub-1% edges that every other surface filters (src/mcp/server.ts find_opportunities defaults include_experimental to false; cmdOpps applies config.minEdgePct).
   Acceptance: dashboard wiring uses config.minEdgePct and excludes experimental unless EXILIUM_EXPERIMENTAL=1; the diff of src/cli.ts shows the corrected call and a config test covers the new flag; npm test green.
