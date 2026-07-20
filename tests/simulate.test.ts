import { describe, expect, test, vi } from 'vitest';
import { applyMoves, makeFakeListingFetch, parseMoves, runWatchSimulation } from '../src/simulate/simulate.js';
import { handleNewListings } from '../src/trade/live-search.js';
import type { MarketSnapshot } from '../src/domain/types.js';
import type { Watch } from '../src/storage/watch-repository.js';

const SNAP: MarketSnapshot = {
  game: 'poe1',
  league: 'Mirage',
  category: 'Currency',
  fetchedAt: '2026-07-20T10:00:00Z',
  core: { primary: 'chaos', perPrimary: { chaos: 1, divine: 0.0014 } },
  lines: [
    {
      itemId: 'divine',
      name: 'Divine Orb',
      category: 'Currency',
      primaryValue: 700,
      volumePrimaryValue: 900000,
      maxVolumeCurrency: null,
      maxVolumeRate: null,
      sparkline: [1, 2, 1, 2, 1, 2, 1],
      totalChange: 1,
    },
  ],
};

describe('parseMoves', () => {
  test('parses "item:+pct" pairs, tolerating % signs and spaces', () => {
    expect(parseMoves('divine:+10%, ambush scarab:-30')).toEqual([
      { query: 'divine', pct: 10 },
      { query: 'ambush scarab', pct: -30 },
    ]);
  });

  test('rejects malformed entries with the offending token', () => {
    expect(() => parseMoves('divine plus ten')).toThrow(/divine plus ten/);
  });
});

describe('applyMoves', () => {
  test('returns a new snapshot with moved prices and a fresh timestamp, leaving the original untouched', () => {
    const { snapshot, applied } = applyMoves(SNAP, [{ query: 'divine', pct: 10 }], '2026-07-20T11:00:00Z');
    expect(snapshot.lines[0]!.primaryValue).toBeCloseTo(770);
    expect(snapshot.fetchedAt).toBe('2026-07-20T11:00:00Z');
    expect(SNAP.lines[0]!.primaryValue).toBe(700); // immutability
    expect(applied).toEqual(['Divine Orb +10%']);
  });

  test('reports unmatched queries instead of silently ignoring them', () => {
    const { unmatched } = applyMoves(SNAP, [{ query: 'mageblood', pct: 5 }], '2026-07-20T11:00:00Z');
    expect(unmatched).toEqual(['mageblood']);
  });
});

describe('runWatchSimulation', () => {
  const watch: Watch = {
    id: 'sim-divine',
    game: 'poe1',
    league: 'Mirage',
    kind: 'price_above',
    itemId: 'divine',
    category: null,
    threshold: 750,
    mode: 'once',
    webhookUrl: null,
    createdAt: '2026-07-20T09:00:00Z',
    active: true,
  };

  test('a price_above watch fires in the round where the move crosses the threshold', () => {
    const result = runWatchSimulation({
      snapshots: [SNAP],
      watches: [watch],
      rounds: [
        [{ query: 'divine', pct: 2 }], // 714 — below threshold
        [{ query: 'divine', pct: 8 }], // 771 — crosses
      ],
      startIso: '2026-07-20T11:00:00Z',
    });
    expect(result.rounds).toHaveLength(2);
    expect(result.rounds[0]!.fired).toHaveLength(0);
    expect(result.rounds[1]!.fired).toHaveLength(1);
    expect(result.rounds[1]!.fired[0]!.payload).toMatchObject({ itemId: 'divine' });
  });

  test('once-mode watches do not refire in later rounds', () => {
    const result = runWatchSimulation({
      snapshots: [SNAP],
      watches: [watch],
      rounds: [[{ query: 'divine', pct: 10 }], [{ query: 'divine', pct: 1 }]],
      startIso: '2026-07-20T11:00:00Z',
    });
    expect(result.rounds[0]!.fired).toHaveLength(1);
    expect(result.rounds[1]!.fired).toHaveLength(0);
  });
});

describe('makeFakeListingFetch', () => {
  test('drives the real snipe pipeline: whisper extracted and clipboard copied', async () => {
    const fetchFn = makeFakeListingFetch([
      { id: 'sim-1', itemName: 'Mageblood', amount: 5, currency: 'divine', seller: 'SimSeller' },
    ]);
    const clipboard = vi.fn().mockResolvedValue(undefined);
    const notify = vi.fn().mockResolvedValue(undefined);
    const listings = await handleNewListings(
      ['sim-1'],
      { realm: 'trade', league: 'Mirage', searchId: 'simulated' },
      'FAKE-SESSION',
      { fetchFn, clipboard, notify, log: () => undefined },
    );
    expect(listings).toHaveLength(1);
    expect(listings[0]!.whisper).toContain('Mageblood');
    expect(clipboard).toHaveBeenCalledWith(expect.stringContaining('Mageblood'));
    expect(notify).toHaveBeenCalled();
  });
});
