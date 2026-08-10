# Compact Snipe Candidate Board Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build the approved grouped +20% snipe candidate board, stale-listing removal and detail navigation, and a direct-CDP native Chrome travel path.

**Architecture:** Preserve the existing headless HTTP/WebSocket watcher, but enqueue every price-assessed listing that passes duplicate/max-buy checks so the UI can count and optionally reveal below-floor and unknown candidates. Add a pure board projection over the bounded queue, keep navigation in the queue reducer, and replace Playwright's browser-level CDP attachment with a small page-target CDP client that only navigates, evaluates the native trade DOM, reloads, clicks, and closes its owned tab.

**Tech Stack:** TypeScript, React, Ink, Vitest, `ws`, Chrome DevTools Protocol, existing Exilium trade and margin modules.

## Global Constraints

- Monitoring remains headless; Chrome is touched only after explicit Enter.
- The effective default minimum margin is exactly 20 percent; an explicit CLI/configured numeric floor wins.
- Unknown and below-floor listings are hidden from the board by default but retained for counts and the `u` toggle.
- Travel never sends or copies a whisper and only clicks the native `Travel to Hideout` button.
- A gone listing is removed and recalculated but its replacement is never auto-traveled.
- Raw Chrome/CDP traces never render in candidate rows.
- Queue history remains deduplicated and bounded to 200 entries without resurrecting dismissed or evicted listings.
- `q` and Ctrl+C remain bounded even when Chrome or a network action stalls.

---

### Task 1: Candidate metadata and default profit floor

**Files:**
- Modify: `src/config.ts`
- Modify: `src/snipe/engine.ts`
- Modify: `src/snipe/run.ts`
- Modify: `tests/snipe-config.test.ts`
- Modify: `tests/snipe-engine.test.ts`
- Modify: `tests/snipe-run.test.ts`

**Interfaces:**
- Produces: `type SnipeAlertSource = 'current' | 'live'`.
- Produces on `SnipeAlert`: `targetId: string`, `source: SnipeAlertSource`, `minMarginPct: number`, and `qualifiesMargin: boolean`.
- Changes `DecideSnipeOptions` to consume `source` and a non-null effective `globalMinMarginPct`.
- Preserves `SnipeDecision` suppression for duplicates and max-buy only; assessed below-floor and unknown listings return alerts with `qualifiesMargin: false`.

- [ ] **Step 1: Write failing config and decision tests**

Add assertions that an empty config resolves `snipe.minMarginPct` to `20`, an explicit `15` remains `15`, known `25%` produces `qualifiesMargin: true`, known `10%` produces an alert with `qualifiesMargin: false`, and unknown margin produces an alert with `qualifiesMargin: false`. Assert `targetId` is `${realm}:${searchId}` and the requested source is preserved.

- [ ] **Step 2: Run the focused tests and verify RED**

Run: `npx vitest run tests/snipe-config.test.ts tests/snipe-engine.test.ts`

Expected: FAIL because the default is null, alert metadata is absent, and below-floor decisions are suppressed.

- [ ] **Step 3: Implement metadata and qualification**

Set the loaded default floor to `20`. In `decideSnipe`, calculate the effective target/global threshold, construct alerts for all assessed listings not rejected by duplicate/max-buy checks, and store qualification instead of suppressing below-floor/unknown entries. Keep margin formatting unchanged.

- [ ] **Step 4: Write failing orchestration tests for current/live and quiet filtering**

Assert seed alerts carry `source: 'current'`, socket alerts carry `source: 'live'`, both enter the console even when below the floor, and only qualifying live alerts invoke desktop notification/sound/webhook alert behavior.

- [ ] **Step 5: Run the orchestration test and verify RED**

Run: `npx vitest run tests/snipe-run.test.ts`

Expected: FAIL because `processIds` does not pass source metadata and currently drops failed margin gates.

- [ ] **Step 6: Implement source propagation and notification gating**

Pass `seed` as `current` and WebSocket work as `live` into `decideSnipe`. Always call `consoleHandle.addAlert` for returned alerts, but notify, sound, and live webhook only when `source === 'live' && alert.qualifiesMargin`.

- [ ] **Step 7: Run focused tests and commit**

Run: `npx vitest run tests/snipe-config.test.ts tests/snipe-engine.test.ts tests/snipe-run.test.ts`

Expected: PASS.

Commit: `feat: add snipe candidate qualification metadata`

---

### Task 2: Pure grouped candidate-board state

**Files:**
- Create: `src/snipe/board.ts`
- Modify: `src/snipe/queue.ts`
- Create: `tests/snipe-board.test.ts`
- Modify: `tests/snipe-queue.test.ts`

**Interfaces:**
- Produces: `projectCandidateBoard(state, { showHidden }): CandidateBoard`.
- `CandidateBoard` contains `groups`, `qualifyingCount`, `belowFloorCount`, and `unknownCount`.
- `CandidateGroup` contains `targetId`, `targetLabel`, sorted `entries`, `best`, and `moreCount`.
- Extends queue state with `view: 'board' | 'detail'`, `selectedTargetId`, `selectedListingId`, `showHidden`, and stable `notice`.
- Adds reducer actions `open-detail`, `next-view`, `previous-view`, `board`, `toggle-hidden`, `remove-gone`, and `clear-traveled`.

