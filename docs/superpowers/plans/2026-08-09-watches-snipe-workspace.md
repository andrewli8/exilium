# Watches Snipe Workspace Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a navigable, configurable SNIPES view to tab 4 of the main Exilium TUI, backed by the same headless runtime as `exilium snipe` and a serialized trade-API scheduler.

**Architecture:** A process-wide scheduler serializes admission to every trade HTTP request and publishes cooldown health. A renderer-independent `SnipeStore` owns enabled-search rows, queue state, runtime progress, and subscriptions; the existing runtime publishes into it. Reusable Ink components render the store in standalone and embedded modes, while a focused overlay edits the existing Better Trading catalog.

**Tech Stack:** TypeScript 7, Node.js 20+, React 19, Ink 7, Vitest 4, Zod, WebSocket (`ws`).

## Global Constraints

- The SNIPES board always renders one navigable row per enabled search, including searches with no qualifying candidate.
- The default session profit floor is 20 percent unless CLI or per-search configuration overrides it.
- Opening the main TUI must not start new monitoring; Enter in configuration explicitly starts selected searches.
- Chrome is used only after explicit Travel to Hideout and no whisper is copied or sent.
- All trade HTTP paths share serialized admission and honor IP/account buckets, active restrictions, and `Retry-After`.
- Live-detail work has priority over startup seeding.
- Runtime stop and restart must abort queued work and finish within the configured timeout.
- Existing `exilium snipe` catalog commands remain the single source of truth.

---

### Task 1: Serialized Trade Request Scheduler

**Files:**
- Create: `src/trade/request-scheduler.ts`
- Modify: `src/trade/rate-limit.ts`
- Modify: `src/trade/live-search.ts`
- Modify: `src/trade/price-check.ts`
- Modify: `src/trade/stash.ts`
- Test: `tests/trade-request-scheduler.test.ts`
- Test: `tests/trade-rate-limit.test.ts`

**Interfaces:**
- Produces: `TradeRequestScheduler.schedule<T>(priority, operation, signal?)`, `health()`, `subscribe(listener)` and `sharedTradeRequestScheduler`.
- Consumes: existing `TradeRateLimiter.gate()`, `observe()`, and `health()`.

- [ ] **Step 1: Write failing scheduler tests**

```ts
test('serializes admission and execution', async () => {
  const scheduler = new TradeRequestScheduler(new TradeRateLimiter(), async () => undefined);
  let active = 0;
  let maxActive = 0;
  const work = () => scheduler.schedule('seed', async () => {
    active += 1;
    maxActive = Math.max(maxActive, active);
    await Promise.resolve();
    active -= 1;
    return new Response('{}');
  });
  await Promise.all([work(), work()]);
  expect(maxActive).toBe(1);
});

test('runs queued live work before queued seed work', async () => {
  const order: string[] = [];
  const first = deferred<void>();
  const scheduler = new TradeRequestScheduler(new TradeRateLimiter(), async () => undefined);
  const running = scheduler.schedule('seed', async () => { await first.promise; order.push('first'); return new Response('{}'); });
  const seed = scheduler.schedule('seed', async () => { order.push('seed'); return new Response('{}'); });
  const live = scheduler.schedule('live', async () => { order.push('live'); return new Response('{}'); });
  first.resolve();
  await Promise.all([running, seed, live]);
  expect(order).toEqual(['first', 'live', 'seed']);
});

test('cancels queued work without invoking it', async () => {
  const controller = new AbortController();
  const operation = vi.fn(async () => new Response('{}'));
  controller.abort();
  await expect(scheduler.schedule('seed', operation, controller.signal)).rejects.toMatchObject({ name: 'AbortError' });
  expect(operation).not.toHaveBeenCalled();
});
```

- [ ] **Step 2: Run the new tests and confirm they fail**

Run: `npx vitest run tests/trade-request-scheduler.test.ts tests/trade-rate-limit.test.ts`

