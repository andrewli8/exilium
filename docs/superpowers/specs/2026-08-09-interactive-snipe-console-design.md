# Interactive snipe console design

Date: 2026-08-09
Status: approved for implementation

## Goal

Turn `exilium snipe` into a Windows-first, human-triggered snipe console. At
startup the user chooses which searches from a Better Trading folder to enable
for that run. Qualifying live listings appear in a selectable CLI queue. The
user selects an alert and presses Enter; Exilium then uses one reusable,
logged-in Chrome tab to click the trade site's **Travel to Hideout** button for
that listing.

Exilium never sends a seller whisper. It does not travel merely because a
listing appeared. Every travel action corresponds to an explicit Enter keypress
on a selected alert.

## Product decisions

- Search selection is per run and is not remembered.
- Stable settings may be saved: Better Trading source path, league, margin
  threshold, Chrome executable/profile, and CDP endpoint.
- Path of Exile live-search WebSockets are the event source. Chrome desktop
  notifications are informational and are not scraped.
- The terminal interaction is keyboard-first because arrow keys, Space, number
  shortcuts, and Enter work consistently in Windows Terminal and PowerShell.
  Literal terminal mouse events are not required.
- One Exilium-owned Chrome tab is reused. Exilium does not open a tab per search
  or per listing.
- Ping mode remains available when Chrome is unavailable. A failed travel stays
  in the queue and reports its error; it is never silently treated as success.

## Better Trading inputs

The supported inputs are:

1. A BetterTrading directory containing `.txt`, `.bt`, `.md`, or `.json` files.
2. A `2:` or `3:` folder-export string copied from Better Trading, pasted into
   the startup import prompt or supplied to `exilium snipe import`.
3. A file containing one or more exports or ordinary Path of Exile trade URLs.

Better Trading's current Chrome extension stores folders in
`chrome.storage.local` and exposes folders as versioned Base64 export strings.
Exilium will not parse Chrome's LevelDB storage directly: it is an unstable
implementation detail, may be locked while Chrome runs, and would couple
Exilium to a browser profile and extension ID. Importing the extension's own
export string is the supported extension path.

An imported export is normalized and saved as a `.bt` source under the configured
BetterTrading directory, so it is available on later runs. Saving the source is
different from saving the enabled selection: each run still begins with the
multi-select.

## Startup interaction

`exilium snipe` performs these steps:

1. Resolve and load configured Better Trading sources.
2. If no searches exist, offer a paste/import prompt and retain the existing
   scaffold guidance as a non-interactive fallback.
3. Show all decoded searches in a multi-select screen. Arrow keys move, Space
   toggles, `a` selects all, number keys provide quick selection, Enter starts,
   and Escape cancels.
4. Resolve league and margin settings, refresh reference prices, and connect
   only the selected searches (up to the existing account-safe socket cap).
5. Enter the alert-queue screen.

When stdin is not an interactive TTY, the command does not hang waiting for
keys. It requires `--all` or explicit `--search <id>` flags, which also make the
flow scriptable and testable.

## Alert queue

The queue is an Ink UI consistent with the existing TUI stack. Each row shows:

- status (`NEW`, `TRAVELING`, `TRAVELED`, or `FAILED`);
- search label and item name;
- listed price and computed margin/freshness;
- seller and listing age.

Newest alerts appear first, but selection does not jump when a new alert
arrives. Arrow keys move selection. Enter dispatches travel for the selected
row. `r` retries a failed row, `d` dismisses it, and `q` exits. A bounded history
prevents an all-day session from growing memory without limit; every alert and
action also remains in `~/.exilium/snipes.jsonl`.

The existing desktop notification, optional sound, and structured webhook may
still fire. Clipboard copying of the whisper is removed from this console flow
because the user explicitly does not want whisper automation or a paste-based
workflow.

## Single-tab travel controller

The controller attaches over CDP to a dedicated Chrome launched by
`exilium chrome`. Windows Chrome discovery checks, in order:

1. `EXILIUM_CHROME` or the saved executable path;
2. `%PROGRAMFILES%\\Google\\Chrome\\Application\\chrome.exe`;
3. `%PROGRAMFILES(X86)%\\Google\\Chrome\\Application\\chrome.exe`;
4. `%LOCALAPPDATA%\\Google\\Chrome\\Application\\chrome.exe`;
5. Microsoft Edge equivalents as a Chromium fallback.

Chrome uses a dedicated profile under `%LOCALAPPDATA%\\Exilium\\chrome-profile`
by default. The user logs into `pathofexile.com` and clears any human challenge
once. Exilium does not inject a session cookie or bypass a challenge.

At attach time, the controller creates or claims one page and keeps it for the
session. For an Enter action it:

1. marks the row `TRAVELING` and serializes it behind any current action;
2. navigates the same page to the alert's search URL;
3. locates `.row[data-id="<listing id>"]`;
4. reloads once if the listing is still indexing;
5. clicks that row's `button.direct-btn` exactly once;
6. records `TRAVELED` only after the click resolves, otherwise records `FAILED`
   with a useful message.

