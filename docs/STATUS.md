# Status

Working backlog for the looptight loop. Each task carries evidence from the repo and an observable acceptance check.

## Done

- Trade journal (record_outcome MCP tool, `exilium journal` / `journal add` CLI, fill-rate summary). Landed with tests/journal.test.ts.
- CLI watch management (`exilium watches` list/add/rm/events). Landed with formatter tests and WatchRepository.latestEvents.
- TUI WATCHES pane (press 4) showing fired watch events. Landed with a tui test.
- Dashboard opportunities now respect EXILIUM_MIN_EDGE and exclude experimental signals unless EXILIUM_EXPERIMENTAL=1, matching every other surface.
- README and CLI tour document journal, watches, and record_outcome; tool count corrected to 14.
- Trade plans name the exact journal command in their final step.
- Journal summary breaks fill rate down per detector (parsed from opportunity-id prefixes); `exilium journal` prints the breakdown.

## Next

1. Selecting an opportunity in the TUI should show its trade plan.
   Evidence: src/tui/app.tsx OppsPane renders only table rows, while MoversPane shows a detail block for the selected row; a TUI user who spots a signal must leave the TUI (CLI or MCP) to see the plan steps, including the journal command in the final step (src/signals/trade-plan.ts:19).
   Acceptance: the opportunities pane shows the drafted plan (summary and steps) for the selected row; a new test in tests/tui.test.tsx asserts the plan's journal instruction is visible after pressing 2; npm test green.

2. Dashboard should show fired watch events like the TUI does.
   Evidence: src/dashboard/render.ts has no watch-events section although the dashboard's refresh loop records them (src/cli.ts dispatchWatchEvents), and the TUI gained a WATCHES pane; dashboard users cannot see what their watches fired.
   Acceptance: renderDashboard accepts recent watch events and renders a Watch Events section when non-empty; cmdDashboard passes them; failing-then-passing test in tests/dashboard.test.ts; npm test green.
