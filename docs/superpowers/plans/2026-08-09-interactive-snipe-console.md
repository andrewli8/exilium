# Interactive Windows Snipe Console Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build a Windows-first `exilium snipe` flow that imports Better Trading folder exports, asks which searches to enable on every run, queues live hits in the CLI, and travels only when the user selects a hit and presses Enter through one reusable Chrome tab.

**Architecture:** Keep Path of Exile WebSockets as the detection path, isolate per-run selection and alert-queue state into pure reducers, and render both with Ink. Replace arrival-triggered auto-travel with a serialized manual travel controller attached over CDP to one user-launched Chrome page; `run.ts` connects the watcher, UI, pricing, notifier, and controller without copying or sending whispers.

**Tech Stack:** TypeScript 7, Node.js 20+, React 19, Ink 7, Playwright 1.62, Vitest 4, `ink-testing-library`, Zod, `ws`.

## Global Constraints

- Windows Terminal and PowerShell are the primary terminal targets; keyboard interaction must work without terminal mouse-mode support.
- A listing arriving must never trigger travel. Exactly one explicit Enter action may cause exactly one `button.direct-btn` click.
- Exilium must never send a seller whisper, simulate in-game input, or copy a whisper in the interactive console flow.
- One Exilium-owned browser page is reused for all searches and listings; never create one page per search or alert.
- Search selection is per run and is never persisted. Stable source, league, margin, Chrome path/profile, and CDP settings may persist.
- Better Trading extension integration uses its versioned `2:`/`3:` export strings; do not parse Chrome extension LevelDB storage.
- Keep the existing live-search socket cap of 20 and bounded reconnect behavior.
- Preserve current user-authored/uncommitted changes unless a task explicitly replaces the same behavior; inspect `git diff` before each edit.
- Use the existing ASCII-safe `fold()`/glyph policy for Windows consoles.
- Every production change follows a witnessed RED → GREEN test cycle.

---

## File Structure

### New files

- `src/snipe/import.ts` — validates and idempotently persists pasted/file Better Trading sources.
- `src/snipe/selection.ts` — pure per-run multi-select state and non-TTY selection resolution.
- `src/snipe/queue.ts` — pure bounded alert queue and travel lifecycle reducer.
- `src/snipe/console.tsx` — Ink target picker, alert queue, and programmatic render handles.
- `tests/snipe-import.test.ts` — import behavior and filesystem safety.
- `tests/snipe-selection.test.ts` — selection reducer and non-TTY flags.
- `tests/snipe-queue.test.ts` — queue ordering, stable selection, lifecycle, and bounds.
- `tests/snipe-console.test.tsx` — keyboard interaction and rendered Windows-safe output.
- `tests/snipe-browser.test.ts` — attached/persistent browser page ownership and single-page reuse.

### Modified files

- `src/config.ts` — persisted Chrome executable/profile/CDP and optional snipe league.
- `src/snipe/chrome.ts` — validated ports, Windows Chrome/Edge discovery, Windows profile default.
- `src/snipe/bettertrading.ts` — public parse entry point reused by imports.
- `src/snipe/travel.ts` — remove immediate auto mode; retain selectors and manual result contract.
- `src/snipe/browser.ts` — expose one serialized `travel(alert)` controller and ownership-safe close.
- `src/snipe/run.ts` — select targets, queue alerts, and dispatch travel only from UI input.
- `src/cli.ts` — `snipe import`, `--all`, repeated `--search`, and hardened `chrome` command.
- `tests/snipe-config.test.ts` — new config defaults/overrides; remove auto-ack assumptions.
- `tests/snipe-chrome.test.ts` — Windows discovery and validation.
- `tests/bettertrading.test.ts` — source-level parse contract used by import.
- `tests/snipe-travel.test.ts` — manual action wording and no-whisper behavior.
- `tests/cli-integration.test.ts` — import and non-TTY selection behavior.
- `examples/06-snipe-folder.md` — Windows setup, selection, queue, and Enter flow.
- `README.md` — command summary and human-triggered guarantee.
- `scripts/e2e-snipe.ts` — optional interactive single-tab verification mode.

---

### Task 1: Persisted Windows Chrome Settings and Launch Discovery

**Files:**
- Modify: `src/config.ts`
- Modify: `src/snipe/chrome.ts`
- Modify: `src/cli.ts`
- Modify: `tests/snipe-config.test.ts`
- Modify: `tests/snipe-chrome.test.ts`

**Interfaces:**
- Consumes: `FileConfig.snipe`, `NodeJS.ProcessEnv`, `node:fs.existsSync`.
- Produces: `SnipeSettings.chromeCdpUrl`, `chromePath`, `chromeProfile`, `league`; `parseCdpPort(raw): number`; `resolveChromeLaunch(input): ChromeLaunch`.

- [ ] **Step 1: Write failing config tests for the stable saved fields**

Add expectations independent of platform discovery:

```ts
test('loads saved snipe Chrome and league settings without persisting a selection', () => {
  const config = loadConfig({}, { snipe: {
    league: 'Current',
    chromeCdpUrl: 'http://127.0.0.1:9333',
    chromePath: 'C:\\Portable\\chrome.exe',
    chromeProfile: 'C:\\ExiliumProfile',
  } });
  expect(config.snipe).toMatchObject({
    league: 'Current',
    chromeCdpUrl: 'http://127.0.0.1:9333',
    chromePath: 'C:\\Portable\\chrome.exe',
    chromeProfile: 'C:\\ExiliumProfile',
  });
  expect(config.snipe).not.toHaveProperty('selectedSearchIds');
});
```

- [ ] **Step 2: Run the config test and witness RED**

Run: `npx vitest run tests/snipe-config.test.ts`

Expected: FAIL because `league`, `chromePath`, and `chromeProfile` are absent.