- [ ] **Step 1: Write failing projection tests**

Cover one group per `targetId`, hidden unknown/below-floor counts, no near-miss group when nothing qualifies, group ordering by best margin then `listedAt`, listing ordering by margin then `listedAt`, and `moreCount` for additional visible entries.

- [ ] **Step 2: Run the projection tests and verify RED**

Run: `npx vitest run tests/snipe-board.test.ts`

Expected: FAIL because `board.ts` and `projectCandidateBoard` do not exist.

- [ ] **Step 3: Implement the pure board projection**

Classify unknown before below-floor, apply `showHidden`, sort with null timestamps last, build groups by stable target identity, and return immutable arrays/counts. Do not mutate queue order.

- [ ] **Step 4: Write failing reducer tests**

Cover stable target selection as a better listing arrives, detail listing selection, Tab/Shift+Tab/Escape transitions, `remove-gone` choosing the next entry without selecting/traveling it, successful travel removal, dismissal followed by a new alert, and more than 200 ingestions without resurrecting old IDs.

- [ ] **Step 5: Run reducer tests and verify RED**

Run: `npx vitest run tests/snipe-queue.test.ts`

Expected: FAIL because grouped selection, views, hidden state, and gone/traveled removal actions are absent.

- [ ] **Step 6: Implement reducer state and transitions**

Keep the listing-ID ingestion ledger in the component, retain the reducer's 200-entry bound, and repair target/listing selection deterministically after removal. `remove-gone` sets `notice` to `<target>: listing sold or removed — queue updated`; successful removal sets a concise success notice.

- [ ] **Step 7: Run focused tests and commit**

Run: `npx vitest run tests/snipe-board.test.ts tests/snipe-queue.test.ts`

Expected: PASS.

Commit: `feat: group snipe candidates by Better Trading search`

---

### Task 3: Compact colored Ink board and keyboard navigation

**Files:**
- Modify: `src/snipe/console.tsx`
- Modify: `tests/snipe-console.test.tsx`

**Interfaces:**
- `SnipeQueueAppProps` gains `searchCount?: number` and `minMarginPct?: number` for the compact header.
- Enter resolves `CandidateGroup.best` on board view and the selected listing on detail view.
- Travel handling consumes `TravelResult.action` values `traveled | gone | failed`.

- [ ] **Step 1: Write failing rendering tests**

Assert the board renders the compact header, one row per target, best price/profit/age/MORE, hidden counts, and an empty `0 candidates` state without item-feed rows. Assert seeded current data is not labeled NEW and long error details are absent from rows.

- [ ] **Step 2: Run rendering tests and verify RED**

Run: `npx vitest run tests/snipe-console.test.tsx`

Expected: FAIL against the current ungrouped verbose feed.

- [ ] **Step 3: Implement board and detail rendering**

Render fixed columns through small formatting helpers and `fold`, applying Ink `green`, `cyan`, `yellow`, `red`, and `dimColor` semantically while retaining symbols/words. Render exactly one stable notification line and a concise help footer. The detail view renders only the selected target's Valdo names, prices, profits, and listing ages.

- [ ] **Step 4: Write failing input and async-result tests**

Using Ink's stdin harness, prove Up/Down target selection, Enter calls `onTravel` with the best candidate, Shift+Enter opens detail, Tab/Shift+Tab/Escape change views, detail Enter travels the chosen listing, `u` reveals hidden rows, gone removes/recalculates without a second travel call, and traveled removes the active candidate.

- [ ] **Step 5: Run input tests and verify RED**

Run: `npx vitest run tests/snipe-console.test.tsx`

Expected: FAIL because the current component selects raw listings and treats all non-success results as persistent failures.

- [ ] **Step 6: Implement input and result dispatch**

Resolve the board projection inside render/input from reducer state. Check shifted Return before plain Return, accept Tab and shifted Tab, map Escape to board, and dispatch `remove-gone`, `clear-traveled`, or short `travel-failure` based on the action. Keep full caught errors in the logger/result recorder, not `rowText`.

- [ ] **Step 7: Run focused tests and commit**

Run: `npx vitest run tests/snipe-console.test.tsx tests/snipe-board.test.ts tests/snipe-queue.test.ts`

Expected: PASS.

Commit: `feat: add compact interactive snipe candidate board`

---

### Task 4: Direct Chrome page-target CDP travel

**Files:**
- Create: `src/snipe/cdp.ts`
- Modify: `src/snipe/browser.ts`
- Modify: `src/snipe/travel.ts`
- Create: `tests/snipe-cdp.test.ts`
- Modify: `tests/snipe-browser.test.ts`
- Modify: `tests/snipe-travel.test.ts`

