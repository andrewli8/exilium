# Headless Snipe Detection Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Seed and update the Exilium snipe queue from authenticated trade requests and live WebSockets without opening Chrome until the user presses Enter.

**Architecture:** Put saved-query HTTP parsing in `trade/live-search.ts` beside the existing listing fetch code. Let `snipe/run.ts` start sockets immediately, run cancellable rate-limited seed tasks in the background, share per-target dedupe across seed/live paths, and instantiate the existing travel controller only from `onTravel`.

**Tech Stack:** TypeScript 7, Node.js 20+, `ws` 8, Zod 4, Ink 7, Vitest 4.

## Global Constraints

- POESESSID is sent only to `pathofexile.com` and must never be printed or persisted in snipe data.
- WebSockets remain the primary real-time source; HTTP performs one startup seed per selected search.
- Observe the trade site's dynamic rate-limit headers through the process-wide limiter and retry only after its advertised cooldown.
- Seed at most ten current IDs per selected search and do not desktop-notify those pre-existing listings.
- New WebSocket listings continue to queue, notify, sound, log, and emit the configured webhook.
- Chrome/CDP must not be touched before the user presses Enter on a queue row.
- A listing arrival never authorizes travel, whispering, clipboard writes, or in-game input.
- Every production change follows a witnessed RED to GREEN test cycle.

---

### Task 1: Saved-search result lookup

**Files:**
- Modify: `src/trade/live-search.ts`
- Modify: `tests/live-search.test.ts`

**Interfaces:**
- Consumes: `TradeSearch`, POESESSID, `fetchFn`, `TradeRateLimiter`, optional `AbortSignal`.
- Produces: `fetchCurrentResultIds(search, sessionId, deps): Promise<readonly string[]>`.

- [ ] **Step 1: Write failing URL, success, auth, malformed-response, and rate-limit tests**

Assert that PoE1 uses `/api/trade/search/<league>/<id>` then POSTs the returned query to `/api/trade/search/<league>` as `{ query, sort: { indexed: "desc" } }`; PoE2 uses the equivalent `trade2` path. Assert result IDs are returned, 401/403 mention POESESSID, 429 throws `RateLimitError`, and both responses reach the limiter.

- [ ] **Step 2: Run `npx vitest run tests/live-search.test.ts` and witness RED**

Expected: import/type failure because `fetchCurrentResultIds` does not exist.

- [ ] **Step 3: Implement the minimal validated two-request operation**

Add Zod schemas for `{ query: object }` and `{ result: string[] }`. Call `limiter.gate()` immediately before each request and `limiter.observe(response)` immediately after. Use the same Cookie/User-Agent headers as `fetchListings`, pass the optional signal, and centralize 401/403/429 messages rather than duplicating secret-bearing values.

- [ ] **Step 4: Run `npx vitest run tests/live-search.test.ts` and witness GREEN**

- [ ] **Step 5: Commit**

```bash
git add src/trade/live-search.ts tests/live-search.test.ts
git commit -m "feat: resolve current snipe search results"
```

### Task 2: Headless startup and quiet queue seeding

**Files:**
- Modify: `src/snipe/run.ts`
- Modify: `tests/snipe-run.test.ts`

**Interfaces:**
- Consumes: `fetchCurrentResultIds`, existing `fetchListings`, `SnipeConsoleHandle`, `TravelController`.
- Produces: socket-first startup, quiet seed alerts, live alert notifications, per-target dedupe, lazy `ensureController()`.

- [ ] **Step 1: Write a failing test proving startup never creates Chrome**

Start `runSnipe`, wait for the fake socket open, and assert `makeTravelController` has zero calls. Invoke `consoleOptions.onTravel`, then assert it is created once.

- [ ] **Step 2: Run `npx vitest run tests/snipe-run.test.ts` and witness RED**

Expected: controller is created during the existing initial browser-open block.

- [ ] **Step 3: Remove eager browser creation and change startup copy**

Delete `initialBrowserOpen` and `buildSearchPageUrl` usage from `run.ts`. Start refresh and sockets immediately after printing that monitoring is headless and Chrome is only required on Enter. Retain `ensureController` solely inside `onTravel`.

- [ ] **Step 4: Run the focused test and witness GREEN**

- [ ] **Step 5: Write failing seed/live policy tests**

Inject `fetchCurrentResultIds`. Assert up to ten seed IDs are fetched and queued without `notify`; then emit a different WebSocket ID and assert it queues and notifies. Emit the same ID through both paths and assert one queue entry. Reject the first detail fetch, emit the ID again, and assert the second attempt queues it.

- [ ] **Step 6: Implement a shared per-target listing pipeline**

Maintain `seen` and `inFlight` sets for each runnable target. One `processIds(ids, source)` function filters both, fetches details, runs margin decisions, queues alerts, and marks IDs seen only after a successful fetch. `source === "live"` performs notification/sound and records `queued`; `source === "seed"` records `seeded` without notification.

- [ ] **Step 7: Implement cancellable, rate-limit-aware seeds**

Start one background seed sequence after sockets. For every target, call `fetchCurrentResultIds`; on `RateLimitError`, wait its `retryAfterSec` using an abortable timer and retry that target. Abort and suppress enqueue during shutdown. Log the number seeded or a target-specific failure while noting that live monitoring continues.

- [ ] **Step 8: Run `npx vitest run tests/snipe-run.test.ts tests/live-search.test.ts` and witness GREEN**

- [ ] **Step 9: Commit**

```bash
git add src/snipe/run.ts tests/snipe-run.test.ts
git commit -m "fix: seed snipes without opening Chrome"
```

### Task 3: User guidance and regression verification

**Files:**
- Modify: `README.md`
- Modify: `examples/06-snipe-folder.md`
- Modify: `tests/cli-integration.test.ts`

**Interfaces:**
- Consumes: final `exilium snipe` runtime behavior.
- Produces: accurate CLI/docs contract for headless detection and lazy travel.

- [ ] **Step 1: Add a failing CLI assertion for headless startup copy**

Run the non-interactive command with one fixture target and injected/controlled termination, or factor the startup copy into an exported formatter if process-level socket control would make the test flaky. Assert the output says Chrome is only needed on Enter and never attempts CDP at startup.

- [ ] **Step 2: Run the focused integration test and witness RED**

- [ ] **Step 3: Update README and example commands**

Document that imported searches seed up to ten current results quietly, live arrivals notify, multiple searches use no tabs, and `exilium chrome` is necessary only for Enter-triggered travel. State that the internal trade endpoints are not part of the official supported API and rate-limit headers are always honored.

- [ ] **Step 4: Run focused tests, full tests, build, and whitespace verification**

```bash
npx vitest run tests/live-search.test.ts tests/snipe-run.test.ts tests/cli-integration.test.ts
npm test
npm run build
git diff --check
```

Expected: every command exits 0.

- [ ] **Step 5: Commit**

```bash
git add README.md examples/06-snipe-folder.md tests/cli-integration.test.ts
git commit -m "docs: explain headless snipe monitoring"
```