- [ ] **Step 3: Add the exact config fields and resolution order**

Extend both file and resolved interfaces:

```ts
export interface SnipeFileConfig {
  readonly folder?: string;
  readonly minMarginPct?: number;
  readonly mode?: string;
  readonly sound?: boolean;
  readonly webhookUrl?: string;
  readonly league?: string;
  readonly chromeCdpUrl?: string;
  readonly chromePath?: string;
  readonly chromeProfile?: string;
  readonly autoTravelAcknowledged?: boolean;
}

export interface SnipeSettings {
  readonly folder: string | undefined;
  readonly minMarginPct: number | null;
  readonly mode: string | undefined;
  readonly sound: boolean;
  readonly webhookUrl: string | undefined;
  readonly league: string | undefined;
  readonly chromeCdpUrl: string;
  readonly chromePath: string | undefined;
  readonly chromeProfile: string | undefined;
  readonly autoTravelAcknowledged: boolean;
}
```

Resolve CDP from `EXILIUM_CHROME_CDP → file → http://127.0.0.1:9222`, Chrome path from `EXILIUM_CHROME → file`, and other fields from the file. Remove `mode` and `autoTravelAcknowledged` only after Task 7 migrates their consumers; until then retain them as deprecated internal fields.

- [ ] **Step 4: Run the config test and witness GREEN**

Run: `npx vitest run tests/snipe-config.test.ts`

Expected: PASS.

- [ ] **Step 5: Write failing Windows discovery and validation tests**

Replace the one-path assumption with literal candidates:

```ts
test('uses Local App Data Chrome when Program Files copies do not exist', () => {
  const local = 'C:\\Users\\me\\AppData\\Local';
  const expected = `${local}\\Google\\Chrome\\Application\\chrome.exe`;
  const launch = resolveChromeLaunch({
    platform: 'win32',
    env: { PROGRAMFILES: 'C:\\Program Files', LOCALAPPDATA: local },
    port: 9222,
    exists: (path) => path === expected,
  });
  expect(launch.cmd).toBe(expected);
  expect(launch.args).toContain(`--user-data-dir=${local}\\Exilium\\chrome-profile`);
});

test.each(['0', '-1', '65536', 'abc', '9222.5'])(
  'rejects invalid CDP port %s',
  (raw) => expect(() => parseCdpPort(raw)).toThrow(/port/i),
);
```

Also cover `%PROGRAMFILES(X86)%`, Edge fallback, explicit saved path, and `EXILIUM_CHROME` precedence.

- [ ] **Step 6: Run Chrome tests and witness RED**

Run: `npx vitest run tests/snipe-chrome.test.ts`

Expected: FAIL because candidate discovery and validation do not exist.

- [ ] **Step 7: Implement pure Windows-aware launch resolution**

Use these contracts:

```ts
export interface ResolveChromeLaunchInput {
  readonly platform: NodeJS.Platform;
  readonly env: NodeJS.ProcessEnv;
  readonly port: number;
  readonly profileDir?: string;
  readonly configuredPath?: string;
  readonly exists?: (path: string) => boolean;
}

export function parseCdpPort(raw: string | undefined): number;
export function resolveChromeLaunch(input: ResolveChromeLaunchInput): ChromeLaunch;
```

For Windows, enumerate Google Chrome under Program Files, Program Files (x86), and Local App Data, then Edge in the same roots. If none exists, return the first Google candidate with a note listing `EXILIUM_CHROME`; do not silently pick a nonexistent Edge path. On macOS/Linux preserve the existing behavior. Build all launch arguments as separate array entries.

- [ ] **Step 8: Harden `cmdChrome` around the new resolver**

Call `parseCdpPort(flagValue('--port'))`, use saved path/profile, and attach both an `error` listener and a short `spawn` event promise before `unref()`. `--print` performs no spawn. Keep secrets out of printed output.

- [ ] **Step 9: Run focused tests and build**

Run: `npx vitest run tests/snipe-config.test.ts tests/snipe-chrome.test.ts`

Run: `npm run build`

Expected: all pass with exit 0.

- [ ] **Step 10: Commit Task 1**

```bash
git add src/config.ts src/snipe/chrome.ts src/cli.ts tests/snipe-config.test.ts tests/snipe-chrome.test.ts
git commit -m "feat: harden Windows Chrome setup for snipe"
```

---

### Task 2: Better Trading Paste/File Import

**Files:**
- Create: `src/snipe/import.ts`
- Create: `tests/snipe-import.test.ts`
- Modify: `src/snipe/bettertrading.ts`
- Modify: `tests/bettertrading.test.ts`
- Modify: `src/cli.ts`

**Interfaces:**
- Consumes: `targetsFromText(content, stem)`, `targetsFromJson(content, stem)`, resolved BetterTrading folder.
- Produces: `parseSnipeSource(content, sourceName): readonly SnipeTarget[]`; `persistSnipeImport(input, deps): ImportResult`; `runSnipeImport(flags, deps)`.

- [ ] **Step 1: Write a failing public source-parse test**

```ts
test('parseSnipeSource accepts a copied v3 folder export', () => {
  const payload = Buffer.from(JSON.stringify({
    tit: 'Currency', ver: '1', trs: [{ tit: 'Divines', loc: '1:search:abc123' }],
  })).toString('base64');
  expect(parseSnipeSource(`3:${payload}`, 'clipboard')).toEqual([
    { label: 'Currency · Divines', realm: 'trade', searchId: 'abc123', league: null },
  ]);
});
```

- [ ] **Step 2: Run Better Trading tests and witness RED**

Run: `npx vitest run tests/bettertrading.test.ts`

Expected: FAIL because `parseSnipeSource` is not exported.

- [ ] **Step 3: Implement `parseSnipeSource` without duplicating decoders**

