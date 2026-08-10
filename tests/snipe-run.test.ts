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
import { TradeRateLimiter } from '../src/trade/rate-limit.js';
import { TradeRequestScheduler } from '../src/trade/request-scheduler.js';

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
  readonly scheduler?: TradeRequestScheduler;
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
  const events: string[] = [];

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
    out: (message) => events.push(`out:${message}`),
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
    probeChrome: async () => false,
    notify,
    recordAlert: (alert, action, detail) => records.push({ listingId: alert.listingId, action, detail }),
    now: () => NOW,
    connectStaggerMs: 0,
    fetchLeagues: async () => ['Standard', 'Allflame'],
    makeConsole: (options) => {
      events.push('console');
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
    ...(options.scheduler === undefined ? {} : { scheduler: options.scheduler }),
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
    events,
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
  test('publishes shared trade cooldown health into the snipe store', async () => {
    const limiter = new TradeRateLimiter(() => 0);
    limiter.observe(new Response('{}', { status: 200, headers: {
      'X-Rate-Limit-Rules': 'Ip',
      'X-Rate-Limit-Ip': '1:5:60',
      'X-Rate-Limit-Ip-State': '1:5:0',
    } }));
    const scheduler = new TradeRequestScheduler({ limiter, wait: async () => undefined });
    const target: CatalogEntry = {
      key: 'trade:aaa', label: 'Currency', realm: 'trade', searchId: 'aaa', league: null, enabled: true, source: 'Better Trading',
    };
    const store = new SnipeStore([target]);
    const harness = makeHarness({ store, scheduler });

    const running = runSnipe(FLAGS, harness.deps);
    await harness.consoleReady;

    expect(store.snapshot().status).toBe('COOLDOWN 5s');
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

  test('prints startup guidance before rendering and keeps socket status inside Ink', async () => {
    const harness = makeHarness();
    const running = runSnipe(FLAGS, harness.deps);
    await harness.started;

    const consoleIndex = harness.events.indexOf('console');
    expect(consoleIndex).toBeGreaterThan(0);
    expect(harness.events.slice(0, consoleIndex).every((event) => event.startsWith('out:'))).toBe(true);
    expect(harness.events.slice(consoleIndex + 1)).toEqual([]);

    harness.exit();
    await running;
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
    expect(harness.consoleOptions).toMatchObject({ searchCount: 1, minMarginPct: 0 });
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

describe('runSnipe travel recovery', () => {
  test('a dead cached travel tab is replaced with a fresh one on the same Enter', async () => {
    const harness = makeHarness();
    let controllers = 0;
    const travels: string[] = [];
    const running = runSnipe(FLAGS, {
      ...harness.deps,
      makeTravelController: async () => {
        controllers += 1;
        const stale = controllers === 1;
        return {
          openSearch: async () => undefined,
          travel: async (alert) => {
            travels.push(`${controllers}:${alert.listingId}`);
            return stale
              ? { action: 'failed', detail: 'Chrome CDP page connection is closed' }
              : { action: 'traveled', detail: `clicked Travel to Hideout for ${alert.itemName}` };
          },
          close: async () => undefined,
        };
      },
    });
    await harness.started;
    await harness.emitListing();
    const result = await harness.pressTravel();
    expect(result.action).toBe('traveled');
    expect(controllers).toBe(2);
    expect(travels).toEqual(['1:listing-1', '2:listing-1']);
    harness.exit();
    await running;
  });
});

describe('runSnipe browser-live mode', () => {
  function browserLiveHarness() {
    const target: CatalogEntry = {
      key: 'trade:aaa', label: 'Currency', realm: 'trade', searchId: 'aaa', league: null, enabled: true, source: 'Better Trading',
    };
    const store = new SnipeStore([target], { minMarginPct: 20 });
    const harness = makeHarness({ store });
    const opened: Array<{ search: TradeSearch; cdpUrl: string }> = [];
    const clicks: string[] = [];
    const tabClosed = { count: 0 };
    let emitListings: ((listings: readonly LiveListing[], source: 'seed' | 'live') => void) | undefined;
    let disconnect: (() => void) | undefined;
    const openLiveSearch: NonNullable<SnipeDeps['openLiveSearch']> = async (options) => {
      opened.push({ search: options.search, cdpUrl: options.cdpUrl });
      emitListings = options.onListings;
      disconnect = options.onDisconnect;
      return {
        page: {
          url: () => `https://www.pathofexile.com/trade/search/Allflame/aaa/live`,
          goto: async () => { throw new Error('the capture tab must never navigate'); },
          clickTravelButton: async (listingId: string) => { clicks.push(listingId); return 'clicked' as const; },
          close: async () => { tabClosed.count += 1; },
        },
        close: async () => { tabClosed.count += 1; },
      };
    };
    return {
      ...harness,
      store,
      opened,
      clicks,
      tabClosed,
      deps: { ...harness.deps, openLiveSearch } satisfies SnipeDeps,
      emit: (listings: readonly LiveListing[], source: 'seed' | 'live') => emitListings?.(listings, source),
      disconnect: () => disconnect?.(),
    };
  }

  test('opens live tabs instead of sockets or API seeds and ingests captured listings', async () => {
    const harness = browserLiveHarness();
    const running = runSnipe({ ...FLAGS, browserLive: true }, harness.deps);
    await harness.consoleReady;
    for (let i = 0; i < 20 && harness.store.snapshot().searches[0]?.state !== 'live'; i += 1) await new Promise((r) => setTimeout(r, 0));

    expect(harness.opened).toEqual([{
      search: { realm: 'trade', league: 'Allflame', searchId: 'aaa' },
      cdpUrl: 'http://127.0.0.1:9222',
    }]);
    expect(harness.openedSearchIds).toEqual([]);
    expect(harness.seedCalls).toEqual([]);
    expect(harness.store.snapshot().searches[0]?.state).toBe('live');

    harness.emit([LISTING], 'live');
    await harness.waitForAlerts(1);
    expect(harness.consoleAlerts.map((alert) => alert.listingId)).toEqual(['listing-1']);
    expect(harness.consoleAlerts[0]?.source).toBe('live');
    expect(harness.notify).toHaveBeenCalledTimes(1);

    harness.exit();
    await running;
    expect(harness.tabClosed.count).toBeGreaterThan(0);
  });

  test('seed captures queue quietly and repeats are deduped', async () => {
    const harness = browserLiveHarness();
    const running = runSnipe({ ...FLAGS, browserLive: true }, harness.deps);
    await harness.consoleReady;
    for (let i = 0; i < 20 && harness.opened.length === 0; i += 1) await new Promise((r) => setTimeout(r, 0));

    harness.emit([LISTING], 'seed');
    harness.emit([LISTING], 'live');
    await harness.waitForAlerts(1);
    expect(harness.consoleAlerts).toHaveLength(1);
    expect(harness.consoleAlerts[0]?.source).toBe('current');
    expect(harness.notify).not.toHaveBeenCalled();

    harness.exit();
    await running;
  });

  test('Enter travels inside the already-open live tab without a controller', async () => {
    const harness = browserLiveHarness();
    const running = runSnipe({ ...FLAGS, browserLive: true }, harness.deps);
    await harness.consoleReady;
    for (let i = 0; i < 20 && harness.opened.length === 0; i += 1) await new Promise((r) => setTimeout(r, 0));

    harness.emit([LISTING], 'live');
    await harness.waitForAlerts(1);
    const result = await harness.pressTravel();
    expect(result.action).toBe('traveled');
    expect(harness.clicks).toEqual(['listing-1']);
    expect(harness.controllerCreateCalls).toBe(0);

    harness.exit();
    await running;
  });

  test('a dropped tab marks the search stopped with recovery guidance', async () => {
    const harness = browserLiveHarness();
    const running = runSnipe({ ...FLAGS, browserLive: true }, harness.deps);
    await harness.consoleReady;
    for (let i = 0; i < 20 && harness.opened.length === 0; i += 1) await new Promise((r) => setTimeout(r, 0));

    harness.disconnect();
    expect(harness.store.snapshot().searches[0]?.state).toBe('stopped');
    expect(harness.store.snapshot().searches[0]?.detail).toMatch(/exilium chrome/);

    harness.exit();
    await running;
  });

  test('auto mode picks browser-live when Chrome answers the probe', async () => {
    const harness = browserLiveHarness();
    const running = runSnipe(FLAGS, { ...harness.deps, probeChrome: async () => true });
    await harness.consoleReady;
    for (let i = 0; i < 20 && harness.opened.length === 0; i += 1) await new Promise((r) => setTimeout(r, 0));
    expect(harness.opened).toHaveLength(1);
    expect(harness.openedSearchIds).toEqual([]);
    expect(harness.seedCalls).toEqual([]);
    harness.exit();
    await running;
  });

  test('auto mode falls back to API sockets when Chrome is not running', async () => {
    const harness = browserLiveHarness();
    const running = runSnipe(FLAGS, harness.deps); // harness probe answers false
    await harness.started;
    expect(harness.openedSearchIds).toEqual(['aaa']);
    expect(harness.opened).toEqual([]);
    harness.exit();
    await running;
  });

  test('--no-browser-live wins over a reachable Chrome', async () => {
    const harness = browserLiveHarness();
    const running = runSnipe({ ...FLAGS, browserLive: false }, { ...harness.deps, probeChrome: async () => true });
    await harness.started;
    expect(harness.openedSearchIds).toEqual(['aaa']);
    expect(harness.opened).toEqual([]);
    harness.exit();
    await running;
  });

  test('browser-live does not require a POESESSID', async () => {
    const harness = browserLiveHarness();
    const config = loadConfig({}, {
      game: 'poe1',
      league: 'Allflame',
      snipe: { folder: harness.deps.config.snipe.folder!, chromeCdpUrl: 'http://127.0.0.1:9222' },
    });
    const running = runSnipe({ ...FLAGS, browserLive: true }, { ...harness.deps, config });
    await harness.consoleReady;
    harness.exit();
    await expect(running).resolves.toBeUndefined();
  });
});