Expected: FAIL because `TradeRequestScheduler` does not exist.

- [ ] **Step 3: Implement priority serialization and health publication**

```ts
export type TradeRequestPriority = 'live' | 'interactive' | 'seed';
export interface TradeSchedulerHealth extends RateLimitHealth {
  readonly state: 'ready' | 'cooldown' | 'rate-limited';
  readonly queued: number;
}

export class TradeRequestScheduler {
  schedule<T>(
    priority: TradeRequestPriority,
    operation: () => Promise<{ readonly status: number; readonly headers: Headers } & T>,
    signal?: AbortSignal,
  ): Promise<T>;
  health(): TradeSchedulerHealth;
  subscribe(listener: (health: TradeSchedulerHealth) => void): () => void;
}
```

Use one active operation, FIFO within priority, and priority order `live`, `interactive`, `seed`. Before invoking an operation, call `limiter.gate()`. On `RateLimitError`, publish cooldown, wait with an abortable timer, and retry admission without invoking the operation. After a response, call `limiter.observe(response)`, record whether status 429 caused the cooldown, publish health, and resolve the response to the caller.

- [ ] **Step 4: Route all trade HTTP operations through the shared scheduler**

Replace direct `limiter.gate()` / `fetchFn()` / `limiter.observe()` triplets with:

```ts
const response = await (deps.scheduler ?? sharedTradeRequestScheduler).schedule(
  priority,
  () => deps.fetchFn(url, init),
  deps.signal,
);
```

Use `seed` for saved-query reads and startup search submissions, `live` for listing details, and `interactive` for price checks and stash calls. Preserve endpoint-specific authentication and response-shape errors.

- [ ] **Step 5: Run focused and existing API tests**

Run: `npx vitest run tests/trade-request-scheduler.test.ts tests/trade-rate-limit.test.ts tests/live-search.test.ts tests/price-check-search.test.ts tests/stash.test.ts`

Expected: PASS with no overlapping work and existing header behavior preserved.

- [ ] **Step 6: Commit**

```bash
git add src/trade/request-scheduler.ts src/trade/rate-limit.ts src/trade/live-search.ts src/trade/price-check.ts src/trade/stash.ts tests/trade-request-scheduler.test.ts tests/trade-rate-limit.test.ts
git commit -m "feat: serialize trade API requests"
```

---

### Task 2: Persistent Search Rows and Renderer-Independent Store

**Files:**
- Create: `src/snipe/store.ts`
- Modify: `src/snipe/board.ts`
- Modify: `src/snipe/queue.ts`
- Test: `tests/snipe-store.test.ts`
- Test: `tests/snipe-board.test.ts`
- Test: `tests/snipe-queue.test.ts`

**Interfaces:**
- Produces: `SnipeStore`, `SnipeSnapshot`, `SnipeSearchSnapshot`, and a candidate board projected from searches plus queue entries.
- Consumes: `CatalogEntry`, `SnipeQueueState`, `SnipeQueueAction`, and `SnipeAlert`.

- [ ] **Step 1: Write failing persistent-row and terminal-ID tests**

```ts
test('keeps enabled searches navigable when all candidates are hidden', () => {
  const store = new SnipeStore([target('one'), target('two')], 20);
  store.ingest(alert('near', { targetId: 'trade:one', marginPct: 19, qualifiesMargin: false }));
  const snapshot = store.snapshot();
  expect(snapshot.board.groups.map((group) => group.targetId)).toEqual(['trade:one', 'trade:two']);
  expect(snapshot.board.groups[0]!.best).toBeNull();
  expect(snapshot.board.groups[0]!.hiddenCount).toBe(1);
  expect(snapshot.queue.selectedTargetId).toBe('trade:one');
});

test('does not resurrect dismissed or evicted ids', () => {
  const store = new SnipeStore([target('one')], 20, 2);
  store.ingest(alert('dismissed'));
  store.dispatch({ type: 'dismiss', listingId: 'dismissed' });
  store.ingest(alert('new-1'));
  store.ingest(alert('new-2'));
  store.ingest(alert('dismissed'));
  expect(store.snapshot().queue.entries.map((entry) => entry.alert.listingId)).not.toContain('dismissed');
  expect(store.snapshot().queue.entries).toHaveLength(2);
});
```

