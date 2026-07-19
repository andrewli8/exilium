# Status

Working backlog for the looptight loop. Each task carries evidence from the repo and an observable acceptance check.

## Done

- Trade journal (record_outcome MCP tool, `exilium journal` / `journal add` CLI, fill-rate summary). Landed with tests/journal.test.ts.
- CLI watch management (`exilium watches` list/add/rm/events). Landed with formatter tests and WatchRepository.latestEvents.
- TUI WATCHES pane (press 4) showing fired watch events. Landed with a tui test.
- Dashboard opportunities now respect EXILIUM_MIN_EDGE and exclude experimental signals unless EXILIUM_EXPERIMENTAL=1, matching every other surface.

## Next

1. Document the journal and watches commands where users will look for them.
   Evidence: src/cli.ts defines journal and watches commands but examples/02-cli-tour.md and the README command table do not mention them, and the README says 13 MCP tools while src/mcp/server.ts now registers 14 (record_outcome).
   Acceptance: README command table and MCP tool table include journal, watches, and record_outcome with the corrected tool count; examples/02-cli-tour.md gains sections for both commands; diff of those files shows the additions; npm test green.

2. Trade plans should point at the journal that now exists.
   Evidence: src/signals/trade-plan.ts:31; the final step says "Record the outcome (filled / partial / no-fill) to judge this detector's real-world hit rate" but does not say how, even though `exilium journal add` and the record_outcome MCP tool now exist.
   Acceptance: the final plan step names the exact command (`exilium journal add <opportunity_id> <outcome>`); the trade-plan test asserts the step mentions journal; npm test green.