Dispatch `.json` names to `targetsFromJson`; otherwise call `targetsFromText`. If the trimmed content is a single `2:`/`3:` export, propagate its detailed decode error instead of returning an empty array. Reject an otherwise valid source that produces zero searches with `` `No trade searches found in ${sourceName}` ``.

- [ ] **Step 4: Run Better Trading tests and witness GREEN**

Run: `npx vitest run tests/bettertrading.test.ts`

Expected: PASS.

- [ ] **Step 5: Write failing idempotent persistence tests**

Use a real temporary directory and literal output assertions:

```ts
test('persists one validated export idempotently under the BetterTrading folder', () => {
  const first = persistSnipeImport({ folder: dir, content: VALID_EXPORT, sourceName: 'clipboard' });
  const second = persistSnipeImport({ folder: dir, content: ` ${VALID_EXPORT}\n`, sourceName: 'clipboard' });
  expect(second.path).toBe(first.path);
  expect(second.created).toBe(false);
  expect(readFileSync(first.path, 'utf8')).toBe(`${VALID_EXPORT}\n`);
  expect(loadSnipeFolder(readSnipeFolderFiles(dir), () => {})).toHaveLength(1);
});

test('invalid input does not create or replace a source file', () => {
  expect(() => persistSnipeImport({ folder: dir, content: '3:not-json', sourceName: 'clipboard' })).toThrow();
  expect(readdirSync(dir)).toEqual([]);
});
```

- [ ] **Step 6: Run import tests and witness RED**

Run: `npx vitest run tests/snipe-import.test.ts`

Expected: FAIL because `persistSnipeImport` does not exist.

- [ ] **Step 7: Implement validation-before-write and deterministic naming**

Define:

```ts
export interface PersistSnipeImportInput {
  readonly folder: string;
  readonly content: string;
  readonly sourceName: string;
}

export interface ImportResult {
  readonly path: string;
  readonly created: boolean;
  readonly targets: readonly SnipeTarget[];
}
```

Trim input, validate fully, hash normalized content with SHA-256, and write `` `import-${digest.slice(0, 12)}.bt` `` using `flag: 'wx'`. Create the directory only after validation. Existing identical files return `created: false`. A file-input import reads UTF-8 and uses the same function.

- [ ] **Step 8: Run import tests and witness GREEN**

Run: `npx vitest run tests/snipe-import.test.ts tests/bettertrading.test.ts`

Expected: PASS.

- [ ] **Step 9: Wire `exilium snipe import`**

In `cmdSnipe`, branch when `process.argv[3] === 'import'`. `--file FILE` reads the file; otherwise require a TTY and use `readline/promises` to ask for one pasted export line. Non-TTY without `--file` reads all stdin until EOF. Print imported target count and saved path. Do not require POESESSID for import.

- [ ] **Step 10: Commit Task 2**

```bash
git add src/snipe/import.ts src/snipe/bettertrading.ts src/cli.ts tests/snipe-import.test.ts tests/bettertrading.test.ts
git commit -m "feat: import Better Trading folders for snipe"
```

---

### Task 3: Per-Run Search Selection Model

**Files:**
- Create: `src/snipe/selection.ts`
- Create: `tests/snipe-selection.test.ts`

**Interfaces:**
- Consumes: `readonly SnipeTarget[]`, `--all`, repeated `--search` values, TTY state.
- Produces: `SelectionState`, `selectionReducer`, `resolveRequestedTargets`.

- [ ] **Step 1: Write failing reducer tests**

```ts
const TARGETS = [
  { label: 'Currency', realm: 'trade', searchId: 'aaa', league: null },
  { label: 'Uniques', realm: 'trade', searchId: 'bbb', league: null },
] as const;

test('new target data starts with nothing enabled every run', () => {
  expect(createSelectionState(TARGETS)).toMatchObject({ cursor: 0, selectedIds: new Set() });
  expect(createSelectionState(TARGETS)).toMatchObject({ cursor: 0, selectedIds: new Set() });
});

test('toggle, move, and select-all are bounded', () => {
  let state = createSelectionState(TARGETS);
  state = selectionReducer(state, { type: 'toggle' });
  state = selectionReducer(state, { type: 'move', delta: 1 });
  state = selectionReducer(state, { type: 'toggle-all' });
  expect(state.cursor).toBe(1);
  expect([...state.selectedIds].sort()).toEqual(['trade:aaa', 'trade:bbb']);
});
```

- [ ] **Step 2: Run selection tests and witness RED**

Run: `npx vitest run tests/snipe-selection.test.ts`

Expected: FAIL because the module is absent.

- [ ] **Step 3: Implement immutable selection state**

Use exact types:

```ts
export interface SelectionState {
  readonly targets: readonly SnipeTarget[];
  readonly cursor: number;
  readonly selectedIds: ReadonlySet<string>;
}

export type SelectionAction =
  | { readonly type: 'move'; readonly delta: number }
  | { readonly type: 'toggle' }
  | { readonly type: 'toggle-index'; readonly index: number }
  | { readonly type: 'toggle-all' };
```

Identity is `${realm}:${searchId}` so PoE1 and PoE2 slugs cannot collide. Clamp movement and leave the previous state untouched when there are no targets.

- [ ] **Step 4: Write failing non-TTY/flag tests**

```ts
test('non-TTY requires --all or at least one --search selector', () => {
  expect(() => resolveRequestedTargets(TARGETS, { isTTY: false, all: false, searches: [] }))
    .toThrow(/--all|--search/);
});

test('repeated selectors match exact id first and unique label case-insensitively', () => {
  expect(resolveRequestedTargets(TARGETS, {
    isTTY: false, all: false, searches: ['aaa', 'uniques'],
  }).map((t) => t.searchId)).toEqual(['aaa', 'bbb']);
});
```