- [ ] **Step 2: Run tests and confirm the old empty-board behavior fails**

Run: `npx vitest run tests/snipe-store.test.ts tests/snipe-board.test.ts tests/snipe-queue.test.ts`

Expected: FAIL because groups are currently derived only from visible entries.

- [ ] **Step 3: Add explicit search projection types**

```ts
export type SnipeSearchState = 'stopped' | 'connecting' | 'live' | 'seeding' | 'cooldown' | 'rate-limited' | 'reconnecting' | 'auth-required';

export interface SnipeSearchSnapshot {
  readonly target: CatalogEntry;
  readonly state: SnipeSearchState;
  readonly detail: string | null;
}

export interface CandidateGroup {
  readonly targetId: string;
  readonly targetLabel: string;
  readonly entries: readonly SnipeQueueEntry[];
  readonly best: SnipeQueueEntry | null;
  readonly moreCount: number;
  readonly hiddenCount: number;
}
```

Change `projectCandidateBoard` to accept the ordered search snapshots and create every group before adding visible entries. Sort groups with candidates first by profit/recency and preserve configured order for empty groups.

- [ ] **Step 4: Implement the observable store and terminal-ID ledger**

```ts
export interface SnipeSnapshot {
  readonly searches: readonly SnipeSearchSnapshot[];
  readonly queue: SnipeQueueState;
  readonly board: CandidateBoard;
  readonly floor: number;
  readonly progress: { readonly seeded: number; readonly total: number };
  readonly status: string | null;
}

export class SnipeStore {
  snapshot(): SnipeSnapshot;
  subscribe(listener: () => void): () => void;
  dispatch(action: SnipeQueueAction): void;
  ingest(alert: SnipeAlert, receivedAt?: string): void;
  setSearchState(targetId: string, state: SnipeSearchState, detail?: string): void;
  setProgress(seeded: number, total: number): void;
  setFloor(floor: number): void;
  setStatus(status: string | null): void;
}
```

Keep a bounded ledger of every ingested, dismissed, gone, traveled, or evicted ID for the session. `ingest()` ignores ledger duplicates. Queue trimming reports evicted IDs back to the store so later snapshots cannot resurrect them.

- [ ] **Step 5: Run focused tests**

Run: `npx vitest run tests/snipe-store.test.ts tests/snipe-board.test.ts tests/snipe-queue.test.ts`

Expected: PASS; empty searches remain rows and terminal IDs remain absent.

- [ ] **Step 6: Commit**

```bash
git add src/snipe/store.ts src/snipe/board.ts src/snipe/queue.ts tests/snipe-store.test.ts tests/snipe-board.test.ts tests/snipe-queue.test.ts
git commit -m "feat: keep enabled snipe searches navigable"
```

---

### Task 3: Reusable Headless Snipe Runtime

**Files:**
- Create: `src/snipe/runtime.ts`
- Modify: `src/snipe/run.ts`
- Modify: `src/snipe/console.tsx`
- Test: `tests/snipe-runtime.test.ts`
- Test: `tests/snipe-run.test.ts`
- Test: `tests/snipe-console.test.tsx`

**Interfaces:**
- Produces: `startSnipeRuntime(options, deps): Promise<SnipeRuntimeHandle>`.
- Consumes: `SnipeStore`, resolved targets, league, repository, notifier, travel controller, socket factory, and scheduler.

- [ ] **Step 1: Write failing runtime/store integration tests**

