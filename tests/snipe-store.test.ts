import { describe, expect, test } from 'vitest';
import type { CatalogEntry } from '../src/snipe/catalog.js';
import type { SnipeAlert } from '../src/snipe/engine.js';
import { SnipeStore } from '../src/snipe/store.js';

function target(id: string): CatalogEntry {
  return {
    key: `trade:${id}`,
    label: `Target ${id}`,
    realm: 'trade',
    searchId: id,
    league: 'Allflame',
    enabled: true,
    source: 'Exilium',
  };
}

function alert(id: string, overrides: Partial<SnipeAlert> = {}): SnipeAlert {
  return {
    targetId: `trade:${id}`,
    targetLabel: `Target ${id}`,
    source: 'current',
    listingId: id,
    itemName: `Item ${id}`,
    priceText: '10 divine',
    seller: 'Seller',
    listedAt: '2026-08-09T12:00:00.000Z',
    searchUrl: `https://www.pathofexile.com/trade/search/Allflame/${id}`,
    listedChaos: 2_000,
    marginChaos: -100,
    marginPct: 19,
    marginText: '-100c (-1.0%)',
    freshnessText: 'ref 1m ago',
    stale: false,
    unknownMargin: false,
    minMarginPct: 20,
    targetMinMarginPct: null,
    qualifiesMargin: false,
    ...overrides,
  };
}

describe('SnipeStore', () => {
  test('keeps below-floor listings selectable as dim table rows', () => {
    const store = new SnipeStore([target('one'), target('two')], { minMarginPct: 20 });
    store.ingest(alert('one'));

    const snapshot = store.snapshot();
    expect(snapshot.table.rows.map((row) => row.entry.alert.listingId)).toEqual(['one']);
    expect(snapshot.table.rows[0]?.qualifies).toBe(false);
    expect(snapshot.queue.selectedListingId).toBe('one');

    store.dispatch({ type: 'move', delta: 1 });
    expect(store.snapshot().queue.selectedListingId).toBe('one');
  });

  test('moving across the flat table keeps the target of the selected row in sync', () => {
    const store = new SnipeStore([target('one'), target('two')], { minMarginPct: 20 });
    store.ingest(alert('one', { marginPct: 30, qualifiesMargin: true }), '2026-08-09T12:00:00.000Z');
    store.ingest(alert('two', {
      listedAt: '2026-08-09T12:01:00.000Z',
      marginPct: 30,
      qualifiesMargin: true,
    }), '2026-08-09T12:01:00.000Z');

    expect(store.snapshot().table.rows.map((row) => row.entry.alert.listingId)).toEqual(['two', 'one']);
    expect(store.snapshot().queue.selectedListingId).toBe('one');

    store.dispatch({ type: 'move', delta: -1 });
    expect(store.snapshot().queue.selectedListingId).toBe('two');
    expect(store.snapshot().queue.selectedTargetId).toBe('trade:two');

    store.dispatch({ type: 'move', delta: 1 });
    expect(store.snapshot().queue.selectedListingId).toBe('one');
    expect(store.snapshot().queue.selectedTargetId).toBe('trade:one');
  });

  test('a flat chaos threshold qualifies rows by absolute profit', () => {
    const store = new SnipeStore([target('one')], { minMarginPct: 0 });
    store.ingest(alert('big', { marginChaos: 1_200, marginPct: 3, qualifiesMargin: true }));
    store.ingest(alert('small', { marginChaos: 300, marginPct: 40, qualifiesMargin: true }));
    expect(store.snapshot().table.rows.every((row) => row.qualifies)).toBe(true);

    store.setFlatFloor(1_000, '5d');
    const rows = store.snapshot().table.rows;
    expect(rows.find((row) => row.entry.alert.listingId === 'big')?.qualifies).toBe(true);
    expect(rows.find((row) => row.entry.alert.listingId === 'small')?.qualifies).toBe(false);
    expect(store.snapshot().flatFloor).toEqual({ chaos: 1_000, label: '5d' });

    store.setFloor(10); // returning to percent clears the flat threshold
    expect(store.snapshot().flatFloor).toBeNull();
  });

  test('selectListing arms the selection at a specific queue entry', () => {
    const store = new SnipeStore([target('one')], { minMarginPct: 0 });
    store.ingest(alert('first', { marginPct: 30, qualifiesMargin: true }));
    store.ingest(alert('second', { marginPct: 30, qualifiesMargin: true }));
    expect(store.snapshot().queue.selectedListingId).toBe('first');
    store.selectListing('second');
    expect(store.snapshot().queue.selectedListingId).toBe('second');
    store.selectListing('missing'); // unknown ids never move the selection
    expect(store.snapshot().queue.selectedListingId).toBe('second');
  });

  test('publishes keyboard capture so the host TUI can mute its shortcuts', () => {
    const store = new SnipeStore([target('one')]);
    expect(store.snapshot().keyboardCapture).toBe(false);
    store.setKeyboardCapture(true);
    expect(store.snapshot().keyboardCapture).toBe(true);
    store.setKeyboardCapture(false);
    expect(store.snapshot().keyboardCapture).toBe(false);
  });

  test('notifies subscribers with connection and seed progress state', () => {
    const store = new SnipeStore([target('one')], { minMarginPct: 20 });
    let notifications = 0;
    store.subscribe(() => { notifications += 1; });
    store.setSearchState('trade:one', 'live');
    store.setProgress(1, 1);

    expect(notifications).toBe(2);
    expect(store.snapshot()).toMatchObject({
      searches: [{ state: 'live' }],
      progress: { seeded: 1, total: 1 },
    });
  });

  test('reconfigures enabled search rows without replacing the store', () => {
    const store = new SnipeStore([target('one')]);
    store.setTargets([target('two')]);
    expect(store.snapshot().board.groups.map((group) => group.targetId)).toEqual(['trade:two']);
    expect(store.snapshot().queue.selectedTargetId).toBe('trade:two');
  });

  test('does not resurrect dismissed or queue-evicted listing ids', () => {
    const store = new SnipeStore([target('one')], { minMarginPct: 0, maxEntries: 2 });
    store.ingest(alert('anchor', { targetId: 'trade:one', marginPct: 30, qualifiesMargin: true }));
    store.ingest(alert('dismissed', { targetId: 'trade:one', marginPct: 30, qualifiesMargin: true }));
    store.dispatch({ type: 'dismiss', listingId: 'dismissed' });
    store.ingest(alert('old', { targetId: 'trade:one', marginPct: 30, qualifiesMargin: true }));
    store.ingest(alert('new', { targetId: 'trade:one', marginPct: 31, qualifiesMargin: true }));
    store.ingest(alert('newest', { targetId: 'trade:one', marginPct: 32, qualifiesMargin: true }));
    store.ingest(alert('dismissed', { targetId: 'trade:one', marginPct: 40, qualifiesMargin: true }));
    store.ingest(alert('old', { targetId: 'trade:one', marginPct: 40, qualifiesMargin: true }));

    expect(store.snapshot().queue.entries.map((entry) => entry.alert.listingId)).toEqual(['newest', 'anchor']);
  });
});