Also test ambiguous labels and unknown selectors fail with the offending value.

- [ ] **Step 5: Run the focused test and witness RED for flag resolution**

Run: `npx vitest run tests/snipe-selection.test.ts`

Expected: reducer tests pass; flag tests fail because `resolveRequestedTargets` is absent.

- [ ] **Step 6: Implement explicit selection resolution**

```ts
export interface SelectionRequest {
  readonly isTTY: boolean;
  readonly all: boolean;
  readonly searches: readonly string[];
}

export function resolveRequestedTargets(
  targets: readonly SnipeTarget[],
  request: SelectionRequest,
): readonly SnipeTarget[] | null;
```

Return `null` only when an interactive picker is required. `--all` returns all targets. Deduplicate repeated selectors in source order.

- [ ] **Step 7: Run selection tests and witness GREEN**

Run: `npx vitest run tests/snipe-selection.test.ts`

Expected: PASS.

- [ ] **Step 8: Commit Task 3**

```bash
git add src/snipe/selection.ts tests/snipe-selection.test.ts
git commit -m "feat: add per-run snipe search selection"
```

---

### Task 4: Bounded Alert Queue Model

**Files:**
- Create: `src/snipe/queue.ts`
- Create: `tests/snipe-queue.test.ts`

**Interfaces:**
- Consumes: `SnipeAlert` from `engine.ts`.
- Produces: `SnipeQueueState`, `SnipeQueueEntry`, `queueReducer`, `selectedQueueEntry`.

- [ ] **Step 1: Write failing insertion and stable-selection tests**

```ts
test('a new alert is newest-first without moving an existing selected listing', () => {
  let state = createQueueState(3);
  state = queueReducer(state, { type: 'add', alert: alert('one') });
  state = queueReducer(state, { type: 'add', alert: alert('two') });
  state = queueReducer(state, { type: 'move', delta: 1 }); // select one
  state = queueReducer(state, { type: 'add', alert: alert('three') });
  expect(state.entries.map((entry) => entry.alert.listingId)).toEqual(['three', 'two', 'one']);
  expect(selectedQueueEntry(state)?.alert.listingId).toBe('one');
});

test('duplicate listing ids do not create duplicate rows', () => {
  let state = queueReducer(createQueueState(10), { type: 'add', alert: alert('same') });
  state = queueReducer(state, { type: 'add', alert: alert('same') });
  expect(state.entries).toHaveLength(1);
});
```

- [ ] **Step 2: Run queue tests and witness RED**

Run: `npx vitest run tests/snipe-queue.test.ts`

Expected: FAIL because the queue module is absent.

- [ ] **Step 3: Implement identity-stable bounded insertion**

Define:

```ts
export type TravelStatus = 'new' | 'traveling' | 'traveled' | 'failed';

export interface SnipeQueueEntry {
  readonly alert: SnipeAlert;
  readonly status: TravelStatus;
  readonly detail: string | null;
  readonly receivedAt: string;
}

export interface SnipeQueueState {
  readonly entries: readonly SnipeQueueEntry[];
  readonly selectedListingId: string | null;
  readonly maxEntries: number;
}
```

Keep selection by listing ID, not array index. Trim oldest entries after insertion, but never trim the selected row; if necessary trim the next-oldest nonselected row.

- [ ] **Step 4: Write failing lifecycle, retry, dismiss, and bound tests**

```ts
test('only new and failed rows can begin travel', () => {
  let state = queueReducer(withAlert('x'), { type: 'travel-start', listingId: 'x' });
  state = queueReducer(state, { type: 'travel-start', listingId: 'x' });
  expect(state.entries[0]?.status).toBe('traveling');
  state = queueReducer(state, { type: 'travel-success', listingId: 'x', detail: 'clicked once' });
  expect(queueReducer(state, { type: 'travel-start', listingId: 'x' })).toEqual(state);
});

test('failed rows can retry and dismissed rows leave the queue', () => {
  let state = queueReducer(withAlert('x'), { type: 'travel-failure', listingId: 'x', detail: 'gone' });
  state = queueReducer(state, { type: 'travel-start', listingId: 'x' });
  expect(state.entries[0]?.status).toBe('traveling');
  expect(queueReducer(state, { type: 'dismiss', listingId: 'x' }).entries).toEqual([]);
});
```

- [ ] **Step 5: Run queue tests and witness RED for missing transitions**

Run: `npx vitest run tests/snipe-queue.test.ts`

Expected: insertion tests pass; transition tests fail.

- [ ] **Step 6: Implement guarded lifecycle transitions**

Add actions `move`, `add`, `travel-start`, `travel-success`, `travel-failure`, and `dismiss`. `travel-start` is a no-op for `traveling`/`traveled`. `travel-success` and `travel-failure` only apply to `traveling`. Use a default bound of 200 entries.

- [ ] **Step 7: Run queue tests and witness GREEN**

Run: `npx vitest run tests/snipe-queue.test.ts`

Expected: PASS.

- [ ] **Step 8: Commit Task 4**

```bash
git add src/snipe/queue.ts tests/snipe-queue.test.ts
git commit -m "feat: add interactive snipe alert queue"
```

---

### Task 5: One-Page Manual Travel Controller

**Files:**
- Modify: `src/snipe/travel.ts`
- Modify: `src/snipe/browser.ts`
- Modify: `tests/snipe-travel.test.ts`
- Create: `tests/snipe-browser.test.ts`

**Interfaces:**
- Consumes: `SnipeAlert`, Playwright `chromium.connectOverCDP`, optional persistent context fallback.
- Produces: `TravelController.travel(alert): Promise<TravelResult>` and `close(): Promise<void>`.

- [ ] **Step 1: Replace immediate-mode tests with a failing manual action contract**