```ts
test('publishes connection, seed progress, candidates, and cooldown without console output', async () => {
  const store = new SnipeStore([TARGET], 20);
  const runtime = await startSnipeRuntime({ targets: [TARGET], league: 'Allflame', minMarginPct: 20, store }, deps());
  harness.socket.emit('open');
  await harness.seeded;
  expect(store.snapshot().searches[0]!.state).toBe('live');
  expect(store.snapshot().progress).toEqual({ seeded: 1, total: 1 });
  expect(store.snapshot().board.groups).toHaveLength(1);
  expect(harness.out).not.toHaveBeenCalled();
  await runtime.stop();
});

test('stop is bounded when fetch and Chrome never settle', async () => {
  const runtime = await startSnipeRuntime(options, deps({ fetchListings: () => new Promise(() => undefined), shutdownTimeoutMs: 20 }));
  await expect(runtime.stop()).resolves.toBeUndefined();
});
```

- [ ] **Step 2: Run runtime tests and confirm failure**

Run: `npx vitest run tests/snipe-runtime.test.ts tests/snipe-run.test.ts tests/snipe-console.test.tsx`

Expected: FAIL because orchestration is still coupled to `runSnipe` and its renderer.

- [ ] **Step 3: Extract the runtime contract**

```ts
export interface StartSnipeRuntimeOptions {
  readonly targets: readonly CatalogEntry[];
  readonly league: string;
  readonly minMarginPct: number;
  readonly store: SnipeStore;
}

export interface SnipeRuntimeHandle {
  readonly store: SnipeStore;
  travel(listingId: string): Promise<TravelResult>;
  stop(): Promise<void>;
}
```

Move socket management, seed loops, detail processing, notification, margin assessment, travel-controller creation, and bounded cleanup into `runtime.ts`. Publish all user-facing activity through store methods. Keep detailed diagnostic logging through `deps.log` only.

- [ ] **Step 4: Make `runSnipe` a composition wrapper**

`runSnipe` continues to resolve folders, prompt/import, resolve leagues and per-run selection, then creates a store, starts the runtime, and renders the focused UI. Its compatibility wrapper preserves existing CLI behavior and tests.

- [ ] **Step 5: Convert the standalone UI to a store subscriber**

Use React's external-store integration:

```ts
const snapshot = useSyncExternalStore(store.subscribe, store.snapshot, store.snapshot);
```

Dispatch movement, floor, dismiss, gone, and travel actions into the store. Remove cumulative `alerts` prop ingestion and the renderer-local ID ledger. Render `best === null` groups safely and keep concise failure details.

- [ ] **Step 6: Run runtime and console tests**

Run: `npx vitest run tests/snipe-runtime.test.ts tests/snipe-run.test.ts tests/snipe-console.test.tsx`

Expected: PASS; standalone behavior is preserved without renderer-owned runtime state.

- [ ] **Step 7: Commit**

```bash
git add src/snipe/runtime.ts src/snipe/run.ts src/snipe/console.tsx tests/snipe-runtime.test.ts tests/snipe-run.test.ts tests/snipe-console.test.tsx
git commit -m "refactor: share the headless snipe runtime"
```

---

### Task 4: In-TUI Snipe Configuration Overlay

**Files:**
- Create: `src/snipe/configure.tsx`
- Modify: `src/snipe/catalog.ts`
- Modify: `src/snipe/import.ts`
- Test: `tests/snipe-configure.test.tsx`
- Test: `tests/snipe-catalog.test.ts`

**Interfaces:**
- Produces: `SnipeConfigureOverlay` and atomic catalog mutations used by both the TUI and CLI.
- Consumes: `CatalogEntry`, Better Trading decoder/importer, and manifest storage.

- [ ] **Step 1: Write failing overlay interaction tests**

