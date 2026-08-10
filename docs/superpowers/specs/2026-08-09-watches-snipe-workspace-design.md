# Watches Snipe Workspace Design

## Goal

Make live sniping manageable from tab 4 of the main `exilium` TUI while preserving `exilium snipe` as a focused standalone command. An enabled search must remain visible and selectable even when none of its listings meets the profit floor. All trade HTTP requests must share a coordinated rate-limit scheduler whose state is visible without disrupting the Ink layout.

This specification supersedes the compact-board requirement that the board become empty when every candidate is hidden. The board now always contains one row per enabled search.

## Watches workspace

Tab 4 becomes a WATCHES workspace with two internal views:

- `PRICE ALERTS` renders the existing persistent watch-event history.
- `SNIPES` renders Better Trading live-search status and candidates.

`Tab` and `Shift+Tab` switch between these views. `Escape` closes an overlay or returns to the preceding Watches view. The market tabs retain their existing behavior.

The SNIPES table always has one row per enabled search. Each row shows the label, runtime state, best qualifying candidate, profit, listing age, and hidden/other candidate count. A search without a qualifying candidate renders an explicit empty best value instead of disappearing:

```text
SEARCH             STATE       BEST       PROFIT   AGE    OTHER
sublime vision     LIVE        -          -        -      10 hidden
mageblood          COOLDOWN    176 div    +24.1%   38s    9 hidden
nimis              SEEDING     -          -        -      -
```

The header distinguishes connected searches from visible candidates and reports progress such as `5 LIVE`, `SEEDING 3/5`, or `COOLDOWN 4s`. Runtime messages render in a stable status region rather than being printed through the Ink display.

Within SNIPES:

- Up and Down move through search rows or detail candidates.
- Enter revalidates and travels to the selected search's best qualifying candidate.
- Enter on a search with no qualifying candidate is a no-op with a short explanatory status.
- Shift+Enter opens that search's complete Valdo candidate list.
- `u` toggles below-floor and unknown candidates.
- `f` changes the session profit floor.
- Tab, Shift+Tab, and Escape preserve the selected search when changing views.

If revalidation reports that a listing is gone, the runtime removes it, promotes the next-best candidate, and displays a brief notice. It does not automatically travel to the replacement; the user presses Enter again after reviewing the updated row.

## Configuration shortcut

In WATCHES, `c` is context-sensitive and opens an in-TUI snipe configuration overlay. In the market tabs, `c` continues to open category selection.

The overlay lists Better Trading searches and supports:

- Space to enable or disable a search;
- `a` to toggle all searches;
- `e` to edit its label, trade URL, or per-search margin floor;
- `i` to paste/import a Better Trading export;
- Enter to save and start or restart the selected searches;
- Escape to save configuration without starting a new runtime.

Invalid edits or imports keep the overlay open and identify the invalid field. Catalog writes use the same Better Trading storage already consumed by `exilium snipe list`, `add`, `edit`, and `remove`, so there is no second source of truth.

Opening the main `exilium` TUI does not automatically start new snipe monitoring or spend trade API allowance. The user starts the enabled selection explicitly with Enter from the configuration overlay. Once started, monitoring remains active while the TUI session is active. The focused `exilium snipe` command continues to start its selected searches directly.

## Runtime and rendering boundary

The existing snipe orchestration is separated from its standalone Ink renderer:

- `SnipeRuntime` owns WebSockets, startup seeding, candidate ingestion, travel actions, notification, and bounded shutdown.
- `SnipeStore` owns immutable snapshots of search status, queue state, candidates, progress, cooldown, and stable status messages.
- The standalone snipe screen and tab-4 SNIPES view subscribe to the same store contract and render the same records.
- The configuration overlay owns catalog edits but asks the surrounding command to start or restart the runtime.

The store records stable search identities independently of candidate entries. This is what allows an enabled search with zero visible candidates to remain navigable. Dismissed, gone, traveled, and queue-evicted listing IDs retain their terminal state and are not resurrected when later alert snapshots arrive.

The main TUI runs the snipe runtime in-process rather than spawning a second interactive CLI. Only one Ink application owns stdin. The standalone command composes the same runtime with its focused renderer.

## Coordinated trade rate limiting

All pathofexile.com trade HTTP requests in the process use one request scheduler, including saved-query reads, search submissions, listing-detail fetches, price checks, and stash calls. The scheduler wraps the existing policy parser and adds serialized admission so two concurrent operations cannot both pass a preflight gate before either response updates rate-limit state.

The scheduler:

- reads every IP and account policy/state bucket returned by GGG;
- proactively waits when a bucket is full;
- honors `Retry-After` and active restrictions after a 429;
- permits only scheduler-admitted trade HTTP work;
- prioritizes live-listing detail fetches over optional startup seed work;
- exposes health and countdown snapshots to the UI;
- supports `AbortSignal` cancellation and bounded shutdown.

WebSocket connections remain independently staggered and reconnect with exponential backoff. They do not replace the scheduler for HTTP detail fetches.

The statuses distinguish proactive protection from an actual rejection. `COOLDOWN 4s` means Exilium is honoring a returned policy; `RATE LIMITED 60s` means a 429 or active restriction occurred. Total 429s remain observable for diagnostics.

## Errors and shutdown

Errors attach to the affected search or candidate and use concise UI text:

- an expired session shows `AUTH REQUIRED` with `run exilium setup`;
- a socket problem shows `RECONNECTING` and its countdown;
- a trade cooldown leaves the search selectable;
- unavailable Chrome marks only the travel action failed and leaves monitoring active;
- a gone listing is removed and the group is recalculated;
- invalid configuration remains editable in the overlay.

Detailed protocol or browser errors are retained in logs/details but never expanded into a table row. Chrome remains unnecessary for monitoring and is attached or opened only after Enter requests Travel to Hideout. No whisper is copied or sent.

Stop, `q`, Ctrl+C, and runtime restart abort queued and in-flight HTTP work, close sockets, cancel reconnect timers, and bound all controller cleanup. A stalled network or Chrome operation cannot hold the terminal open indefinitely.

## Verification

Automated tests must prove:

- five enabled searches produce five navigable rows when every listing is below the default 20 percent floor;
- `u` exposes hidden candidates without losing the selected search;
- tab 4 switches between PRICE ALERTS and SNIPES while preserving appropriate selection;
- `c` opens configuration, and enable/disable, edit, import, save-only, and save-and-start flows work;
- invalid imports remain in the overlay with actionable validation;
- catalog changes are shared with the existing snipe CLI commands;
- the standalone screen and main TUI render equivalent runtime snapshots;
- Enter travels the best candidate, while a gone candidate is removed and its replacement is not auto-traveled;
- dismissing a candidate followed by new ingestion does not resurrect it;
- queue eviction followed by new ingestion does not violate the configured bound;
- seed and live-detail HTTP work cannot overlap scheduler admission;
- live details take priority over pending startup seed work;
- IP/account buckets, proactive cooldowns, active restrictions, Retry-After, and 429 counters behave correctly;
- scheduler status and progress appear without writing disruptive console output;
- cancellation and shutdown finish within their configured timeout under stalled HTTP and Chrome operations;
- the complete Vitest suite and TypeScript build pass.
