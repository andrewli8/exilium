import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, test, vi } from 'vitest';
import { loadConfig } from '../src/config.js';
import type { MarketSnapshot } from '../src/domain/types.js';
import { saveSnipeManifest, type SnipeManifest } from '../src/snipe/catalog.js';
import type { CatalogEntry } from '../src/snipe/catalog.js';
import { SnipeStore } from '../src/snipe/store.js';
import type { SnipeConsoleOptions } from '../src/snipe/console.js';
import type { SnipeAlert } from '../src/snipe/engine.js';
import { runSnipe, snipeStartupMessages, type OpenSnipeSocket, type SnipeDeps, type SnipeFlags } from '../src/snipe/run.js';
import type { LiveListing, TradeSearch } from '../src/trade/live-search.js';
import { RateLimitError } from '../src/trade/rate-limit.js';

const NOW = Date.parse('2026-08-09T12:00:00Z');
const SNAPSHOTS: readonly MarketSnapshot[] = [{
  game: 'poe1',
  league: 'Allflame',
  category: 'UniqueAccessory',
  fetchedAt: new Date(NOW - 60_000).toISOString(),
  core: { primary: 'chaos', perPrimary: { chaos: 1, divine: 0.005 } },
  lines: [{
    itemId: 'mageblood',
    name: 'Mageblood',
    category: 'UniqueAccessory',
    primaryValue: 40_000,
    volumePrimaryValue: 1_000,
    maxVolumeCurrency: null,
    maxVolumeRate: null,
    sparkline: [],
    totalChange: 0,
  }],
}];

const LISTING: LiveListing = {
  id: 'listing-1',
  itemName: 'Mageblood Heavy Belt',
  referenceName: 'Mageblood',
  priceText: '150 divine',
  price: { amount: 150, currency: 'divine' },
  listedAt: '2026-08-09T11:59:00Z',
  seller: 'Valdo_Enjoyer',
  whisper: '@Valdo_Enjoyer Hi, I would like to buy your Mageblood',
};

const FLAGS: SnipeFlags = {
  folder: undefined,
  league: undefined,
  keepLeague: false,
  minMargin: undefined,
  all: false,
  searches: ['aaa'],
};

class FakeSocket {
  private readonly listeners = new Map<string, Array<(...args: never[]) => void>>();
  closed = false;

  on(event: string, listener: (...args: never[]) => void): this {
    const listeners = this.listeners.get(event) ?? [];
    listeners.push(listener);
    this.listeners.set(event, listeners);
    return this;
  }

  emit(event: string, ...args: unknown[]): void {
    for (const listener of this.listeners.get(event) ?? []) listener(...args as never[]);
  }

  close(): void {
    this.closed = true;
  }
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => { resolve = done; });
  return { promise, resolve };
}