Repeated Enter presses while a row is `TRAVELING` or `TRAVELED` do nothing.
The browser page is never closed per action. On shutdown Exilium closes only
its page and disconnects from CDP; the user's Chrome process remains running.

## Components and boundaries

### `selection.ts`

Pure selection state and key actions. It receives decoded targets and returns
the selected target IDs. Ink rendering is a thin adapter over this model.

### `queue.ts`

Pure alert-queue reducer with stable selection, bounded history, lifecycle
states, retry, and dismissal. It has no WebSocket or browser dependency.

### `console.tsx`

Ink screens for startup multi-select and the running queue. It receives events
and callbacks from the orchestration layer and contains no trade-site logic.

### `browser.ts`

Owns the one reusable Playwright page and exposes `travel(alert)`. It attaches
to user-launched Chrome first. A persistent Playwright launch may remain an
explicit fallback, but it must also use one page.

### `run.ts`

Loads inputs, obtains the selection, starts sockets, converts qualifying
listings to queue events, and dispatches selected rows to the travel controller.
It does not mutate UI state directly.

### `chrome.ts`

Builds Windows-aware launch commands and validates port/profile arguments.
Process-launch failure is awaited long enough to report a useful CLI error
instead of being lost after `unref()`.

## Configuration and CLI

Saved config fields:

```json
{
  "snipe": {
    "folder": "C:\\Users\\you\\Documents\\BetterTrading",
    "minMarginPct": 15,
    "league": "Current",
    "chromeCdpUrl": "http://127.0.0.1:9222",
    "chromePath": "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe",
    "chromeProfile": "C:\\Users\\you\\AppData\\Local\\Exilium\\chrome-profile"
  }
}
```

The existing global league remains a fallback; a snipe-specific league is
optional. No selected search IDs are written to config.

CLI additions:

```text
exilium snipe                         interactive multi-select + queue
exilium snipe --all                   enable all searches without selection UI
exilium snipe --search ID             enable one or more IDs/labels
exilium snipe import                  paste a Better Trading export
exilium snipe import --file FILE      import exports/URLs from a file
exilium chrome [--port N] [--profile DIR] [--print]
```

The existing immediate `--auto-travel` behavior is retired from the normal
interactive flow. A listing arriving is not sufficient authority to travel.
Compatibility parsing may print a migration message, but it must not silently
preserve immediate automatic travel.

## Error handling

- Invalid export: remain on import/select screen with the parse error; do not
  destroy an existing saved source.
- Missing POESESSID: fail before starting sockets with setup guidance.
- No selected searches: return to selection or exit cleanly.
- Socket failure: preserve the existing bounded reconnect behavior per search.
- Rate-limit or reference-price failure: keep alerts, mark price unknown/stale.
- CDP unavailable: queue continues in ping-only state and shows the command to
  run `exilium chrome`; Enter retries attachment before failing the row.
- Listing vanished or button missing: mark only that row failed; do not retry a
  click automatically.
- Terminal resize or non-Unicode Windows console: use the repository's existing
  ASCII-safe glyph policy and responsive truncation.
- Ctrl+C: close sockets, stop refresh timers, close the Exilium-owned page, and
  leave Chrome itself running.

## Testing and verification

Implementation follows test-first red/green cycles.

Unit tests cover:

- Better Trading v2/v3 paste and file import, persisted normalized source, and
  invalid-import safety;
- selection toggles, select-all, per-run reset, and non-TTY flag resolution;
- queue insertion without selection jumps, lifecycle transitions, deduplication,
  retry/dismiss, and history bounds;
- one-page reuse across multiple travel actions, exactly one click per action,
  duplicate Enter suppression, reload-on-index-lag, and failed-row behavior;
- Windows Chrome discovery across Program Files, Program Files (x86), Local App
  Data, override, and Edge fallback;
- shutdown closes the Exilium page but not the attached browser process.

Ink integration tests render both screens and exercise keyboard input. CLI
integration tests cover `--all`, repeated `--search`, import, invalid ports, and
non-TTY behavior. The full suite, TypeScript build, and `git diff --check` must
pass.

A Windows manual/e2e checklist verifies:

1. `exilium chrome` launches the dedicated profile and remains running after
   Exilium exits.
2. A Better Trading folder export can be pasted and appears in the multi-select.
3. Only searches selected for this run open WebSockets.
4. A real listing enters the queue without opening a new tab.
5. Enter on the listing reuses the one Exilium tab and causes one hideout travel.
6. No whisper is sent or copied, and no travel happens before Enter.
7. A second listing reuses the same tab.

## Out of scope

- Sending whispers or simulating in-game input.
- Traveling immediately on detection without a user keypress.
- Scraping Chrome/Windows desktop notifications.
- Parsing Chrome extension LevelDB storage directly.
- Multiple browser tabs for concurrent searches.
- Literal mouse-event support across every Windows terminal host.
