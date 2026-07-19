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
- TUI opportunities pane shows the full trade plan for the selected row, including the journal command.
- Dashboard renders a Watch Events section fed by the same store as the TUI pane.
- `exilium live <trade-url>`: live-search monitoring over the user's own session (client-side only), whisper auto-copied to clipboard, never auto-sent. Landed with tests/live-search.test.ts.
- CLI integration suite: real command spawns (price/snapshot/opps/journal/watches) against a temp DB fixture.
- Recorded real poe.ninja payloads (both games) as normalizer fixtures.
- CI workflow (.github/workflows/ci.yml): typecheck + tests + evals on every push and PR.
- Backtest harness: `exilium backtest` replays snapshot history, scores directional signals (direction field added to opportunities); first real run showed 37% short-horizon hit rate — honest data the detectors must answer to.

## Next

(queue empty — regenerate when new evidence-backed work appears)
