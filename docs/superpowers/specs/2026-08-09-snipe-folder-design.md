# Snipe folder design — `exilium snipe`

Date: 2026-08-09. Status: implemented alongside this spec (autonomous session; owner
review requested post-hoc).

## Goal

Watch every trade search the user has saved in a **BetterTrading folder** at once,
enrich each new listing with a **profit margin** against poe.ninja's reference price
(kept under 10 minutes old), notify **immediately**, and offer a **ping-only** (default)
or **auto-travel** response to the trade site's own "Travel to Hideout" button.
League defaults to **Allflame**, the current challenge league.

## Context

Exilium already has: a single/multi URL live-search command (`exilium live`,
`src/trade/live-search.ts`) with websocket reconnects and the shared trade rate
limiter; poe.ninja ingestion into SQLite (`src/ingest`, `src/sources/ninja`);
`priceItem()` name matching over snapshots; a composite notifier (desktop +
Discord); and clipboard/open helpers. `snipe` composes these — no new
infrastructure.

Better Trading (exile-center/better-trading) exports a folder as `3:<base64 JSON>`:
`{icn, tit, ver, trs: [{tit, loc: "version:type:slug"}]}` (v2 same idea, older
payload). Slugs are trade-site search IDs and are league-portable: the league only
lives in the URL path, so saved searches can be re-pointed at Allflame.

## Approaches considered

1. **Browser-first**: Playwright drives pinned live-search tabs; scrape the DOM for
   new rows. Rejected as the core: fragile selectors, heavy, and worse latency than
   the official live websocket the site itself uses.
2. **Websocket engine + optional browser for the travel click (chosen)**: reuse the
   proven `live` websocket flow for detection across all folder searches, and use a
   browser only for the one thing that genuinely lives in the browser — the
   "Travel to Hideout" button.
3. **Reverse-engineered travel endpoint**: POSTing whatever the button calls.
   Rejected: undocumented, unverifiable here, and more likely to break or trip
   defenses than clicking the site's own button in a logged-in tab.

## Components (all new files under `src/snipe/`)

### `bettertrading.ts` — folder loader
- Folder resolution precedence: `--folder` flag → `EXILIUM_BETTERTRADING` env →
  `./BetterTrading` → `~/.exilium/BetterTrading`. First existing wins; if none
  exists, the CLI scaffolds `~/.exilium/BetterTrading/` with a commented sample.
- Reads files recursively (depth ≤ 3, hidden files skipped):
  - `.txt` / `.md` / `.bt`: every `pathofexile.com/trade(2)/search/...` URL becomes a
    target (label = trailing `| label` on the line, else file stem); any
    `2:...`/`3:...` Better Trading export string is base64-decoded into its trades.
  - `.json`: zod-validated `{ targets: [{ label, url | slug, realm?, league?,
    maxBuy?: {amount, currency}, minMarginPct?, note? }] }` (or a bare array).
- Malformed files are skipped with a logged warning, never fatal. Duplicate
  search IDs are deduped (first label wins).
- Output: `SnipeTarget { label, realm: 'trade'|'trade2', searchId, league: string|null,
  maxBuyChaos?, maxBuy?, minMarginPct? }`.

### `margin.ts` — pure pricing math
- `assessMargin(listing, snapshots, nowMs, opts)`:
  - Listing price → chaos via the freshest snapshot core rates
    (`amount / perPrimary[currency]`); unknown currency → margin unknown, never a
    guess.
  - Reference price: `priceItem(itemName, snapshots)` (exact-id/exact-name/substring,
    highest volume) — covers uniques (incl. Valdo's foil variants, which poe.ninja
    lists with `(Foil)`-style variant suffixes), currency, gems, maps. Rares have no
    aggregate price by design → `reference: null`.
  - Output: `MarginAssessment { listedChaos|null, referenceChaos|null, marginChaos|null,
    marginPct|null, referenceAsOf|null, freshness }` with `freshness` from
    `assessFreshness` (≤10 min = 'live').
- `passesMarginGate(assessment, minMarginPct|null)`: no threshold → pass; threshold
  with unknown margin → **pass but flagged** `unknownMargin` (a rare that can't be
  priced must still ping — sniping rares is the whole point for some filters);
  threshold with known margin → numeric compare.

### `engine.ts` — decision + alert assembly
- `decideSnipe(listing, target, assessment, config, seenIds)` → either
  `{ kind: 'alert', alert: SnipeAlert }` or `{ kind: 'suppressed', reason }`
  (duplicate id, over max buy, under margin).