```tsx
test('candidates can be toggled and Enter saves and starts', async () => {
  const onSave = vi.fn(async () => undefined);
  const onStart = vi.fn(async () => undefined);
  const ui = render(<SnipeConfigureOverlay entries={[enabled('one'), enabled('two')]} onSave={onSave} onStart={onStart} onClose={() => undefined} />);
  ui.stdin.write(' ');
  ui.stdin.write('\r');
  await flush();
  expect(onSave).toHaveBeenCalledWith(expect.arrayContaining([expect.objectContaining({ key: 'trade:one', enabled: false })]));
  expect(onStart).toHaveBeenCalledWith(['trade:two']);
});

test('invalid import remains open with an actionable error', async () => {
  const ui = render(<SnipeConfigureOverlay entries={[]} {...callbacks} />);
  ui.stdin.write('i');
  ui.stdin.write('not-an-export');
  ui.stdin.write('\r');
  await flush();
  expect(ui.lastFrame()).toMatch(/expected "2:<base64>" or "3:<base64>"/i);
  expect(callbacks.onClose).not.toHaveBeenCalled();
});
```

- [ ] **Step 2: Run tests and confirm failure**

Run: `npx vitest run tests/snipe-configure.test.tsx tests/snipe-catalog.test.ts`

Expected: FAIL because the overlay and batch mutation API do not exist.

- [ ] **Step 3: Add atomic catalog mutation helpers**

```ts
export interface CatalogEdit {
  readonly key: string;
  readonly label?: string;
  readonly league?: string | null;
  readonly minMarginPct?: number | null;
  readonly enabled?: boolean;
}

export function updateSnipeCatalog(folder: string, edits: readonly CatalogEdit[]): readonly CatalogEntry[];
export function importIntoSnipeCatalog(folder: string, source: string): readonly CatalogEntry[];
```

Load once, validate every edit/import, write one manifest atomically, and return the reloaded catalog. Do not partially save invalid input.

- [ ] **Step 4: Implement the focused overlay state machine**

Support list, edit, and import modes. In list mode: arrows move, Space toggles, `a` toggles all, `e` edits selected, `i` imports, Enter saves then calls `onStart(enabledKeys)`, and Escape saves then closes without `onStart`. In edit mode, advance through label, URL/search identity, and optional floor fields with Enter; keep field-specific errors visible.

- [ ] **Step 5: Run overlay and catalog tests**

Run: `npx vitest run tests/snipe-configure.test.tsx tests/snipe-catalog.test.ts tests/snipe-import.test.ts`

Expected: PASS with invalid input retained and atomic saves.

- [ ] **Step 6: Commit**

```bash
git add src/snipe/configure.tsx src/snipe/catalog.ts src/snipe/import.ts tests/snipe-configure.test.tsx tests/snipe-catalog.test.ts tests/snipe-import.test.ts
git commit -m "feat: configure snipes inside Ink"
```

---

### Task 5: Embed PRICE ALERTS and SNIPES in Tab 4

**Files:**
- Create: `src/snipe/board-view.tsx`
- Modify: `src/tui/app.tsx`
- Modify: `src/cli.ts`
- Test: `tests/tui.test.tsx`
- Test: `tests/snipe-board-view.test.tsx`
- Test: `tests/cli-snipe.test.ts`

**Interfaces:**
- Produces: reusable `SnipeBoardView` and main-TUI `SnipeWorkspaceAdapter` props.
- Consumes: `SnipeStore`, `SnipeRuntimeHandle`, catalog callbacks, and configuration overlay.

- [ ] **Step 1: Write failing embedded-navigation tests**

```tsx
test('tab 4 switches between PRICE ALERTS and persistent SNIPES rows', async () => {
  const ui = render(<ExiliumTui {...PROPS} snipe={workspaceWithTargets(['one', 'two'])} />);
  ui.stdin.write('4');
  await flush();
  expect(ui.lastFrame()).toContain('PRICE ALERTS');
  ui.stdin.write('\t');
  await flush();
  expect(ui.lastFrame()).toContain('SNIPES');
  expect(ui.lastFrame()).toContain('one');
  expect(ui.lastFrame()).toContain('two');
});

test('c opens configuration only inside WATCHES', async () => {
  const ui = render(<ExiliumTui {...PROPS} snipe={workspaceWithTargets(['one'])} />);
  ui.stdin.write('c');
  expect(ui.lastFrame()).toContain('category:');
  ui.stdin.write('\u001b');
  ui.stdin.write('4');
  ui.stdin.write('c');
  await flush();
  expect(ui.lastFrame()).toContain('CONFIGURE SNIPES');
});
```

