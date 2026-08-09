import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, test, vi } from 'vitest';
import { loadConfig } from '../src/config.js';
import type { MarketSnapshot } from '../src/domain/types.js';
import type { SnipeConsoleOptions } from '../src/snipe/console.js';
import type { SnipeAlert } from '../src/snipe/engine.js';
import { runSnipe, type OpenSnipeSocket, type SnipeDeps, type SnipeFlags } from '../src/snipe/run.js';
import type { LiveListing, TradeSearch } from '../src/trade/live-search.js';

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

function makeHarness() {
  const folder = mkdtempSync(join(tmpdir(), 'exilium-run-'));
  writeFileSync(join(folder, 'targets.json'), JSON.stringify({ targets: [
    { label: 'Currency', slug: 'aaa' },
    { label: 'Uniques', slug: 'bbb' },
  ] }));
  const config = loadConfig({}, {
    game: 'poe1',
    league: 'Allflame',
    poesessid: 'test-session',
    snipe: { folder, chromeCdpUrl: 'http://127.0.0.1:9222' },
  });
  const sockets = new Map<string, FakeSocket>();
  const openedSearchIds: string[] = [];
  const consoleAlerts: SnipeAlert[] = [];
  const travelCalls: string[] = [];
  const openedPages: string[] = [];
  const consoleExit = deferred<void>();
  const started = deferred<void>();
  let consoleOptions: SnipeConsoleOptions | undefined;
  let consoleCloseCalls = 0;
  let controllerCloseCalls = 0;

  const openSocket: OpenSnipeSocket = (search) => {
    const socket = new FakeSocket();
    sockets.set(search.searchId, socket);
    openedSearchIds.push(search.searchId);
    queueMicrotask(() => socket.emit('open'));
    started.resolve();
    return socket;
  };

  const deps: SnipeDeps = {
    config,
    repo: { latestAll: () => SNAPSHOTS } as SnipeDeps['repo'],
    out: () => undefined,
    log: () => undefined,
    isTTY: false,
    openSocket,
    fetchListings: async (_ids: readonly string[], _search: TradeSearch) => [LISTING],
    refreshPrices: async () => undefined,
    notify: vi.fn().mockResolvedValue(undefined),
    recordAlert: () => undefined,
    now: () => NOW,
    connectStaggerMs: 0,
    makeConsole: (options) => {
      consoleOptions = options;
      return {
        addAlert: (alert) => consoleAlerts.push(alert),
        waitUntilExit: () => consoleExit.promise,
        close: () => { consoleCloseCalls += 1; },
      };
    },
    makeTravelController: async () => ({
      openSearch: async (url) => { openedPages.push(url); },
      travel: async (alert) => {
        travelCalls.push(alert.listingId);
        return { action: 'traveled', detail: `clicked Travel to Hideout for ${alert.itemName}` };
      },
      close: async () => { controllerCloseCalls += 1; },
    }),
  };

  return {
    deps,
    sockets,
    openedSearchIds,
    consoleAlerts,
    travelCalls,
    openedPages,
    get consoleCloseCalls() { return consoleCloseCalls; },
    get controllerCloseCalls() { return controllerCloseCalls; },
    started: started.promise,
    async emitListing(searchId = 'aaa') {
      sockets.get(searchId)!.emit('message', Buffer.from(JSON.stringify({ new: ['listing-1'] })));
      await new Promise((resolve) => setTimeout(resolve, 0));
    },
    async pressTravel() {
      await consoleOptions!.onTravel(consoleAlerts[0]!);
    },
    exit() {
      consoleExit.resolve();
    },
  };
}

describe('runSnipe orchestration', () => {
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

  test('opens sockets only for enabled searches and opens the first one in the reusable tab', async () => {
    const harness = makeHarness();
    const running = runSnipe(FLAGS, harness.deps);
    await harness.started;
    expect(harness.openedSearchIds).toEqual(['aaa']);
    expect(harness.openedPages).toEqual([
      'https://www.pathofexile.com/trade/search/Allflame/aaa',
    ]);
    harness.exit();
    await running;
  });
});
