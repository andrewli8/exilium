import { beforeEach, describe, expect, test } from 'vitest';
import { StashRepository } from '../src/storage/stash-repository.js';
import { createDb } from '../src/storage/db.js';

describe('StashRepository', () => {
  let repo: StashRepository;

  beforeEach(() => {
    repo = new StashRepository(createDb(':memory:'));
  });

  test('saves snapshots and returns the latest with items', () => {
    repo.save({ game: 'poe1', league: 'Mirage', account: 'acct', takenAt: '2026-07-19T10:00:00Z', totalValue: 5000, items: [{ name: 'Divine Orb', count: 7 }] });
    repo.save({ game: 'poe1', league: 'Mirage', account: 'acct', takenAt: '2026-07-19T12:00:00Z', totalValue: 6500, items: [{ name: 'Divine Orb', count: 9 }] });
    const latest = repo.latest('poe1', 'Mirage', 'acct');
    expect(latest!.totalValue).toBe(6500);
    expect(latest!.items).toEqual([{ name: 'Divine Orb', count: 9 }]);
  });

  test('netWorthHistory returns chronological totals', () => {
    repo.save({ game: 'poe1', league: 'Mirage', account: 'acct', takenAt: '2026-07-19T12:00:00Z', totalValue: 6500, items: [] });
    repo.save({ game: 'poe1', league: 'Mirage', account: 'acct', takenAt: '2026-07-19T10:00:00Z', totalValue: 5000, items: [] });
    expect(repo.netWorthHistory('poe1', 'Mirage', 'acct', 10)).toEqual([
      { takenAt: '2026-07-19T10:00:00Z', totalValue: 5000 },
      { takenAt: '2026-07-19T12:00:00Z', totalValue: 6500 },
    ]);
  });

  test('latest is null for unknown accounts', () => {
    expect(repo.latest('poe1', 'Mirage', 'nobody')).toBeNull();
  });
});