```ts
test('manual travel has no ping or whisper fallback text', async () => {
  const page = fakePage(true);
  const result = await travelSelectedAlert(ALERT, page);
  expect(result).toEqual({
    action: 'traveled',
    detail: 'clicked Travel to Hideout for Mageblood',
  });
  expect(result.detail).not.toMatch(/whisper|paste/i);
});

test('a missing listing fails without claiming travel', async () => {
  const result = await travelSelectedAlert(ALERT, fakePage(false));
  expect(result.action).toBe('failed');
  expect(result.detail).toMatch(/not found|listing/i);
});
```

- [ ] **Step 2: Run travel tests and witness RED**

Run: `npx vitest run tests/snipe-travel.test.ts`

Expected: FAIL because `travelSelectedAlert` and the new result actions are absent.

- [ ] **Step 3: Implement one explicit action in `travel.ts`**

Keep `rowSelector` and `TravelPage`; remove `resolveTravelMode`, `TravelMode`, `DispatchTravelOptions`, and automatic/ping dispatch after their callers migrate in Task 7. Add:

```ts
export interface TravelResult {
  readonly action: 'traveled' | 'failed';
  readonly detail: string;
}

export async function travelSelectedAlert(
  alert: SnipeAlert,
  page: TravelPage,
): Promise<TravelResult>;
```

Navigate only when the current URL differs, call `clickTravelButton` once, and turn thrown errors into `failed`. Do not call clipboard or `openUrl`.

- [ ] **Step 4: Run travel tests and witness GREEN**

Run: `npx vitest run tests/snipe-travel.test.ts`

Expected: PASS.

- [ ] **Step 5: Write failing controller ownership and reuse tests**

Test the real controller over a complete fake Playwright boundary:

```ts
test('CDP controller creates one owned page and reuses it for two alerts', async () => {
  const fake = fakeCdpBrowser();
  const controller = await createTravelController({
    cdpUrl: 'http://127.0.0.1:9222',
    profileDir: 'C:\\profile',
    log: () => {},
    loadPlaywright: async () => fake.playwright,
  });
  await controller.travel(alert('one'));
  await controller.travel(alert('two'));
  expect(fake.context.newPageCalls).toBe(1);
  expect(fake.pages).toHaveLength(1);
  expect(fake.pages[0]?.gotoUrls).toEqual([alert('one').searchUrl, alert('two').searchUrl]);
});

test('closing an attached controller closes its page and disconnects, not Chrome', async () => {
  const fake = fakeCdpBrowser();
  const controller = await createTravelController(cdpOptions(fake));
  await controller.close();
  expect(fake.page.closeCalls).toBe(1);
  expect(fake.browser.closeCalls).toBe(1);
  expect(fake.chromeProcessClosed).toBe(false);
});
```

Model `browser.close()` according to Playwright's connected-browser contract: for a browser obtained through `connectOverCDP`, it disposes the client connection; for a launched persistent context, close the context. The fake must distinguish these ownership paths.

- [ ] **Step 6: Run browser tests and witness RED**

Run: `npx vitest run tests/snipe-browser.test.ts`

Expected: FAIL because the controller interface and injectable loader are absent.

- [ ] **Step 7: Refactor `browser.ts` into an injectable controller**

```ts
export interface TravelController {
  travel(alert: SnipeAlert): Promise<TravelResult>;
  close(): Promise<void>;
}

export interface TravelControllerOptions {
  readonly cdpUrl: string;
  readonly profileDir: string;
  readonly log: (message: string) => void;
  readonly loadPlaywright?: () => Promise<PlaywrightLike>;
}

export async function createTravelController(
  opts: TravelControllerOptions,
): Promise<TravelController>;
```

Connect over CDP first, create exactly one owned page, and reuse it. Preserve one reload retry inside `clickTravelButton` for indexing lag, but never retry the click. Serialize `travel()` calls with a promise tail so rapid Enter actions cannot race navigation. For persistent fallback, reuse the first page and own/close the context. For CDP, close the owned page and call the connected Browser's `close()` to disconnect under Playwright's connected-browser lifecycle.

- [ ] **Step 8: Run focused browser/travel tests and build**

Run: `npx vitest run tests/snipe-travel.test.ts tests/snipe-browser.test.ts`

Run: `npm run build`

Expected: all pass.

- [ ] **Step 9: Commit Task 5**

```bash
git add src/snipe/travel.ts src/snipe/browser.ts tests/snipe-travel.test.ts tests/snipe-browser.test.ts
git commit -m "feat: add single-tab manual travel controller"
```

---

### Task 6: Ink Multi-Select and Alert Queue

**Files:**
- Create: `src/snipe/console.tsx`
- Create: `tests/snipe-console.test.tsx`

**Interfaces:**
- Consumes: selection and queue reducers, `SnipeTarget`, `SnipeAlert`, async `onTravel`.
- Produces: `promptSnipeTargets`, `renderSnipeConsole`, `SnipeConsoleHandle`.

- [ ] **Step 1: Write failing picker keyboard tests**

```tsx
test('Space toggles searches and Enter submits only this run selection', async () => {
  const submitted: string[][] = [];
  const { stdin, lastFrame } = render(
    <SnipeTargetPicker targets={TARGETS} onSubmit={(targets) => submitted.push(targets.map((t) => t.searchId))} onCancel={() => {}} />,
  );
  expect(lastFrame()).toContain('[ ] Currency');
  stdin.write(' ');
  stdin.write('\u001B[B');
  stdin.write(' ');
  stdin.write('\r');
  await flush();
  expect(submitted).toEqual([['aaa', 'bbb']]);
});

test('a toggles all and Escape cancels without submitting', async () => {
  const submitted = vi.fn();
  const cancelled = vi.fn();
  const { stdin, lastFrame } = render(
    <SnipeTargetPicker targets={TARGETS} onSubmit={submitted} onCancel={cancelled} />,
  );
  stdin.write('a');
  await flush();
  expect(lastFrame()).toContain('[x] Currency');
  expect(lastFrame()).toContain('[x] Uniques');
  stdin.write('\u001B');
  await flush();
  expect(cancelled).toHaveBeenCalledTimes(1);
  expect(submitted).not.toHaveBeenCalled();
});
```