function makeHarness(options: {
  readonly emptyFolder?: boolean;
  readonly promptImport?: () => Promise<string | null>;
  readonly globalLeague?: string;
  readonly snipeLeague?: string;
  readonly snipeMinMargin?: number;
  readonly seedIds?: readonly string[];
  readonly manifest?: SnipeManifest;
  readonly store?: SnipeStore;
} = {}) {
  const folder = mkdtempSync(join(tmpdir(), 'exilium-run-'));
  if (options.emptyFolder !== true) {
    writeFileSync(join(folder, 'targets.json'), JSON.stringify({ targets: [
      { label: 'Currency', slug: 'aaa' },
      { label: 'Uniques', slug: 'bbb' },
    ] }));
  }
  if (options.manifest !== undefined) saveSnipeManifest(folder, options.manifest);
  const config = loadConfig({}, {
    game: 'poe1',
    league: options.globalLeague ?? 'Allflame',
    poesessid: 'test-session',
    snipe: {
      folder,
      chromeCdpUrl: 'http://127.0.0.1:9222',
      ...(options.snipeMinMargin === undefined ? {} : { minMarginPct: options.snipeMinMargin }),
      ...(options.snipeLeague === undefined ? {} : { league: options.snipeLeague }),
    },
  });
  const sockets = new Map<string, FakeSocket>();
  const openedSearchIds: string[] = [];
  const openedSearches: TradeSearch[] = [];
  const consoleAlerts: SnipeAlert[] = [];
  const travelCalls: string[] = [];
  const openedPages: string[] = [];
  const consoleExit = deferred<void>();
  const consoleReady = deferred<void>();
  const started = deferred<void>();
  let consoleOptions: SnipeConsoleOptions | undefined;
  let consoleCloseCalls = 0;
  let controllerCloseCalls = 0;
  let controllerCreateCalls = 0;
  const notify = vi.fn().mockResolvedValue(undefined);
  const seedCalls: string[] = [];
  const records: Array<{ listingId: string; action: string; detail: string }> = [];

  const openSocket: OpenSnipeSocket = (search) => {
    const socket = new FakeSocket();
    sockets.set(search.searchId, socket);
    openedSearchIds.push(search.searchId);
    openedSearches.push(search);
    queueMicrotask(() => socket.emit('open'));
    started.resolve();
    return socket;
  };

  const deps: SnipeDeps = {
    config,
    repo: { latestAll: () => SNAPSHOTS } as SnipeDeps['repo'],
    out: () => undefined,
    log: () => undefined,
    isTTY: options.emptyFolder === true,
    ...(options.promptImport === undefined ? {} : { promptImport: options.promptImport }),
    openSocket,
    fetchListings: async (ids: readonly string[], _search: TradeSearch) => ids.map((id) => ({ ...LISTING, id })),
    fetchCurrentResultIds: async (search: TradeSearch) => {
      seedCalls.push(search.searchId);
      return options.seedIds ?? [];
    },
    refreshPrices: async () => undefined,
    notify,
    recordAlert: (alert, action, detail) => records.push({ listingId: alert.listingId, action, detail }),
    now: () => NOW,
    connectStaggerMs: 0,
    fetchLeagues: async () => ['Standard', 'Allflame'],
    makeConsole: (options) => {
      consoleOptions = options;
      consoleReady.resolve();
      return {
        addAlert: (alert) => consoleAlerts.push(alert),
        waitUntilExit: () => consoleExit.promise,
        close: () => { consoleCloseCalls += 1; },
      };
    },
    makeTravelController: async () => {
      controllerCreateCalls += 1;
      return {
        openSearch: async (url) => { openedPages.push(url); },
        travel: async (alert) => {
          travelCalls.push(alert.listingId);
          return { action: 'traveled', detail: `clicked Travel to Hideout for ${alert.itemName}` };
        },
        close: async () => { controllerCloseCalls += 1; },
      };
    },
    ...(options.store === undefined ? {} : { store: options.store }),
  };

  return {
    deps,
    sockets,
    openedSearchIds,
    openedSearches,
    consoleAlerts,
    travelCalls,
    openedPages,
    notify,
    seedCalls,
    records,
    get consoleOptions() { return consoleOptions; },
    get consoleCloseCalls() { return consoleCloseCalls; },
    get controllerCloseCalls() { return controllerCloseCalls; },
    get controllerCreateCalls() { return controllerCreateCalls; },
    started: started.promise,
    consoleReady: consoleReady.promise,
    async emitListing(searchId = 'aaa', listingId = 'listing-1') {
      sockets.get(searchId)!.emit('message', Buffer.from(JSON.stringify({ new: [listingId] })));
      await new Promise((resolve) => setTimeout(resolve, 0));
    },
    async waitForAlerts(count: number) {
      for (let attempt = 0; attempt < 20 && consoleAlerts.length < count; attempt += 1) {
        await new Promise((resolve) => setTimeout(resolve, 0));
      }
    },
    async pressTravel() {
      return consoleOptions!.onTravel(consoleAlerts[0]!);
    },
    exit() {
      consoleOptions?.onExit?.();
      consoleExit.resolve();
    },
  };
}

