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

## Next

1. CI workflow so the verify gate runs on every push, not just this machine.
   Evidence: the repository has no .github directory, so npx tsc, npm test, and npm run eval only run locally; a push from any other machine lands unchecked.
   Acceptance: .github/workflows/ci.yml runs install, typecheck, tests, and evals on push and pull_request; the workflow passes on GitHub for the commit that adds it (verified with gh run watch).

2. Recorded real-payload fixtures for the normalizer.
   Evidence: tests/normalize.test.ts uses hand-built fixtures; the one production bug so far (null sparkline entries, fixed in commit "feat: v0") was real-payload schema drift that synthetic fixtures cannot catch.
   Acceptance: tests/fixtures/ contains one recorded poe.ninja exchange response per game and a test normalizes both, asserting line counts and field sanity; npm test green.

3. Backtest harness: replay stored history and measure detector hit rate.
   Evidence: docs/STATUS.md and PRD defer backtesting until history exists; the store now accumulates snapshots every refresh (src/storage/snapshot-repository.ts history()), and nothing measures whether mean-reversion signals actually revert.
   Acceptance: `exilium backtest [--horizon N]` replays chronological snapshots, fires detectors at each step, and reports per-detector signals, directional hit rate, and average forward move; core logic covered by tests with planted reverting and non-reverting series; npm test green.
