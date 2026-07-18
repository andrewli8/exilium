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
  test('fetches, normalizes, and stores each category; reports per-category errors without aborting', async () => {
    const repo = new SnapshotRepository(createDb(':memory:'));
    const client = {
      getExchangeOverview: vi
        .fn()
        .mockImplementation(async (_league: string, type: string) => {
          if (type === 'Runes') throw new Error('boom');
          return RAW_OK;
        }),
    };
    const result = await ingestLeague(client, repo, {
      league: 'Runes of Aldur',
      categories: ['Currency', 'Runes', 'Essences'],
      now: () => '2026-07-18T18:00:00Z',
    });

    expect(result.saved).toEqual(['Currency', 'Essences']);
    expect(result.errors).toHaveLength(1);
    expect(result.errors[0]).toMatchObject({ category: 'Runes' });
    expect(repo.latest('Runes of Aldur', 'Currency')?.lines[0]?.name).toBe('Chaos Orb');
    expect(repo.latest('Runes of Aldur', 'Essences')?.fetchedAt).toBe('2026-07-18T18:00:00Z');
    expect(repo.latest('Runes of Aldur', 'Runes')).toBeNull();
  });
});
