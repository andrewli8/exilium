import { beforeEach, describe, expect, test } from 'vitest';
import { createDb } from '../src/storage/db.js';
import { SnapshotRepository } from '../src/storage/snapshot-repository.js';
import type { MarketSnapshot } from '../src/domain/types.js';

function snap(overrides: Partial<MarketSnapshot>): MarketSnapshot {
  return {
    league: 'Runes of Aldur',
    category: 'Currency',
    fetchedAt: '2026-07-18T18:00:00Z',
    core: { primary: 'divine', perDivine: { divine: 1, exalted: 400, chaos: 8 } },
    lines: [
      {
        itemId: 'chaos',
        name: 'Chaos Orb',
        category: 'Currency',
        primaryValue: 0.13,
        volumePrimaryValue: 100000,
        maxVolumeCurrency: 'divine',
        maxVolumeRate: 7.6,
        sparkline: [1, 2, 3],
        totalChange: 3,
      },
    ],
    ...overrides,
  };
}

describe('SnapshotRepository', () => {
  let repo: SnapshotRepository;

  beforeEach(() => {
    repo = new SnapshotRepository(createDb(':memory:'));
  });

  test('round-trips a snapshot through save and latest', () => {
    const s = snap({});
    repo.save(s);
    expect(repo.latest('Runes of Aldur', 'Currency')).toEqual(s);
  });

  test('latest returns the most recently fetched snapshot for a league/category', () => {
    repo.save(snap({ fetchedAt: '2026-07-18T17:00:00Z' }));
    const newer = snap({ fetchedAt: '2026-07-18T18:00:00Z' });
    repo.save(newer);
    expect(repo.latest('Runes of Aldur', 'Currency')?.fetchedAt).toBe('2026-07-18T18:00:00Z');
  });

  test('latest returns null for unknown league', () => {
    expect(repo.latest('Nope', 'Currency')).toBeNull();
  });

  test('latestAll returns one latest snapshot per category', () => {
    repo.save(snap({ category: 'Currency' }));
    repo.save(snap({ category: 'Runes' }));
    repo.save(snap({ category: 'Currency', fetchedAt: '2026-07-18T19:00:00Z' }));
    const all = repo.latestAll('Runes of Aldur');
    expect(all).toHaveLength(2);
    expect(all.find((s) => s.category === 'Currency')?.fetchedAt).toBe('2026-07-18T19:00:00Z');
  });

  test('history returns chronological price points for an item across snapshots', () => {
    repo.save(snap({ fetchedAt: '2026-07-18T17:00:00Z' }));
    repo.save(
      snap({
        fetchedAt: '2026-07-18T18:00:00Z',
        lines: [{ ...snap({}).lines[0]!, primaryValue: 0.14 }],
      }),
    );
    const hist = repo.history('Runes of Aldur', 'chaos', 10);
    expect(hist).toEqual([
      { fetchedAt: '2026-07-18T17:00:00Z', primaryValue: 0.13, volumePrimaryValue: 100000 },
      { fetchedAt: '2026-07-18T18:00:00Z', primaryValue: 0.14, volumePrimaryValue: 100000 },
    ]);
  });
});