Use literal `[ ]` and `[x]` markers so Windows ASCII fallback is testable.

- [ ] **Step 2: Run console tests and witness RED**

Run: `npx vitest run tests/snipe-console.test.tsx`

Expected: FAIL because the component is absent.

- [ ] **Step 3: Implement picker and programmatic prompt**

```ts
export interface PromptSnipeTargetsOptions {
  readonly stdin?: NodeJS.ReadStream;
  readonly stdout?: NodeJS.WriteStream;
}

export async function promptSnipeTargets(
  targets: readonly SnipeTarget[],
  opts?: PromptSnipeTargetsOptions,
): Promise<readonly SnipeTarget[]>;
```

Render with Ink, use `useInput`, and resolve through `useApp().exit(selectedTargets)` plus `waitUntilExit()`. Keys: Up/Down move, Space toggles, `a` toggles all, `1`–`9` toggle visible indices, Enter submits only when at least one target is selected, Escape cancels with an empty array.

- [ ] **Step 4: Run picker tests and witness GREEN**

Run: `npx vitest run tests/snipe-console.test.tsx`

Expected: picker tests pass.

- [ ] **Step 5: Write failing queue interaction tests**

```tsx
test('Enter travels only the selected row and duplicate Enter is suppressed while traveling', async () => {
  const gate = deferred<TravelResult>();
  const travelIds: string[] = [];
  const { stdin, lastFrame } = render(
    <SnipeQueueApp
      alerts={[alert('one')]}
      onTravel={async (alert) => { travelIds.push(alert.listingId); return gate.promise; }}
    />,
  );
  stdin.write('\r');
  stdin.write('\r');
  await flush();
  expect(travelIds).toEqual(['one']);
  expect(lastFrame()).toContain('TRAVELING');
  gate.resolve({ action: 'traveled', detail: 'clicked Travel to Hideout for Item one' });
  await flush();
  expect(lastFrame()).toContain('TRAVELED');
});

test('new alerts do not move selection and failed rows retry with r', async () => {
  let calls = 0;
  const onTravel = async (): Promise<TravelResult> => {
    calls += 1;
    return calls === 1
      ? { action: 'failed', detail: 'listing vanished' }
      : { action: 'traveled', detail: 'clicked Travel to Hideout for Item one' };
  };
  const ui = render(<SnipeQueueApp alerts={[alert('two'), alert('one')]} onTravel={onTravel} />);
  ui.stdin.write('\u001B[B');
  ui.rerender(<SnipeQueueApp alerts={[alert('three'), alert('two'), alert('one')]} onTravel={onTravel} />);
  await flush();
  expect(ui.lastFrame()).toMatch(/>.*Item one/);
  ui.stdin.write('\r');
  await flush();
  expect(ui.lastFrame()).toContain('FAILED');
  ui.stdin.write('r');
  await flush();
  expect(calls).toBe(2);
  expect(ui.lastFrame()).toContain('TRAVELED');
});
```

- [ ] **Step 6: Run queue UI tests and witness RED**

Run: `npx vitest run tests/snipe-console.test.tsx`

Expected: queue tests fail because the render handle is absent.

- [ ] **Step 7: Implement queue rendering and external rerender handle**

```ts
export interface SnipeConsoleOptions {
  readonly onTravel: (alert: SnipeAlert) => Promise<TravelResult>;
  readonly onExit?: () => void;
  readonly now?: () => number;
}

export interface SnipeQueueAppProps {
  readonly alerts: readonly SnipeAlert[];
  readonly onTravel: (alert: SnipeAlert) => Promise<TravelResult>;
  readonly onExit?: () => void;
  readonly now?: () => number;
}

export interface SnipeConsoleHandle {
  addAlert(alert: SnipeAlert): void;
  waitUntilExit(): Promise<unknown>;
  close(): void;
}

export function renderSnipeConsole(
  opts: SnipeConsoleOptions,
  renderOpts?: RenderOptions,
): SnipeConsoleHandle;
```

Keep the accumulated alert list in the handle, call Ink's `rerender()` after external alerts, and keep lifecycle state in `SnipeQueueApp` through the pure reducer. The component ingests newly supplied alert IDs without resetting selection. Enter only begins `new`; `r` only begins `failed`; `d` dismisses; `q` exits. Show `NEW`, `TRAVELING`, `TRAVELED`, `FAILED`, label, item, price, margin/freshness, seller, and age. Prefix the selected row with `glyphs.select` and truncate through `fold()`.

- [ ] **Step 8: Run console and reducer tests and witness GREEN**

Run: `npx vitest run tests/snipe-console.test.tsx tests/snipe-selection.test.ts tests/snipe-queue.test.ts`

Expected: PASS.

- [ ] **Step 9: Commit Task 6**

```bash
git add src/snipe/console.tsx tests/snipe-console.test.tsx
git commit -m "feat: render interactive snipe console"
```

---

### Task 7: Connect Selection, WebSockets, Queue, and Manual Travel

**Files:**
- Modify: `src/snipe/run.ts`
- Modify: `src/cli.ts`
- Modify: `tests/simulate.test.ts`
- Create: `tests/snipe-run.test.ts`
- Modify: `vitest.config.ts`