**Interfaces:**
- Produces: `createCdpPage({ cdpUrl, fetchFn, openSocket, timeoutMs, log }): Promise<TravelPage & { close(): Promise<void> }>`.
- CDP transport exposes bounded `send(method, params)` and event waiting over one page-target WebSocket.
- `TravelResult` becomes `{ action: 'traveled' | 'gone' | 'failed'; detail: string; technicalDetail?: string }`.
- `createTravelController` no longer imports or accepts Playwright; its injectable seam becomes `createPage?: typeof createCdpPage`.

- [ ] **Step 1: Write failing CDP transport tests**

Use a fake HTTP endpoint/socket to assert `PUT /json/new?about%3Ablank`, `Page.enable`, `Runtime.enable`, bounded command IDs, native navigation, DOM evaluation, one reload retry, `Page.close`, command timeout, and rejection of pending commands on disconnect.

- [ ] **Step 2: Run CDP tests and verify RED**

Run: `npx vitest run tests/snipe-cdp.test.ts`

Expected: FAIL because the direct CDP module does not exist.

- [ ] **Step 3: Implement the minimal direct CDP page adapter**

Create the owned target through Chrome's `/json/new` endpoint, connect with `ws`, and implement JSON-RPC correlation. `goto` sends `Page.navigate` and waits within the shared timeout. `clickTravelButton` evaluates a self-contained browser expression that finds `[data-id=<listingId>]`, finds `button.direct-btn` or a button whose text is `Travel to Hideout`, calls `.click()`, and returns a boolean; retry once after `Page.reload`. `close` rejects pending work and sends/closes only the owned page target.

- [ ] **Step 4: Write failing travel/controller tests**

Assert missing row/button returns `action: 'gone'`; a thrown CDP error returns `failed` with a short user detail and separate technical detail; sequential travels serialize; close interrupts a stalled action; and neither creation nor close invokes Playwright/browser-context APIs or terminates Chrome.

- [ ] **Step 5: Run travel tests and verify RED**

Run: `npx vitest run tests/snipe-travel.test.ts tests/snipe-browser.test.ts`

Expected: FAIL because missing rows currently return generic failed and browser control still calls `connectOverCDP`.

- [ ] **Step 6: Replace the Playwright adapter**

Make `browser.ts` a thin serialized controller over `createCdpPage`. Preserve lazy creation in `run.ts`, reuse one owned trade tab, and ensure controller close bypasses the action tail. Map endpoint/connect errors to `Chrome unavailable — run exilium chrome, then press Enter again`, retaining the original message as `technicalDetail` for JSONL/logging and `?` details.

- [ ] **Step 7: Run focused tests and commit**

Run: `npx vitest run tests/snipe-cdp.test.ts tests/snipe-browser.test.ts tests/snipe-travel.test.ts`

Expected: PASS.

Commit: `fix: travel through direct Chrome CDP page control`

---

### Task 5: Orchestration wiring, shutdown, and regression verification

**Files:**
- Modify: `src/snipe/run.ts`
- Modify: `tests/snipe-run.test.ts`
- Modify: `docs/STATUS.md` if it contains the current snipe capability summary

**Interfaces:**
- Passes `searchCount` and effective `minMarginPct` into `renderSnipeConsole`.
- Records user-facing `detail` and full `technicalDetail` separately in logs/JSONL.
- All pending listing fetches, refresh tasks, and controller actions are aborted or bounded by `shutdownTimeoutMs`.

- [ ] **Step 1: Write failing orchestration regressions**

Assert the console receives the 20% floor/search count, gone results are recordable without Chrome retry guidance, CDP failures use the short guidance while preserving technical diagnostics, shutdown completes when fetch/navigation promises never settle, and no alert/notification is enqueued after stop.

- [ ] **Step 2: Run orchestration tests and verify RED**

Run: `npx vitest run tests/snipe-run.test.ts`

Expected: FAIL where current error strings include raw Playwright traces and cleanup awaits unbounded work.

- [ ] **Step 3: Implement orchestration and bounded cleanup**

Wire compact-console metadata, propagate three-way travel results, log `technicalDetail` outside the UI, abort network work before closing sockets, race remaining work/controller close against the configured shutdown timeout, and guard all post-fetch enqueue/notify paths with stop state.

- [ ] **Step 4: Run the complete snipe suite**

Run: `npx vitest run tests/snipe-*.test.ts tests/snipe-console.test.tsx`

Expected: PASS with no unhandled rejection warnings.

- [ ] **Step 5: Run full repository verification**

Run: `npm test`

Expected: every Vitest file and test passes.

Run: `npm run build`

Expected: TypeScript compilation succeeds with no errors.

Run: `git diff --check`

Expected: no whitespace errors.

- [ ] **Step 6: Perform a requirement audit and commit**

Compare the rendered/tested behavior to `docs/superpowers/specs/2026-08-09-compact-snipe-candidate-board-design.md`, checking every keyboard shortcut, hidden-count rule, gone transition, color/error rule, Chrome lifecycle constraint, queue bound, and shutdown guarantee against source plus tests.

Commit: `feat: finish compact snipe candidate workflow`
