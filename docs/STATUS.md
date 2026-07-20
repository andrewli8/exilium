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

- `exilium stash`: own-account stash valuation over the session cookie (client-side, same trust model as live), net-worth history (migration v4), and a gained/lost/value-delta trade check between snapshots. Landed with tests/stash.test.ts + tests/stash-repository.test.ts.

- Onboarding round: `exilium setup` wizard (TTY + scriptable piped mode, 600-perm config file), config-file support with env-var precedence, `exilium help`, TUI auto-ingests on fresh boot, unknown-command message points to help/setup.

- TUI table overhaul: search (s), column sort (f + arrows), full-list scrolling with position indicator, Enter opens trade-site search, 24H% change column (stored history first, sparkline fallback).

- TUI keybinding rework (arrows always navigate; c cycles categories; sort direction applies-and-exits) + trader price units (chaos ≥ 1 div renders in divines; dashboard shows real orb images from the PoE CDN).
- `exilium simulate`: in-memory watch + snipe simulation on synthetic moves (scripted or seeded-random), real pipelines end to end, for league-downtime testing.

- Category coverage expanded via API probing: PoE1 +Runegraft (14 total), PoE2 +Fragments/SoulCores/Abyss/Idols/UncutGems (12 total, ~147 new markets). TUI `c` is now a type-ahead category picker instead of a blind cycle.

- Full poe.ninja coverage: discovered the stash/item-overview API via site traffic; PoE1 now ingests 39 categories (~35K markets): 16 exchange (incl. previously missing DjinnCoin, Astrolabe) + 23 listing types with hourly cadence for heavy sweeps. Unresolved: Memory/Temple sidebar pages match no probed type name; PoE2 exposes no item-overview endpoint.

- Prices never use scientific notation (formatNumber routes every price display). Token-AND search (each query word matches independently) so "empower 4" finds a gem across the name/variant boundary. Gem variants render readably: "(lvl 1, 23q, corrupt)" instead of "(1/23c)".

Small follow-ups from approval conditions: TUI `r` within the 240s shared gate silently no-ops — surface "fetched Xs ago, skipped" in the TUI header.

## Review-response round (2026-07-19), completed
- Versioned migrations (C1); retention + latestAll cache (C2); onset/wall-clock/baseline backtest (C3); journal decayed-id warning + resolution (C4)
- Opportunity log (H1); track records + run_backtest in MCP (H2); idempotent record_outcome (H6)
- H3 shared ingest gate and H5 live-search backoff: first landing was dead code (caught by the approver — patch script aborted mid-application and the record overstated it); re-landed for real in the follow-up commit, with the gate now DEFAULT-ON inside ingestLeague and a default-path test so it cannot silently unwire again
- Freshness envelopes, sparkline opt-in, unchanged_since (M2/M3/M4)
- PM round: sellsheet, rising, release workflow + install.sh + docs/INSTALL.md (delegated track)
- Not done: cli.ts decomposition (H4, deferred — mechanical refactor), delta cursors beyond unchanged_since, npm publish (needs owner npm login), GGG OAuth (owner-deferred)