- [ ] **Step 2: Run embedded tests and confirm failure**

Run: `npx vitest run tests/tui.test.tsx tests/snipe-board-view.test.tsx tests/cli-snipe.test.ts`

Expected: FAIL because tab 4 has no internal view or workspace adapter.

- [ ] **Step 3: Extract the shared board renderer**

```ts
export interface SnipeBoardViewProps {
  readonly store: SnipeStore;
  readonly onTravel: (listingId: string) => Promise<TravelResult>;
  readonly active?: boolean;
  readonly embedded?: boolean;
}
```

Render rows, details, hidden toggle, floor input, selection, concise errors, and stable status from the snapshot. The component handles input only when `active !== false`. The standalone console composes this component with its own header/quit handling.

- [ ] **Step 4: Add the WATCHES internal view and configuration mode**

Extend main-TUI state with:

```ts
type WatchesView = 'price-alerts' | 'snipes';
type InputMode = 'normal' | 'search' | 'sort' | 'category' | 'watch' | 'league' | 'snipe-config';
```

When `view === 'watches'`, Tab/Shift+Tab switches `WatchesView`, `c` opens the overlay, and parent table input is disabled while the board or overlay owns navigation. Escape unwinds overlay/detail before switching a top-level mode.

- [ ] **Step 5: Wire a lazy workspace into `cmdTui`**

Pass an adapter that loads the catalog immediately but creates `SnipeStore` and starts `SnipeRuntimeHandle` only after the overlay's Enter callback. Restart first awaits the prior handle's bounded `stop()`. Register TUI exit cleanup without starting Chrome.

- [ ] **Step 6: Run embedded and standalone tests**

Run: `npx vitest run tests/tui.test.tsx tests/snipe-board-view.test.tsx tests/snipe-console.test.tsx tests/cli-snipe.test.ts`

Expected: PASS; the main TUI and standalone command show the same snapshot rows.

- [ ] **Step 7: Commit**

```bash
git add src/snipe/board-view.tsx src/tui/app.tsx src/cli.ts tests/tui.test.tsx tests/snipe-board-view.test.tsx tests/cli-snipe.test.ts
git commit -m "feat: add snipes to Watches tab"
```

---

### Task 6: Gone-Listing Promotion and User-Friendly Failure States

**Files:**
- Modify: `src/snipe/runtime.ts`
- Modify: `src/snipe/store.ts`
- Modify: `src/snipe/board-view.tsx`
- Modify: `src/snipe/browser.ts`
- Test: `tests/snipe-runtime.test.ts`
- Test: `tests/snipe-board-view.test.tsx`
- Test: `tests/snipe-browser.test.ts`

**Interfaces:**
- Consumes: `SnipeRuntimeHandle.travel`, terminal-ID ledger, and `TravelResult`.
- Produces: deterministic gone removal, next-best promotion, concise auth/reconnect/Chrome state.

- [ ] **Step 1: Write failing gone-promotion and failure-display tests**

```ts
test('gone removes the candidate, promotes the next best, and never auto-travels', async () => {
  store.ingest(alert('best', { marginPct: 30 }));
  store.ingest(alert('next', { marginPct: 25 }));
  travel.mockResolvedValueOnce({ action: 'gone', detail: 'listing sold' });
  await runtime.travel('best');
  expect(store.snapshot().board.groups[0]!.best!.alert.listingId).toBe('next');
  expect(travel).toHaveBeenCalledTimes(1);
  expect(store.snapshot().status).toMatch(/sold|removed/i);
});

test('Chrome protocol traces render as one recovery line', async () => {
  travel.reject(new Error('Browser.setDownloadBehavior\nCall log:\n...'));
  await pressEnter(ui);
  expect(ui.lastFrame()).toContain('Chrome unavailable — run exilium chrome, then press Enter again');
  expect(ui.lastFrame()).not.toContain('Call log:');
});
```

