import { describe, expect, test } from 'vitest';
import type { SnipeTarget } from '../src/snipe/bettertrading.js';
import {
  createSelectionState,
  resolveRequestedTargets,
  selectionReducer,
} from '../src/snipe/selection.js';

const TARGETS: readonly SnipeTarget[] = [
  { label: 'Currency', realm: 'trade', searchId: 'aaa', league: null },
  { label: 'Uniques', realm: 'trade', searchId: 'bbb', league: null },
];

describe('selectionReducer', () => {
  test('new state starts with nothing enabled every run', () => {
    expect(createSelectionState(TARGETS)).toMatchObject({ cursor: 0, selectedIds: new Set() });
    expect(createSelectionState(TARGETS)).toMatchObject({ cursor: 0, selectedIds: new Set() });
  });

  test('toggle, move, direct index, and select-all are bounded', () => {
    let state = createSelectionState(TARGETS);
    state = selectionReducer(state, { type: 'toggle' });
    state = selectionReducer(state, { type: 'move', delta: 99 });
    state = selectionReducer(state, { type: 'toggle-index', index: 1 });
    expect(state.cursor).toBe(1);
    expect([...state.selectedIds].sort()).toEqual(['trade:aaa', 'trade:bbb']);
    state = selectionReducer(state, { type: 'toggle-all' });
    expect([...state.selectedIds]).toEqual([]);
    state = selectionReducer(state, { type: 'toggle-all' });
    expect([...state.selectedIds].sort()).toEqual(['trade:aaa', 'trade:bbb']);
  });

  test('empty selection state ignores movement and toggles', () => {
    const empty = createSelectionState([]);
    expect(selectionReducer(empty, { type: 'move', delta: 1 })).toEqual(empty);
    expect(selectionReducer(empty, { type: 'toggle' })).toEqual(empty);
  });
});

describe('resolveRequestedTargets', () => {
  test('interactive runs request the picker while non-TTY runs require explicit selection', () => {
    expect(resolveRequestedTargets(TARGETS, { isTTY: true, all: false, searches: [] })).toBeNull();
    expect(() => resolveRequestedTargets(TARGETS, { isTTY: false, all: false, searches: [] }))
      .toThrow(/--all|--search/);
  });

  test('all returns every target', () => {
    expect(resolveRequestedTargets(TARGETS, { isTTY: false, all: true, searches: [] })).toEqual(TARGETS);
  });

  test('repeated selectors match exact ids and unique labels, preserving source order', () => {
    expect(resolveRequestedTargets(TARGETS, {
      isTTY: false,
      all: false,
      searches: ['bbb', 'currency', 'bbb'],
    })?.map((target) => target.searchId)).toEqual(['aaa', 'bbb']);
  });

  test('unknown and ambiguous selectors fail with the offending value', () => {
    expect(() => resolveRequestedTargets(TARGETS, {
      isTTY: false,
      all: false,
      searches: ['missing'],
    })).toThrow(/missing/);
    const ambiguous = [...TARGETS, { ...TARGETS[1]!, realm: 'trade2' as const, searchId: 'ccc' }];
    expect(() => resolveRequestedTargets(ambiguous, {
      isTTY: false,
      all: false,
      searches: ['uniques'],
    })).toThrow(/ambiguous.*uniques/i);
  });
});