**Interfaces:**
- Consumes: `resolveRequestedTargets`, `promptSnipeTargets`, `renderSnipeConsole`, `createTravelController`, existing pricing/decision/WebSocket functions.
- Produces: updated `SnipeFlags`; testable `runSnipe` dependencies for selection, console, controller, sockets, timers, and filesystem.

- [ ] **Step 1: Write a failing orchestration test that proves no arrival-triggered travel**

Use an injected fake socket boundary but real selection/decision logic:

```ts
test('a qualifying socket listing is queued but never travels until the console action', async () => {
  const harness = makeSnipeHarness({ selectedIds: ['abc123'] });
  const running = runSnipe({ ...FLAGS, all: false, searches: ['abc123'] }, harness.deps);
  await harness.emitListing(PROFITABLE_LISTING);
  expect(harness.consoleAlerts.map((a) => a.listingId)).toEqual(['listing-1']);
  expect(harness.travelCalls).toEqual([]);
  await harness.pressTravel('listing-1');
  expect(harness.travelCalls).toEqual(['listing-1']);
  harness.exit();
  await running;
});
```

The fake socket must emit the same `{ new: string[] }` shape as the real site and the listing fetch fixture must include every `LiveListing` field.

- [ ] **Step 2: Write a failing selected-search/socket-count test**

```ts
test('opens sockets only for searches enabled on this run', async () => {
  const harness = makeSnipeHarness({ targets: [TARGET_A, TARGET_B], selectedIds: ['aaa'] });
  const running = runSnipe({ ...FLAGS, all: false, searches: ['aaa'] }, harness.deps);
  await harness.started;
  expect(harness.openedSearchIds).toEqual(['aaa']);
  harness.exit();
  await running;
});
```

- [ ] **Step 3: Run orchestration tests and witness RED**

Run: `npx vitest run tests/snipe-run.test.ts`

Expected: FAIL because current `runSnipe` immediately dispatches travel and lacks injectable UI/socket boundaries.

- [ ] **Step 4: Extend flags and dependencies without hiding production defaults**

Use:

```ts
export interface SnipeFlags {
  readonly folder: string | undefined;
  readonly league: string | undefined;
  readonly keepLeague: boolean;
  readonly minMargin: string | undefined;
  readonly all: boolean;
  readonly searches: readonly string[];
}

export interface SnipeDeps {
  readonly config: ExiliumConfig;
  readonly repo: SnapshotRepository;
  readonly out: (message: string) => void;
  readonly log: (message: string) => void;
  readonly isTTY?: boolean;
  readonly promptTargets?: typeof promptSnipeTargets;
  readonly makeConsole?: typeof renderSnipeConsole;
  readonly makeTravelController?: typeof createTravelController;
  readonly openSocket?: OpenSnipeSocket;
  readonly fetchListings?: typeof fetchListings;
}
```

Defaults use the real functions. Do not inject pure pricing/decision code; exercise it in the orchestration test.

- [ ] **Step 5: Reorder startup around selection and queue**

Load all targets, resolve flag/non-TTY selection, invoke the picker only when it returns `null`, and connect only selected targets. League precedence is `--league`, then `config.snipe.league`, then the existing global/current-challenge resolver; the case-insensitive saved value `Current` means use current-challenge resolution. Create the console before sockets so the first event cannot be lost. Lazily create the travel controller on the first Enter action; if CDP is unavailable, return a failed result containing the `exilium chrome` recovery command while the socket queue continues.

- [ ] **Step 6: Remove all arrival-triggered action and clipboard behavior**

On qualifying listing:

```ts
consoleHandle.addAlert(alert);
void notifier.notify(rendered.title, rendered.body);
recordSnipe(alert, 'queued', 'waiting for Enter', log);
```

Do not call `copyToClipboard`, `dispatchTravel`, `openUrl`, or browser navigation here. The console's `onTravel` callback calls the controller once and records `traveled` or `failed` afterward. Remove `mode`, `autoTravel`, and `open` from `SnipeFlags`, help text, and normal startup copy.

- [ ] **Step 7: Add deterministic shutdown ownership**

Track sockets, reconnect timers, refresh timer, console, and controller. One idempotent cleanup function closes all sockets, clears timers, closes the Exilium page/controller, and unmounts the UI. Wire it to console `q`, Ctrl+C, and test harness exit. Do not terminate Chrome.

- [ ] **Step 8: Run orchestration tests and witness GREEN**

Run: `npx vitest run tests/snipe-run.test.ts`

Expected: PASS with no open handles.

- [ ] **Step 9: Update simulation expectations**

Simulation should still prove pricing/decision/notification behavior, but remove expectations that snipe copies a whisper or travels. Rename the test to state that a synthetic hit is queued/notified and never actuated.

- [ ] **Step 10: Include `run.ts` in coverage and run focused coverage**

Remove `src/snipe/run.ts` from the coverage exclusion only after the orchestration harness covers startup, event, and cleanup branches.

Run: `npx vitest run tests/snipe-run.test.ts tests/simulate.test.ts --coverage`

Expected: exit 0 and repository thresholds remain at least 80%.

- [ ] **Step 11: Commit Task 7**

```bash
git add src/snipe/run.ts src/cli.ts tests/snipe-run.test.ts tests/simulate.test.ts vitest.config.ts
git commit -m "feat: wire manual interactive snipe sessions"
```

---

### Task 8: CLI Integration, Windows Documentation, and E2E Harness

**Files:**
- Modify: `tests/cli-integration.test.ts`
- Modify: `src/cli.ts`
- Modify: `README.md`
- Modify: `examples/06-snipe-folder.md`
- Modify: `scripts/e2e-snipe.ts`

**Interfaces:**
- Consumes: real CLI process, filesystem import, non-TTY flags, live e2e browser controller.
- Produces: documented and executable Windows operator workflow.

