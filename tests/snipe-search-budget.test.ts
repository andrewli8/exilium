import { describe, expect, test } from 'vitest';
import { DEFAULT_SEARCH_WINDOWS, nextSearchSlot, pruneSearchHistory } from '../src/snipe/search-budget.js';

const W = [{ max: 2, periodMs: 10_000 }, { max: 3, periodMs: 60_000 }];

describe('search budget', () => {
  test('free slot while under every window', () => {
    expect(nextSearchSlot([], 1_000, W)).toBe(1_000);
    expect(nextSearchSlot([500], 1_000, W)).toBe(1_000);
  });

  test('a full short window waits until its oldest entry ages out', () => {
    expect(nextSearchSlot([0, 1_000], 2_000, W)).toBe(10_000);
  });

  test('the long window binds after the short one clears', () => {
    expect(nextSearchSlot([0, 1_000, 20_000], 30_000, W)).toBe(60_000);
  });

  test('20 tabs never exceed the default policy windows', () => {
    let now = 0;
    let history: number[] = [];
    for (let i = 0; i < 20; i += 1) {
      now = nextSearchSlot(history, now, DEFAULT_SEARCH_WINDOWS);
      history = [...pruneSearchHistory(history, now, DEFAULT_SEARCH_WINDOWS), now];
      for (const { max, periodMs } of [{ max: 8, periodMs: 10_000 }, { max: 15, periodMs: 60_000 }]) {
        expect(history.filter((t) => t > now - periodMs).length).toBeLessThanOrEqual(max);
      }
    }
  });
});
