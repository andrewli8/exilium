import { describe, expect, test } from 'vitest';
import { projectCandidateBoard, projectSearchCandidateBoard } from '../src/snipe/board.js';
import type { SnipeAlert } from '../src/snipe/engine.js';
import { createQueueState, queueReducer, type SnipeQueueState } from '../src/snipe/queue.js';

function candidate(overrides: Partial<SnipeAlert> & Pick<SnipeAlert, 'listingId'>): SnipeAlert {
  return {
    targetId: 'trade:mageblood',
    targetLabel: 'Mageblood',
    source: 'live',
    itemName: `Valdo ${overrides.listingId}`,
    priceText: '35 divine',
    seller: 'Seller',
    listedAt: '2026-08-09T11:59:00.000Z',
    searchUrl: 'https://www.pathofexile.com/trade/search/Allflame/mageblood',
    listedChaos: 7_000,
    marginChaos: 3_000,
    marginPct: 30,
    marginText: '+3,000c (+30.0%)',
    freshnessText: 'ref 1m ago',
    stale: false,
    unknownMargin: false,
    minMarginPct: 20,
    targetMinMarginPct: null,
    qualifiesMargin: true,
    ...overrides,
  };
}

function add(state: SnipeQueueState, alert: SnipeAlert, receivedAt = '2026-08-09T12:00:00.000Z'): SnipeQueueState {
  return queueReducer(state, { type: 'add', alert, receivedAt });
}

describe('candidate board projection', () => {
  test('groups by Better Trading target and sorts best profit before recency', () => {
    let state = createQueueState();
    state = add(state, candidate({ listingId: 'mb-old', marginPct: 30, listedAt: '2026-08-09T11:50:00.000Z' }));
    state = add(state, candidate({ listingId: 'mb-new', marginPct: 30, listedAt: '2026-08-09T11:59:30.000Z' }));
    state = add(state, candidate({
      listingId: 'nimis',
      targetId: 'trade:nimis',
      targetLabel: 'Nimis',
      searchUrl: 'https://www.pathofexile.com/trade/search/Allflame/nimis',
      marginPct: 25,
    }));

    const board = projectCandidateBoard(state, { showHidden: false });

    expect(board.groups.map((group) => group.targetLabel)).toEqual(['Mageblood', 'Nimis']);
    expect(board.groups[0]?.entries.map((entry) => entry.alert.listingId)).toEqual(['mb-new', 'mb-old']);
    expect(board.groups[0]?.best.alert.listingId).toBe('mb-new');
    expect(board.groups[0]?.moreCount).toBe(1);
    expect(board.qualifyingCount).toBe(3);
  });

  test('hides below-floor and unknown listings while reporting separate counts', () => {
    let state = createQueueState();
    state = add(state, candidate({ listingId: 'good' }));
    state = add(state, candidate({ listingId: 'below', marginPct: 10, qualifiesMargin: false }));
    state = add(state, candidate({
      listingId: 'unknown',
      targetId: 'trade:sublime',
      targetLabel: 'Sublime Vision',
      marginPct: null,
      marginChaos: null,
      unknownMargin: true,
      qualifiesMargin: false,
    }));

    const hidden = projectCandidateBoard(state, { showHidden: false });
    expect(hidden.groups).toHaveLength(1);
    expect(hidden.groups[0]?.entries.map((entry) => entry.alert.listingId)).toEqual(['good']);
    expect(hidden).toMatchObject({ qualifyingCount: 1, belowFloorCount: 1, unknownCount: 1 });

    const revealed = projectCandidateBoard(state, { showHidden: true });
    expect(revealed.groups).toHaveLength(2);
    expect(revealed.groups.flatMap((group) => group.entries).map((entry) => entry.alert.listingId).sort()).toEqual([
      'below',
      'good',
      'unknown',
    ]);
  });

  test('keeps the board empty when every listing misses the floor', () => {
    const state = add(createQueueState(), candidate({ listingId: 'near-miss', marginPct: 19.9, qualifiesMargin: false }));
    const board = projectCandidateBoard(state, { showHidden: false });
    expect(board.groups).toEqual([]);
    expect(board.qualifyingCount).toBe(0);
    expect(board.belowFloorCount).toBe(1);
  });

  test('search projection keeps configured targets when every listing misses the floor', () => {
    const state = add(createQueueState(), candidate({ listingId: 'near-miss', marginPct: 19.9, qualifiesMargin: false }));
    const board = projectSearchCandidateBoard(state, {
      showHidden: false,
      targets: [
        { targetId: 'trade:mageblood', targetLabel: 'Mageblood' },
        { targetId: 'trade:nimis', targetLabel: 'Nimis' },
      ],
    });

    expect(board.groups.map((group) => group.targetLabel)).toEqual(['Mageblood', 'Nimis']);
    expect(board.groups[0]).toMatchObject({ best: null, hiddenCount: 1 });
    expect(board.groups[1]).toMatchObject({ best: null, hiddenCount: 0 });
  });

  test('a per-target floor still wins over a changed session floor', () => {
    const state = add(createQueueState(), candidate({
      listingId: 'strict-target',
      marginPct: 35,
      minMarginPct: 40,
      targetMinMarginPct: 40,
      qualifiesMargin: false,
    }));
    const board = projectCandidateBoard(state, { showHidden: false, minMarginPct: 20 });
    expect(board.groups).toEqual([]);
    expect(board.belowFloorCount).toBe(1);
  });
});