- [ ] **Step 2: Run tests and confirm failure**

Run: `npx vitest run tests/snipe-runtime.test.ts tests/snipe-board-view.test.tsx tests/snipe-browser.test.ts`

- [ ] **Step 3: Implement travel state transitions and concise mapping**

Before controller interaction, revalidate the listing. Dispatch `travel-start`; on `gone`, dispatch `remove-gone` and terminalize the ID; on success, dispatch `travel-success`; on failure, dispatch `travel-failure` with full technical detail while the board renders `shortFailure(detail)`. Never call travel recursively for a replacement.

- [ ] **Step 4: Publish auth, reconnect, and Chrome statuses**

Map 401/403 seed/detail errors to `auth-required`, socket close to `reconnecting` with countdown detail, and browser attach failure only to the selected candidate. Do not change unrelated search rows.

- [ ] **Step 5: Run focused tests**

Run: `npx vitest run tests/snipe-runtime.test.ts tests/snipe-board-view.test.tsx tests/snipe-browser.test.ts tests/snipe-travel.test.ts`

Expected: PASS with one explicit Enter per travel attempt.

- [ ] **Step 6: Commit**

```bash
git add src/snipe/runtime.ts src/snipe/store.ts src/snipe/board-view.tsx src/snipe/browser.ts tests/snipe-runtime.test.ts tests/snipe-board-view.test.tsx tests/snipe-browser.test.ts
git commit -m "fix: promote valid snipes after gone listings"
```

---

### Task 7: Documentation and Full Verification

**Files:**
- Modify: `README.md`
- Modify: `docs/superpowers/specs/2026-08-09-compact-snipe-candidate-board-design.md`
- Test: all affected Vitest suites

**Interfaces:**
- Consumes: completed CLI shortcuts and runtime behavior.
- Produces: user-facing macOS/Windows instructions matching the implementation.

- [ ] **Step 1: Update user documentation**

Document:

```text
exilium
  4             open WATCHES
  Tab           PRICE ALERTS / SNIPES
  c             configure Better Trading snipes
  Space / a     enable one / all
  e / i         edit / import
  Enter         save and start selected searches

exilium snipe   open the same focused live board directly
```

Explain `LIVE` versus qualifying candidates, `COOLDOWN` versus `RATE LIMITED`, the default +20 percent floor, `u`, `f`, and that Chrome is only used for explicit travel.

- [ ] **Step 2: Amend the older compact-board spec note**

Add a supersession note pointing to `2026-08-09-watches-snipe-workspace-design.md` for persistent empty search rows. Do not rewrite historical requirements beyond that explicit conflict.

- [ ] **Step 3: Run formatting and targeted regression suites**

Run: `git diff --check`

Run: `npx vitest run tests/trade-request-scheduler.test.ts tests/trade-rate-limit.test.ts tests/live-search.test.ts tests/snipe-store.test.ts tests/snipe-board.test.ts tests/snipe-queue.test.ts tests/snipe-runtime.test.ts tests/snipe-run.test.ts tests/snipe-configure.test.tsx tests/snipe-board-view.test.tsx tests/snipe-console.test.tsx tests/tui.test.tsx tests/cli-snipe.test.ts`

Expected: all targeted tests PASS.

- [ ] **Step 4: Run complete verification**

Run: `npm test`

Expected: all Vitest files and tests PASS.

Run: `npm run build`

Expected: `tsc` exits 0 with no diagnostics.

- [ ] **Step 5: Commit documentation**

```bash
git add README.md docs/superpowers/specs/2026-08-09-compact-snipe-candidate-board-design.md
git commit -m "docs: explain Watches snipe management"
```
