# Compact Snipe Candidate Board Design

> Superseded in one respect by [Watches Snipe Workspace Design](./2026-08-09-watches-snipe-workspace-design.md): enabled searches now remain as navigable `NO MATCH` rows when every listing is below the floor, instead of producing an empty board.

## Goal

Replace the unbounded, verbose listing feed with a compact Better Trading candidate board that surfaces only actionable profit opportunities, supports drill-down and stale-listing removal, and travels through the user's native Chrome trade page without Playwright browser-context attachment failures.

## Candidate board

The primary view has one row per enabled Better Trading search. A row shows the search target, its best qualifying listing price, profit percentage, listing age, and the count of additional qualifying listings.

```text
 EXILIUM SNIPES                         ● 6 LIVE
 Floor +20%     Sort PROFIT ↓ / RECENCY     3 candidates

   TARGET             BEST PRICE    PROFIT    LISTED   MORE
 › Mageblood                 35d     +30.1%       13m     +2
   Sublime Vision            72d     +24.6%        8s     +4
   Nimis                     58d     +21.3%       42s     +1

  3 shown · 28 below floor · 2 unknown
  ↑↓ select   Enter travel   Shift+Enter inspect   f floor   u hidden
```

The effective default minimum margin is 20 percent when neither a CLI flag nor user configuration supplies a value. Explicit user configuration continues to win. Listings with an unknown margin or a known margin below the effective floor are hidden from the primary board but counted. When no listing qualifies, the board remains empty and reports the hidden counts; it does not promote a near miss.

Within each search, listings sort by margin percentage descending and listing time descending. Search groups sort by their best listing using the same keys. The selection remains attached to a search target as listings arrive or disappear.

Startup API results carry a `current` source and render quietly. WebSocket results carry a `live` source and count as genuinely new activity. The board must not describe every startup result as `NEW`.

## Navigation and travel

- Up and Down select a Better Trading search on the candidate board.
- Enter revalidates and travels to the selected search's current best listing.
- Shift+Enter opens a detail view containing the Valdo listings for that Better Trading search.
- In detail view, Up and Down select a listing and Enter revalidates and travels to that listing.
- Tab moves forward between views, Shift+Tab returns to the previous view, and Escape returns directly to the candidate board.
- The detail view uses the same profit-then-recency ordering and shows the listing's Valdo map name, price, margin, and age.
- `u` toggles the below-floor and unknown listings without changing the configured floor.
- `f` provides access to changing the session floor.

Before browser interaction, the runtime checks whether the listing still exists in the trade search results. If it is gone, the result is `gone`; the queue removes it, recalculates the target's best candidate and counts, and shows a one-line notice. Exilium never automatically travels to the replacement candidate; the user must press Enter again after seeing the updated board.

A successful Travel to Hideout action marks the listing traveled and removes it from the active candidate count. A failed Chrome action leaves the candidate available for a retry.

## Status, color, and errors

The interface uses color as a supplement to explicit words and symbols:

- bright green for qualifying profit and successful travel;
- cyan for live connections and new activity;
- amber for rate limiting, stale data, unknown reference prices, or Chrome being needed;
- red only for a failed user action;
- dim gray for current snapshot results and supporting counts.

A stable one-line notification region reports sold-listing removal, travel success, connection changes, and short failures without pushing board rows around. Browser failures are summarized, for example `Chrome unavailable — run exilium chrome, then press Enter again`. Raw protocol traces never render inside a queue row. Full error details are logged and available through the `?` help/details action.

The header reports the count of live searches and Chrome's on-demand state. Chrome remains unnecessary for monitoring.

## Chrome transport

The watcher remains headless: authenticated HTTP requests seed current results and WebSockets deliver live IDs. Chrome starts or attaches only after an explicit Enter action.

Travel uses the dedicated Chrome instance launched by `exilium chrome` and operates a native pathofexile.com trade tab. The CDP adapter talks directly to the browser/page targets needed for navigation, DOM lookup, reload, and click. It does not call Playwright's `connectOverCDP`, create a Playwright browser context, send `Browser.setDownloadBehavior`, copy a whisper, or send a whisper.

The adapter owns and reuses one trade page, serializes travel attempts, retries one reload for indexing lag, and closes only its own page/session when Exilium exits. It must not terminate the user's Chrome process. Timeouts and controller shutdown remain bounded so a stalled page cannot hang `q` or Ctrl+C.

## Data and state boundaries

`SnipeAlert` gains immutable source/search identity needed by the UI: a stable target key and `current | live` source. Queue state remains bounded and deduplicated by listing ID. A pure candidate-board projection groups queue entries, applies visibility rules, sorts candidates, calculates hidden counts, and resolves stable target/listing selection. Rendering consumes that projection rather than duplicating business rules.

Travel results distinguish `traveled`, `gone`, and `failed`. The queue reducer owns removal and selection repair after `gone`, preserving dismissed IDs and the existing bounded-ingestion guarantees.

## Verification

Automated coverage must prove:

- the default floor is 20 percent and explicit overrides win;
- unknown and below-floor entries are hidden and counted;
- groups and listings sort by profit then listing recency;
- initial results are current and socket results are live;
- Enter selects the current best listing;
- Shift+Enter, Tab, Shift+Tab, and Escape navigate without losing selection;
- a gone listing is removed, the group recalculates, and no replacement auto-travels;
- a successful listing leaves the active candidates;
- long browser errors are reduced to stable one-line UI messages while full details remain recordable;
- the direct CDP adapter navigates, finds, reloads, clicks, serializes, times out, and disconnects without closing Chrome;
- dismissal plus later ingestion and the 200-entry bound do not resurrect old rows;
- full Vitest and TypeScript build suites pass.
