import { describe, expect, test, vi } from 'vitest';
import type { CatalogEntry } from '../src/snipe/catalog.js';
import type { SnipeAlert } from '../src/snipe/engine.js';
import { startSnipeRuntime } from '../src/snipe/runtime.js';
import { SnipeStore } from '../src/snipe/store.js';
import type { SnipeDeps, SnipeFlags } from '../src/snipe/run.js';

const TARGET: CatalogEntry = {
  key: 'trade:one', label: 'Target one', realm: 'trade', searchId: 'one', league: 'Allflame', enabled: true, source: 'Exilium',
};

const ALERT: SnipeAlert = {
  targetId: TARGET.key, targetLabel: TARGET.label, source: 'live', listingId: 'listing-one', itemName: 'Item one', priceText: '10 divine', seller: 'Seller', listedAt: null,
  searchUrl: 'https://www.pathofexile.com/trade/search/Allflame/one', listedChaos: 2_000, marginChaos: 500, marginPct: 25, marginText: '+500c (+25%)', freshnessText: 'ref 1m ago', stale: false,
  unknownMargin: false, minMarginPct: 20, targetMinMarginPct: null, qualifiesMargin: true,
};

const FLAGS: SnipeFlags = { folder: undefined, league: undefined, keepLeague: false, minMargin: undefined, all: true, searches: [] };

describe('startSnipeRuntime', () => {
  test('gone removes the best candidate and promotes the backup without auto-travel', async () => {
    const store = new SnipeStore([TARGET], { minMarginPct: 20 });
    const gone = vi.fn(async () => ({ action: 'gone' as const, detail: 'listing sold' }));
    const run = async (_flags: SnipeFlags, deps: SnipeDeps): Promise<void> => {
      const view = deps.makeConsole!({ onTravel: gone });
      view.addAlert({ ...ALERT, listingId: 'backup', marginPct: 25 });
      view.addAlert({ ...ALERT, listingId: 'best', marginPct: 35 });
      await view.waitUntilExit();
    };
    const runtime = await startSnipeRuntime({ flags: FLAGS, store }, { run });

    await runtime.travel('best');
    expect(store.snapshot().board.groups[0]?.best?.alert.listingId).toBe('backup');
    expect(gone).toHaveBeenCalledTimes(1);
    expect(store.snapshot().queue.notice).toMatch(/sold|removed/i);
    await runtime.stop();
  });
  test('publishes alerts and travel lifecycle through a renderer-independent store', async () => {
    const store = new SnipeStore([TARGET], { minMarginPct: 20 });
    const travel = vi.fn(async () => ({ action: 'traveled' as const, detail: 'clicked Travel to Hideout' }));
    const run = vi.fn(async (_flags: SnipeFlags, deps: SnipeDeps) => {
      const view = deps.makeConsole!({ onTravel: travel });
      view.addAlert(ALERT);
      await view.waitUntilExit();
      view.close();
    });

    const runtime = await startSnipeRuntime({ flags: FLAGS, store }, { run });
    expect(store.snapshot().queue.entries.map((entry) => entry.alert.listingId)).toEqual(['listing-one']);

    await runtime.travel('listing-one');
    expect(store.snapshot().queue.entries[0]?.status).toBe('traveled');
    await runtime.stop();
  });

  test('stop resolves when the headless run is waiting for exit', async () => {
    const store = new SnipeStore([TARGET]);
    const run = async (_flags: SnipeFlags, deps: SnipeDeps): Promise<void> => {
      await deps.makeConsole!({ onTravel: async () => ({ action: 'failed', detail: 'unused' }) }).waitUntilExit();
    };
    const runtime = await startSnipeRuntime({ flags: FLAGS, store }, { run });
    await expect(runtime.stop()).resolves.toBeUndefined();
  });
});