- [ ] **Step 1: Write failing real-CLI import tests**

```ts
test('snipe import --file saves a Better Trading export without requiring POESESSID', async () => {
  const folder = join(dir, 'BetterTrading');
  const exportFile = join(dir, 'folder.bt');
  writeFileSync(exportFile, VALID_EXPORT);
  const { stdout } = await runWithEnv(
    { ...env, EXILIUM_BETTERTRADING: folder, EXILIUM_POESESSID: '' },
    'snipe', 'import', '--file', exportFile,
  );
  expect(stdout).toMatch(/Imported 1 search/);
  expect(readdirSync(folder)).toHaveLength(1);
});
```

- [ ] **Step 2: Write failing non-TTY safety tests**

```ts
test('non-TTY snipe refuses to enable every search implicitly', async () => {
  await expect(runWithEnv(snipeEnv, 'snipe')).rejects.toMatchObject({ stderr: expect.stringMatching(/--all|--search/) });
});
```

Add a `--search missing` error assertion. Give the process a dummy POESESSID and a local BetterTrading fixture; both assertions must fail during selection resolution, before socket startup, so the suite never opens real trade sockets.

- [ ] **Step 3: Run CLI integration tests and witness RED**

Run: `npx vitest run tests/cli-integration.test.ts`

Expected: new import/selection tests fail.

- [ ] **Step 4: Finish CLI parsing and help text**

Add a helper that collects repeated flags without swallowing the next command:

```ts
function flagValues(name: string): readonly string[] {
  return process.argv.flatMap((arg, index) => arg === name && process.argv[index + 1] !== undefined
    ? [process.argv[index + 1]!]
    : []);
}
```

Pass `all: process.argv.includes('--all')` and `searches: flagValues('--search')`. Help must state that interactive selection happens every run, Enter travels, Chrome uses one tab, and no whisper is sent.

- [ ] **Step 5: Run CLI tests and witness GREEN**

Run: `npx vitest run tests/cli-integration.test.ts`

Expected: PASS.

- [ ] **Step 6: Rewrite the operator documentation around Windows**

Document this exact sequence:

```powershell
exilium chrome
exilium snipe import
exilium snipe
```

Explain Better Trading folder Export → Copy → paste, per-run Space/Enter selection, live queue keys, `%LOCALAPPDATA%\Exilium\chrome-profile`, the one-tab invariant, `--all`/`--search` for noninteractive use, and CDP troubleshooting. Remove claims that whispers are copied or that arrival automatically travels.

- [ ] **Step 7: Adapt the e2e harness to the shared controller**

Replace its independent `launchPersistentContext` page with `createTravelController` or a read-only inspection adapter from the same browser module. Default remains no click. Add `--manual-click LISTING_ID` that prints a three-second warning and invokes the same controller method once; never pick the first listing implicitly.

- [ ] **Step 8: Run docs-adjacent build and focused tests**

Run: `npm run build`

Run: `npx vitest run tests/cli-integration.test.ts tests/snipe-console.test.tsx tests/snipe-browser.test.ts`

Run: `git diff --check`

Expected: all exit 0.

- [ ] **Step 9: Commit Task 8**

```bash
git add src/cli.ts tests/cli-integration.test.ts README.md examples/06-snipe-folder.md scripts/e2e-snipe.ts
git commit -m "docs: finish Windows interactive snipe workflow"
```

---

### Task 9: Completion Audit and Fresh Verification

**Files:**
- Inspect: all files listed above
- No planned modifications; a witnessed defect returns to the RED/GREEN steps and exact file list of its owning task

**Interfaces:**
- Consumes: completed implementation and the approved design specification.
- Produces: evidence for every requirement and a clean working tree limited to any pre-existing unrelated changes.

- [ ] **Step 1: Run the complete unit and integration suite**

Run: `npm test`

Expected: every test passes; zero unhandled errors and zero open-handle warnings.

- [ ] **Step 2: Run the production TypeScript build**

Run: `npm run build`

Expected: exit 0 with no diagnostics.

- [ ] **Step 3: Run full coverage**

Run: `npm run coverage`

Expected: lines, functions, branches, and statements each meet the configured 80% threshold.

- [ ] **Step 4: Check patch hygiene**

Run: `git diff --check`

Run: `git status --short`

Expected: no whitespace errors; status contains only intended task changes or clearly identified pre-existing user changes.

- [ ] **Step 5: Audit every explicit invariant with source/test evidence**

Verify and record:

1. `tests/snipe-selection.test.ts` proves selection starts empty every run.
2. `tests/snipe-run.test.ts` proves only selected searches open sockets.
3. `tests/snipe-run.test.ts` proves arrival queues but never travels.
4. `tests/snipe-console.test.tsx` proves Enter on the selected row is the action boundary.
5. `tests/snipe-browser.test.ts` proves two actions reuse one page and each action clicks at most once.
6. Source search `rg -n "copyToClipboard|whisper copied|auto-travel" src/snipe src/cli.ts README.md examples/06-snipe-folder.md` has no active interactive-snipe behavior or stale operator claims.
7. `tests/snipe-import.test.ts` and CLI integration prove extension exports and files import safely.
8. `tests/snipe-chrome.test.ts` proves Windows Chrome/Edge discovery and profile paths.
9. Cleanup tests prove Exilium closes its page/sockets/timers and leaves user Chrome running.

If any item lacks direct evidence, add the smallest failing test, witness RED, implement the fix, and rerun the full verification set.

- [ ] **Step 6: Perform the Windows manual checklist when a Windows host and PoE session are available**

Run the seven steps in `docs/superpowers/specs/2026-08-09-interactive-snipe-console-design.md` under “A Windows manual/e2e checklist.” Record unavailable external verification honestly; do not claim real hideout travel was verified from a non-Windows host.
