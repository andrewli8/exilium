import { describe, expect, test, vi } from 'vitest';
import { ingestLeague } from '../src/ingest/ingest.js';
import { createDb } from '../src/storage/db.js';
import { SnapshotRepository } from '../src/storage/snapshot-repository.js';

const RAW_OK = {
  core: { rates: { exalted: 400, chaos: 8 }, primary: 'divine' },
  lines: [
    {
      id: 'chaos',
      primaryValue: 0.13,
      volumePrimaryValue: 1000,
      maxVolumeCurrency: 'divine',
      maxVolumeRate: 7.6,
      sparkline: { totalChange: 1, data: [0, 1] },
    },
  ],
  items: [{ id: 'chaos', name: 'Chaos Orb', category: 'Currency', detailsId: 'chaos-orb' }],
};

describe('ingestLeague', () => {
  test('skips refetch when another process fetched within the shared min interval', async () => {
    const db = createDb(':memory:');
    const repo = new SnapshotRepository(db);
    const client = { getExchangeOverview: vi.fn().mockResolvedValue(RAW_OK) };
    const opts = { game: 'poe2' as const, league: 'L', categories: ['Currency'], now: () => '2026-07-19T10:00:00Z', minIntervalSec: 240 };
    const first = await ingestLeague(client, repo, opts);
    expect(first.saved).toEqual(['Currency']);
    // Second call 60s later (another process): shared state must gate it.
    const second = await ingestLeague(client, repo, { ...opts, now: () => '2026-07-19T10:01:00Z' });
    expect(second.skipped).toBe(true);
    expect(client.getExchangeOverview).toHaveBeenCalledTimes(1);
    // After the interval passes, fetching resumes.
    const third = await ingestLeague(client, repo, { ...opts, now: () => '2026-07-19T10:05:01Z' });
    expect(third.saved).toEqual(['Currency']);
  });

  test('fetches, normalizes, and stores each category; reports per-category errors without aborting', async () => {
    const repo = new SnapshotRepository(createDb(':memory:'));
    const client = {
      getExchangeOverview: vi
        .fn()
        .mockImplementation(async (_game: string, _league: string, type: string) => {
          if (type === 'Runes') throw new Error('boom');
          return RAW_OK;
        }),
    };
    const result = await ingestLeague(client, repo, {
      game: 'poe2',
      league: 'Runes of Aldur',
      categories: ['Currency', 'Runes', 'Essences'],
      now: () => '2026-07-18T18:00:00Z',
    });

    expect(result.saved).toEqual(['Currency', 'Essences']);
    expect(result.errors).toHaveLength(1);
    expect(result.errors[0]).toMatchObject({ category: 'Runes' });
    expect(repo.latest('poe2', 'Runes of Aldur', 'Currency')?.lines[0]?.name).toBe('Chaos Orb');
    expect(repo.latest('poe2', 'Runes of Aldur', 'Essences')?.fetchedAt).toBe('2026-07-18T18:00:00Z');
    expect(repo.latest('poe2', 'Runes of Aldur', 'Runes')).toBeNull();
  });
});