- `SnipeAlert` carries label, item, listed price text, chaos equivalents, margin
  text ("+38c (+31%)" or "×3.1" style via existing format helpers), freshness label
  with an explicit `STALE >10m` marker, seller, whisper, search URL.
- `formatAlert(alert)` builds the one-line console record and the notification
  title/body. Pure, fully unit-tested.

### `travel.ts` — response dispatcher
- Modes: `ping` (default) and `auto`.
- **ping**: notifier (desktop + optional Discord webhook + optional sound), whisper
  copied to clipboard, `--open` also opens the search page so the listing's own
  "Travel to Hideout" button is one human click away.
- **auto**: requires BOTH the `--auto-travel` flag and
  `snipe.autoTravelAcknowledged: true` in `~/.exilium/config.json`. Uses Playwright
  (dynamic import; dev-installed, not a shipped dependency) with a persistent
  profile in `~/.exilium/browser-profile` (user logs into pathofexile.com once,
  headed). On an alert: open/reuse the search tab, wait for the row matching the
  listing id, click its "Travel to Hideout" button once, report success/failure.
  Any failure degrades to ping. One click per alert, never retried in a loop.
- Compliance note (also in README): auto mode performs a server action without a
  direct human click. That crosses the line GGG has drawn for tools and Exilium's
  own "never acts for you" rule — it exists strictly as an explicit, double-gated
  opt-in, off by default, at the user's own account risk. Ping mode is the
  recommended and default behavior.

## League handling

- Precedence: `--league` flag → `EXILIUM_LEAGUE`/config → current challenge league
  from the trade API's league list (today: **Allflame**) → literal `'Allflame'`
  fallback when offline.
- Every target's URL league is **rewritten** to the resolved league (search slugs are
  league-portable); `--keep-league` preserves per-URL leagues instead.

## Freshness (≤10 min reference prices)

- On startup and every `refreshSec` (floored at 300s), the CLI runs `ingestLeague`
  for the resolved league; the DB-refereed min-interval already dedupes across
  processes, and 300s cadence keeps references well inside the 10-minute window.
- Every alert carries the reference age; older than 10 minutes renders `STALE`.
  Ingest failure never blocks an alert — a snipe with a stale margin beats no snipe.

## CLI

```
exilium snipe [--folder <dir>] [--league <name>] [--keep-league]
              [--min-margin <pct>] [--mode ping|auto] [--auto-travel]
              [--open] [--sound]
```

- Sockets: staggered connects (500ms apart), cap 20 concurrent live searches
  (site-typical account cap) with a clear warning when the folder holds more;
  reuse of the shared trade rate limiter for fetch batches; same
  exponential-backoff reconnects as `live`.
- Every alert is appended to `~/.exilium/snipes.jsonl` (timestamp, target, item,
  price, margin, action taken) so missed toasts are reviewable.
- Config file: `snipe: { folder?, minMarginPct?, mode?, sound?, autoTravelAcknowledged? }`;
  env `EXILIUM_BETTERTRADING`, `EXILIUM_SNIPE_MIN_MARGIN`, `EXILIUM_SNIPE_MODE` win.

## Error handling

Folder/file errors: warn and continue. Session missing: fail fast with the same
guidance `live` gives. Websocket failures: backoff, give up per-search after 5
consecutive, keep others running. Ninja cooldowns: alerts still fire, margins
marked stale/unknown. Notifier/clipboard failures: logged, never fatal (existing
behavior).

## Testing

Unit (vitest, mirroring existing test style, all deps injected):
`bettertrading.test.ts` (v3/v2 decode, URL/label extraction, JSON schema, dedupe,
bad-file tolerance), `snipe-margin.test.ts` (currency conversion, unknown currency,
foil/variant names, gate semantics incl. unknown-margin pass-through, freshness
boundary at exactly 10 min), `snipe-engine.test.ts` (dedupe, max-buy, min-margin,
alert text, STALE marker), `snipe-travel.test.ts` (mode gating, double-gate for
auto, ping fallback on click failure — Playwright faked). CLI wiring follows the
pattern of `cmdLive`, which the suite intentionally leaves to integration use.

## Out of scope

TUI panel for snipes, PoE2 travel specifics beyond URL realm handling, auto-whisper
(never), price suggestions for rares, and any bulk/scripted travel.
