# Headless snipe detection design

Date: 2026-08-09
Status: approved through runtime diagnosis

## Goal

Make `exilium snipe` useful without Chrome: authenticate with the locally saved
POESESSID, seed the terminal queue from each selected saved trade search, and
continue receiving newly listed items through the trade site's live WebSocket.
Chrome remains an optional, lazy dependency used only after the user presses
Enter to click **Travel to Hideout**.

## Confirmed failure

The current command successfully opens all six live WebSockets, but it only
queues IDs contained in later `{ "new": [...] }` frames. It never asks the
saved-search endpoint for listings that existed before startup. It also tries
to attach to Chrome before opening sockets, producing a misleading CDP error
even though Chrome has no role in detection.

An authenticated read-only diagnostic against the user's Sublime Vision search
confirmed that `GET /api/trade/search/Allflame/9zRjda6KHK` returns its saved
query and that submitting that query returns 18 current result IDs. The trade
site reports an account search limit of three requests per five seconds.

## Runtime behavior

1. Resolve the selected Better Trading targets and POESESSID as today.
2. Render the queue and open every selected live WebSocket immediately.
3. In a rate-limited background task, load each saved query and execute it once.
4. Fetch details for at most the first ten current IDs per target and add
   qualifying listings to the queue without desktop-notification spam.
5. Continue treating WebSocket IDs as real-time arrivals; these do notify.
6. Deduplicate seed and live IDs per target. A failed detail fetch must not mark
   an ID permanently seen.
7. Do not create or attach a browser during startup. On Enter, lazily attach to
   the configured CDP endpoint and perform the existing manual travel action.

The seed scheduler observes all returned rate-limit headers. When the account
bucket fills it waits for the advertised window and retries; it never loops
through six saved searches at an unsafe fixed cadence. The live WebSocket stays
the primary event source. A periodic polling fallback is out of scope for this
repair because the internal trade endpoints are undocumented and unnecessary
traffic increases restriction risk.

## API boundary

`src/trade/live-search.ts` owns the saved-query and search-result wire formats.
It exposes one operation that returns current result IDs and uses the existing
process-wide `TradeRateLimiter`. `src/snipe/run.ts` owns orchestration, quiet
queue seeding, notification policy, deduplication, cancellation, and lazy
browser creation.

The POESESSID is read from the existing 0600 config file or environment and is
sent only to `pathofexile.com`. It is never printed, logged, persisted in the
snipe folder, or passed to Chrome.

## User-visible output

Startup explicitly distinguishes detection from browser control:

```text
Exilium snipe — 6 enabled searches · league Allflame · min margin off
Monitoring is headless. Current results seed quietly; new live hits notify.
Chrome is only needed after you press Enter to travel.
```

Each successful seed logs only its count, for example `seeded 10 current
listings for valdos · sublime vision`. A seed failure names the search and says
that its live WebSocket remains active. CDP errors appear only after Enter.

## Tests

- URL and response-schema tests for saved-query lookup and result search.
- Rate-limit observation and authentication-error tests for both requests.
- Orchestration test proving sockets start without constructing Chrome.
- Orchestration test proving seed results enter the queue quietly and live
  results notify.
- Deduplication test for an ID present in both seed and WebSocket paths.
- Failure test proving a rejected fetch does not permanently lose a later ID.
- Shutdown test proving seed work is aborted and cannot enqueue afterward.
- Full Vitest suite, TypeScript build, and `git diff --check`.

## Out of scope

- Automatic whispers or any in-game input.
- Automatic travel when an item arrives.
- One Chrome tab per selected search.
- Continuous high-frequency HTTP polling.
- Bypassing Cloudflare or injecting POESESSID into a browser.
- The separate `snipe add/list/edit/remove` catalog work.