describe('runSnipe orchestration', () => {
  test('provides the standalone renderer with the shared search store', async () => {
    const harness = makeHarness();
    const running = runSnipe(FLAGS, harness.deps);
    await harness.consoleReady;
    expect(harness.consoleOptions?.store?.snapshot().board.groups.map((group) => group.targetId)).toEqual(['trade:aaa']);
    harness.exit();
    await running;
  });
  test('publishes live connection and seed progress into a shared store', async () => {
    const target: CatalogEntry = {
      key: 'trade:aaa', label: 'Currency', realm: 'trade', searchId: 'aaa', league: null, enabled: true, source: 'Better Trading',
    };
    const store = new SnipeStore([target], { minMarginPct: 20 });
    const harness = makeHarness({ store, seedIds: ['seed-one'] });
    const running = runSnipe(FLAGS, harness.deps);
    await harness.started;
    await harness.waitForAlerts(1);

    expect(store.snapshot().searches[0]?.state).toBe('live');
    expect(store.snapshot().progress).toEqual({ seeded: 1, total: 1 });
    expect(store.snapshot().queue.entries.map((entry) => entry.alert.listingId)).toEqual(['seed-one']);
    harness.exit();
    await running;
  });
  test('runtime excludes disabled imports and includes enabled managed targets', async () => {
    const harness = makeHarness({
      manifest: {
        version: 1,
        managed: [{ label: 'Managed', realm: 'trade', searchId: 'ccc', league: null }],
        overrides: { 'trade:aaa': { enabled: false } },
      },
    });
    const running = runSnipe({ ...FLAGS, all: true, searches: [] }, harness.deps);
    await harness.started;
    expect(harness.openedSearchIds).toEqual(['bbb', 'ccc']);
    harness.exit();
    await running;
  });

  test('startup guidance promises headless monitoring and lazy Chrome', () => {
    expect(snipeStartupMessages(6, 'Allflame', null)).toEqual([
      'Exilium snipe — 6 enabled searches · league Allflame · min margin off',
      'Monitoring is headless. Current results seed quietly; new live hits notify.',
      'Chrome is only needed after you press Enter to travel; no whisper is sent or copied.',
    ]);
  });

  test('starts monitoring headlessly and creates Chrome only after Enter', async () => {
    const harness = makeHarness();
    const running = runSnipe(FLAGS, harness.deps);
    await harness.started;
    expect(harness.controllerCreateCalls).toBe(0);
    expect(harness.openedPages).toEqual([]);
    await harness.emitListing();
    await harness.pressTravel();
    expect(harness.controllerCreateCalls).toBe(1);
    harness.exit();
    await running;
  });

  test('passes compact board metadata to the console', async () => {
    const harness = makeHarness();
    const running = runSnipe(FLAGS, harness.deps);
    await harness.started;
    expect(harness.consoleOptions).toMatchObject({ searchCount: 1, minMarginPct: 20 });
    harness.exit();
    await running;
  });

  test('seeds current results quietly and notifies only later live listings', async () => {
    const harness = makeHarness({ seedIds: ['seed-1'] });
    const running = runSnipe(FLAGS, harness.deps);
    await harness.started;
    await harness.waitForAlerts(1);
    expect(harness.seedCalls).toEqual(['aaa']);
    expect(harness.consoleAlerts.map((alert) => alert.listingId)).toEqual(['seed-1']);
    expect(harness.consoleAlerts[0]?.source).toBe('current');
    expect(harness.notify).not.toHaveBeenCalled();

    await harness.emitListing('aaa', 'live-1');
    expect(harness.consoleAlerts.map((alert) => alert.listingId)).toEqual(['seed-1', 'live-1']);
    expect(harness.consoleAlerts[1]?.source).toBe('live');
    expect(harness.notify).toHaveBeenCalledTimes(1);
    harness.exit();
    await running;
  });

  test('queues below-floor live candidates for hidden counts without notifying', async () => {
    const harness = makeHarness({ snipeMinMargin: 30 });
    const running = runSnipe(FLAGS, harness.deps);
    await harness.started;
    await harness.emitListing('aaa', 'below-floor');
    expect(harness.consoleAlerts).toHaveLength(1);
    expect(harness.consoleAlerts[0]).toMatchObject({
      listingId: 'below-floor',
      source: 'live',
      minMarginPct: 30,
      qualifiesMargin: false,
    });
    expect(harness.notify).not.toHaveBeenCalled();
    harness.exit();
    await running;
  });

  test('deduplicates an id present in both startup seed and live socket', async () => {
    const harness = makeHarness({ seedIds: ['same-id'] });
    const running = runSnipe(FLAGS, harness.deps);
    await harness.started;
    await harness.waitForAlerts(1);
    await harness.emitListing('aaa', 'same-id');
    expect(harness.consoleAlerts.map((alert) => alert.listingId)).toEqual(['same-id']);
    expect(harness.notify).not.toHaveBeenCalled();
    harness.exit();
    await running;
  });

  test('caps a startup seed at ten current listings', async () => {
    const ids = Array.from({ length: 12 }, (_, index) => `seed-${index}`);
    const harness = makeHarness({ seedIds: ids });
    const running = runSnipe(FLAGS, harness.deps);
    await harness.started;
    await harness.waitForAlerts(10);
    expect(harness.consoleAlerts).toHaveLength(10);
    expect(harness.consoleAlerts.map((alert) => alert.listingId)).toEqual(ids.slice(0, 10));
    harness.exit();
    await running;
  });

  test('waits and retries a rate-limited startup seed', async () => {
    const harness = makeHarness();
    let attempts = 0;
    const running = runSnipe(FLAGS, {
      ...harness.deps,
      fetchCurrentResultIds: async () => {
        attempts += 1;
        if (attempts === 1) throw new RateLimitError(0);
        return ['after-limit'];
      },
    });
    await harness.started;
    await harness.waitForAlerts(1);
    expect(attempts).toBe(2);
    expect(harness.consoleAlerts[0]?.listingId).toBe('after-limit');
    harness.exit();
    await running;
  });

  test('does not permanently lose an id when its first detail fetch fails', async () => {
    const harness = makeHarness();
    let attempts = 0;
    const running = runSnipe(FLAGS, {
      ...harness.deps,
      fetchListings: async (ids) => {
        attempts += 1;
        if (attempts === 1) throw new Error('temporary fetch failure');
        return ids.map((id) => ({ ...LISTING, id }));
      },
    });
    await harness.started;
    await harness.emitListing('aaa', 'retry-me');
    await harness.emitListing('aaa', 'retry-me');
    expect(harness.consoleAlerts.map((alert) => alert.listingId)).toEqual(['retry-me']);
    harness.exit();
    await running;
  });

  test('a qualifying listing is queued and never travels until the console action', async () => {
    const harness = makeHarness();
    const running = runSnipe(FLAGS, harness.deps);
    await harness.started;
    await harness.emitListing();
    expect(harness.consoleAlerts.map((alert) => alert.listingId)).toEqual(['listing-1']);
    expect(harness.travelCalls).toEqual([]);
    await harness.pressTravel();
    expect(harness.travelCalls).toEqual(['listing-1']);
    harness.exit();
    await running;
    expect(harness.consoleCloseCalls).toBe(1);
    expect(harness.controllerCloseCalls).toBe(1);
    expect([...harness.sockets.values()].every((socket) => socket.closed)).toBe(true);
  });

  test('opens sockets only for enabled searches without opening a browser page', async () => {
    const harness = makeHarness();
    const running = runSnipe(FLAGS, harness.deps);
    await harness.started;
    expect(harness.openedSearchIds).toEqual(['aaa']);
    expect(harness.openedPages).toEqual([]);
    harness.exit();
    await running;
  });

  test('an empty interactive folder retries invalid paste and imports a Better Trading export', async () => {
    const payload = Buffer.from(JSON.stringify({
      tit: 'Imported',
      trs: [{ tit: 'Currency', loc: '1:search:aaa' }],
    })).toString('base64');
    const pasted = ['3:not-json', `3:${payload}`];
    const promptImport = vi.fn(async () => pasted.shift() ?? null);
    const harness = makeHarness({ emptyFolder: true, promptImport });
    const running = runSnipe(FLAGS, harness.deps);
    await harness.started;
    expect(promptImport).toHaveBeenCalledTimes(2);
    expect(harness.openedSearchIds).toEqual(['aaa']);
    harness.exit();
    await running;
  });

  test('saved Current ignores a stale global league and resolves the current challenge', async () => {
    const harness = makeHarness({ globalLeague: 'Standard', snipeLeague: 'cUrReNt' });
    const running = runSnipe(FLAGS, harness.deps);
    await harness.started;
    expect(harness.openedSearches[0]?.league).toBe('Allflame');
    expect(harness.openedPages).toEqual([]);
    harness.exit();
    await running;
  });

  test('shutdown prevents an in-flight listing fetch from enqueueing after q', async () => {
    const gate = deferred<readonly LiveListing[]>();
    const harness = makeHarness();
    const running = runSnipe(FLAGS, { ...harness.deps, fetchListings: async () => gate.promise });
    await harness.started;
    await harness.emitListing();
    harness.exit();
    gate.resolve([LISTING]);
    await running;
    expect(harness.consoleAlerts).toEqual([]);
  });

  test('shutdown prevents an in-flight startup seed from enqueueing', async () => {
    const gate = deferred<readonly string[]>();
    const harness = makeHarness();
    const running = runSnipe(FLAGS, { ...harness.deps, fetchCurrentResultIds: async () => gate.promise });
    await harness.started;
    harness.exit();
    gate.resolve(['too-late']);
    await running;
    expect(harness.consoleAlerts).toEqual([]);
  });

  test('q during a lazy CDP attach returns and closes a controller that resolves late', async () => {
    const gate = deferred<Awaited<ReturnType<NonNullable<SnipeDeps['makeTravelController']>>>>();
    const close = vi.fn(async () => undefined);
    const harness = makeHarness();
    const running = runSnipe(FLAGS, {
      ...harness.deps,
      shutdownTimeoutMs: 5,
      makeTravelController: async () => gate.promise,
    });
    await harness.started;
    await harness.emitListing();
    void harness.pressTravel();
    await Promise.resolve();
    harness.exit();
    await running;
    gate.resolve({
      openSearch: async () => undefined,
      travel: async () => ({ action: 'failed', detail: 'unused' }),
      close,
    });
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(close).toHaveBeenCalledTimes(1);
  });

  test('Chrome errors return short UI guidance while recording full technical detail', async () => {
    const technical = 'Chrome unavailable at http://127.0.0.1:9222: connect ECONNREFUSED';
    const harness = makeHarness();
    const running = runSnipe(FLAGS, {
      ...harness.deps,
      makeTravelController: async () => { throw new Error(technical); },
    });
    await harness.started;
    await harness.emitListing();
    const result = await harness.pressTravel();
    expect(result).toEqual({
      action: 'failed',
      detail: 'Chrome unavailable — run `exilium chrome`, log into pathofexile.com, then press Enter again',
      technicalDetail: technical,
    });
    expect(harness.records.at(-1)).toEqual({ listingId: 'listing-1', action: 'failed', detail: technical });
    harness.exit();
    await running;
  });

  test('shutdown is bounded when an injected listing fetch ignores AbortSignal forever', async () => {
    const harness = makeHarness();
    const never = new Promise<readonly LiveListing[]>(() => undefined);
    const running = runSnipe(FLAGS, {
      ...harness.deps,
      shutdownTimeoutMs: 5,
      fetchListings: async () => never,
    });
    await harness.started;
    await harness.emitListing();
    harness.exit();
    await expect(running).resolves.toBeUndefined();
    expect(harness.consoleAlerts).toEqual([]);
  });
});
