import { describe, expect, test } from 'vitest';
import type { SnipeAlert } from '../src/snipe/engine.js';
import {
  createQueueState,
  queueReducer,
  selectedQueueEntry,
  type SnipeQueueState,
} from '../src/snipe/queue.js';

const RECEIVED_AT = '2026-08-09T12:00:00.000Z';

function alert(id: string): SnipeAlert {
  return {
    targetLabel: `Target ${id}`,
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
