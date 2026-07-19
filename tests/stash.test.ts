import { describe, expect, test, vi } from 'vitest';
import { buildStashUrl, diffStash, fetchAllStashItems, valueStash } from '../src/trade/stash.js';
import type { DetailedMover } from '../src/mcp/service.js';

const MARKET: readonly DetailedMover[] = [
  { itemId: 'divine', name: 'Divine Orb', category: 'Currency', primaryValue: 720, totalChange: 0, volumePrimaryValue: 900000, sparkline: [] },
  { itemId: 'ambush', name: 'Ambush Scarab of Containment', category: 'Scarab', primaryValue: 583, totalChange: 0, volumePrimaryValue: 22945, sparkline: [] },
];

describe('buildStashUrl', () => {
  test('targets the character-window API with account, league, and tab index', () => {
    const url = buildStashUrl('My Account', 'Mirage', 3);
    expect(url).toContain('/character-window/get-stash-items');
    expect(url).toContain('accountName=My+Account');
    expect(url).toContain('league=Mirage');
    expect(url).toContain('tabIndex=3');
  });
});

describe('fetchAllStashItems', () => {
  test('walks every tab and aggregates stackable items', async () => {
    const tab = (items: unknown[]) => new Response(JSON.stringify({ numTabs: 2, items }), { status: 200 });
    const fetchFn = vi
      .fn()
      .mockResolvedValueOnce(tab([{ typeLine: 'Divine Orb', stackSize: 10, frameType: 5 }]))
      .mockResolvedValueOnce(tab([{ typeLine: 'Ambush Scarab of Containment', stackSize: 7, frameType: 0 }]));
    const items = await fetchAllStashItems('acct', 'Mirage', 'SESSID', { fetchFn, delayMs: 0 });
    expect(items).toEqual([
      { name: 'Divine Orb', count: 10 },
      { name: 'Ambush Scarab of Containment', count: 7 },
    ]);
    expect(fetchFn).toHaveBeenCalledTimes(2);
    const init = fetchFn.mock.calls[0]![1] as { headers: Record<string, string> };
    expect(init.headers['Cookie']).toContain('POESESSID=SESSID');
  });

  test('explains 401/403 as session problems and 403-private-profile guidance', async () => {
    const fetchFn = vi.fn().mockResolvedValue(new Response('forbidden', { status: 403 }));
    await expect(fetchAllStashItems('acct', 'Mirage', 'BAD', { fetchFn, delayMs: 0 })).rejects.toThrow(/POESESSID|session|profile/i);
  });
});

describe('valueStash', () => {
  test('prices matched stackables and reports unmatched separately', () => {
    const v = valueStash(
      [
        { name: 'Divine Orb', count: 10 },
        { name: 'Ambush Scarab of Containment', count: 7 },
        { name: 'Some Unique Sword', count: 1 },
      ],
      MARKET,
    );
    expect(v.total).toBeCloseTo(10 * 720 + 7 * 583);
    expect(v.lines[0]!.name).toBe('Divine Orb'); // sorted by total value
    expect(v.unmatched).toEqual([{ name: 'Some Unique Sword', count: 1 }]);
  });
});

describe('diffStash', () => {
  test('reports gained, lost, and the value delta between snapshots', () => {
    const before = [
      { name: 'Divine Orb', count: 10 },
      { name: 'Ambush Scarab of Containment', count: 7 },
    ];
    const after = [
      { name: 'Divine Orb', count: 14 },
      { name: 'Ambush Scarab of Containment', count: 2 },
    ];
    const d = diffStash(before, after, MARKET);
    expect(d.gained).toEqual([{ name: 'Divine Orb', count: 4 }]);
    expect(d.lost).toEqual([{ name: 'Ambush Scarab of Containment', count: 5 }]);
    expect(d.valueDelta).toBeCloseTo(4 * 720 - 5 * 583);
  });

  test('empty diff when nothing changed', () => {
    const items = [{ name: 'Divine Orb', count: 1 }];
    const d = diffStash(items, items, MARKET);
    expect(d.gained).toHaveLength(0);
    expect(d.lost).toHaveLength(0);
    expect(d.valueDelta).toBe(0);
  });
});
