# Status

Working backlog for the looptight loop. Each task carries evidence from the repo and an observable acceptance check.

## Done

- Trade journal (record_outcome MCP tool, `exilium journal` / `journal add` CLI, fill-rate summary). Landed with tests/journal.test.ts.
- CLI watch management (`exilium watches` list/add/rm/events). Landed with formatter tests and WatchRepository.latestEvents.
- TUI WATCHES pane (press 4) showing fired watch events. Landed with a tui test.
- Dashboard opportunities now respect EXILIUM_MIN_EDGE and exclude experimental signals unless EXILIUM_EXPERIMENTAL=1, matching every other surface.
- README and CLI tour document journal, watches, and record_outcome; tool count corrected to 14.
- Trade plans name the exact journal command in their final step.

## Next

(queue empty — regenerate when new evidence-backed work appears)
