import { describe, expect, test } from 'vitest';
import type { SnipeAlert } from '../src/snipe/engine.js';
import {
  createQueueState,
  queueReducer,
  selectedQueueEntry,
  type SnipeQueueState,
} from '../src/snipe/queue.js';

const RECEIVED_AT = '2026-08-09T12:00:00.000Z';

function alert(id: string, overrides: Partial<SnipeAlert> = {}): SnipeAlert {
  return {
    targetId: `trade:${id}`,
    targetLabel: `Target ${id}`,
    source: 'live',
    listingId: id,
    itemName: `Item ${id}`,
    priceText: '10 divine',
    seller: `Seller ${id}`,
    listedAt: null,
    searchUrl: `https://www.pathofexile.com/trade/search/Allflame/${id}`,
    listedChaos: 2_000,
    marginChaos: 500,
    marginPct: 25,
    marginText: '+500c (+25.0%)',
    freshnessText: 'ref 1m ago',
    stale: false,
    unknownMargin: false,
    minMarginPct: 20,
    qualifiesMargin: true,
    ...overrides,
  };
}

function add(state: SnipeQueueState, id: string): SnipeQueueState {
  return queueReducer(state, { type: 'add', alert: alert(id), receivedAt: RECEIVED_AT });
}

function withAlert(id: string, maxEntries = 200): SnipeQueueState {
  return add(createQueueState(maxEntries), id);
}

describe('queue insertion and selection', () => {
  test('new alerts are newest-first without moving an existing selected listing', () => {
    let state = createQueueState(3);
    state = add(state, 'one');
    state = add(state, 'two');
    expect(selectedQueueEntry(state)?.alert.listingId).toBe('one');
    state = add(state, 'three');
    expect(state.entries.map((entry) => entry.alert.listingId)).toEqual(['three', 'two', 'one']);
    expect(selectedQueueEntry(state)?.alert.listingId).toBe('one');
  });

  test('duplicate listing ids do not create duplicate rows', () => {
    let state = withAlert('same');
    state = add(state, 'same');
    expect(state.entries).toHaveLength(1);
  });

  test('movement is bounded and follows visual queue order', () => {
    let state = add(add(createQueueState(), 'one'), 'two');
    state = queueReducer(state, { type: 'move', delta: -10 });
    expect(selectedQueueEntry(state)?.alert.listingId).toBe('two');
    state = queueReducer(state, { type: 'move', delta: 10 });
    expect(selectedQueueEntry(state)?.alert.listingId).toBe('one');
  });

  test('history bounds preserve the selected row and newest alert', () => {
    let state = add(add(createQueueState(2), 'one'), 'two');
    state = add(state, 'three');
    expect(state.entries.map((entry) => entry.alert.listingId)).toEqual(['three', 'one']);
    expect(selectedQueueEntry(state)?.alert.listingId).toBe('one');
  });
});

describe('travel lifecycle', () => {
  test('only new and failed rows can begin travel', () => {
    let state = queueReducer(withAlert('x'), { type: 'travel-start', listingId: 'x' });
    const duplicateStart = queueReducer(state, { type: 'travel-start', listingId: 'x' });
    expect(duplicateStart).toEqual(state);
    state = queueReducer(state, { type: 'travel-success', listingId: 'x', detail: 'clicked once' });
    expect(state.entries[0]?.status).toBe('traveled');
    expect(queueReducer(state, { type: 'travel-start', listingId: 'x' })).toEqual(state);
  });

  test('failed rows can retry and dismissed rows leave the queue', () => {
    let state = queueReducer(withAlert('x'), { type: 'travel-start', listingId: 'x' });
    state = queueReducer(state, { type: 'travel-failure', listingId: 'x', detail: 'listing vanished' });
    expect(state.entries[0]).toMatchObject({ status: 'failed', detail: 'listing vanished' });
    state = queueReducer(state, { type: 'travel-start', listingId: 'x' });
    expect(state.entries[0]?.status).toBe('traveling');
    expect(queueReducer(state, { type: 'dismiss', listingId: 'x' }).entries).toEqual([]);
  });

  test('success and failure cannot rewrite a row that is not traveling', () => {
    const state = withAlert('x');
    expect(queueReducer(state, { type: 'travel-success', listingId: 'x', detail: 'wrong' })).toEqual(state);
    expect(queueReducer(state, { type: 'travel-failure', listingId: 'x', detail: 'wrong' })).toEqual(state);
  });
});

describe('candidate-board navigation', () => {
  test('selection remains on a target when a better listing for it arrives', () => {
    let state = createQueueState();
    state = queueReducer(state, { type: 'add', alert: alert('first', { targetId: 'trade:mb', targetLabel: 'Mageblood', marginPct: 25 }), receivedAt: RECEIVED_AT });
    state = queueReducer(state, { type: 'add', alert: alert('nimis', { targetId: 'trade:nimis', targetLabel: 'Nimis', marginPct: 24 }), receivedAt: RECEIVED_AT });
    state = queueReducer(state, { type: 'add', alert: alert('better', { targetId: 'trade:mb', targetLabel: 'Mageblood', marginPct: 40 }), receivedAt: RECEIVED_AT });
    expect(state.selectedTargetId).toBe('trade:mb');
    expect(selectedQueueEntry(state)?.alert.listingId).toBe('better');
  });

  test('detail, tab, previous tab, and board transitions preserve target selection', () => {
    let state = withAlert('x');
    state = queueReducer(state, { type: 'open-detail' });
    expect(state.view).toBe('detail');
    state = queueReducer(state, { type: 'next-view' });
    expect(state.view).toBe('board');
    state = queueReducer(state, { type: 'previous-view' });
    expect(state.view).toBe('detail');
    state = queueReducer(state, { type: 'board' });
    expect(state).toMatchObject({ view: 'board', selectedTargetId: 'trade:x' });
  });

  test('gone removes only that listing and recalculates the target best without auto-travel', () => {
    let state = createQueueState();
    state = queueReducer(state, { type: 'add', alert: alert('backup', { targetId: 'trade:mb', targetLabel: 'Mageblood', marginPct: 25 }), receivedAt: RECEIVED_AT });
    state = queueReducer(state, { type: 'add', alert: alert('best', { targetId: 'trade:mb', targetLabel: 'Mageblood', marginPct: 35 }), receivedAt: RECEIVED_AT });
    state = queueReducer(state, { type: 'remove-gone', listingId: 'best' });
    expect(state.entries.map((entry) => entry.alert.listingId)).toEqual(['backup']);
    expect(selectedQueueEntry(state)?.alert.listingId).toBe('backup');
    expect(state.entries[0]?.status).toBe('new');
    expect(state.notice).toBe('Mageblood: listing sold or removed — queue updated');
  });

  test('toggle-hidden reveals a below-floor-only target to grouped movement', () => {
    let state = queueReducer(createQueueState(), {
      type: 'add',
      alert: alert('hidden', { qualifiesMargin: false, marginPct: 10 }),
      receivedAt: RECEIVED_AT,
    });
    expect(selectedQueueEntry(state)).toBeUndefined();
    state = queueReducer(state, { type: 'toggle-hidden' });
    expect(state.showHidden).toBe(true);
    expect(selectedQueueEntry(state)?.alert.listingId).toBe('hidden');
  });
});
