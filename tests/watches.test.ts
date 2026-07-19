import { beforeEach, describe, expect, test } from 'vitest';
import { WatchRepository } from '../src/storage/watch-repository.js';
import { evaluateWatches } from '../src/signals/watch-eval.js';
import { ExiliumService } from '../src/mcp/service.js';
import { createDb } from '../src/storage/db.js';
import { SnapshotRepository } from '../src/storage/snapshot-repository.js';
import type { MarketSnapshot } from '../src/domain/types.js';
import type { Watch } from '../src/storage/watch-repository.js';

const SNAP: MarketSnapshot = {
  game: 'poe1',
  league: 'Mirage',
  category: 'Currency',
  fetchedAt: '2026-07-18T18:00:00Z',
  core: { primary: 'chaos', perPrimary: { chaos: 1, divine: 0.0014 } },
  lines: [
    {
      itemId: 'divine',
      name: 'Divine Orb',
      category: 'Currency',
      primaryValue: 720,
      volumePrimaryValue: 900000,
      maxVolumeCurrency: 'chaos',
      maxVolumeRate: 0.0014,
      sparkline: [1, 2, 1, 2, 1, 2, 3],
      totalChange: 3,
    },
    {
      itemId: 'crashed',
      name: 'Crashed Orb',
      category: 'Currency',
      primaryValue: 10,
      volumePrimaryValue: 40000,
      maxVolumeCurrency: 'divine',
      maxVolumeRate: 60,
      sparkline: [10, 12, 11, 9, 10, 11, -40],
      totalChange: -40,
    },
  ],
};

function watch(overrides: Partial<Watch>): Watch {
  return {
    id: 'w1',
    game: 'poe1',
    league: 'Mirage',
    kind: 'price_above',
    itemId: 'divine',
    category: null,
    threshold: 700,
    mode: 'once',
    webhookUrl: null,
    createdAt: '2026-07-18T17:00:00Z',
    active: true,
    ...overrides,
  };
}

describe('WatchRepository', () => {
  let repo: WatchRepository;

  beforeEach(() => {
    repo = new WatchRepository(createDb(':memory:'));
  });

  test('upserts by id (idempotent create) and lists active watches', () => {
    repo.upsert(watch({}));
    repo.upsert(watch({ threshold: 750 }));
    const all = repo.list();
    expect(all).toHaveLength(1);
    expect(all[0]!.threshold).toBe(750);
  });

  test('deactivate removes a watch from the active list but delete removes it entirely', () => {
    repo.upsert(watch({}));
    repo.deactivate('w1');
    expect(repo.list()).toHaveLength(0);
    expect(repo.list(true)).toHaveLength(1);
    repo.delete('w1');
    expect(repo.list(true)).toHaveLength(0);
  });

  test('records events and pages them by cursor', () => {
    repo.upsert(watch({}));
    repo.recordEvents([
      { watchId: 'w1', firedAt: '2026-07-18T18:00:00Z', payload: { itemId: 'divine', value: 720 }, dedupeKey: 'a' },
      { watchId: 'w1', firedAt: '2026-07-18T18:05:00Z', payload: { itemId: 'divine', value: 730 }, dedupeKey: 'b' },
    ]);
    const page1 = repo.eventsSince(0, 1);
    expect(page1).toHaveLength(1);
    const page2 = repo.eventsSince(page1[0]!.seq, 10);
    expect(page2).toHaveLength(1);
    expect((page2[0]!.payload as { value: number }).value).toBe(730);
  });

  test('hasEvent dedupes by watch and key', () => {
    repo.upsert(watch({}));
    repo.recordEvents([{ watchId: 'w1', firedAt: 't', payload: {}, dedupeKey: 'k1' }]);
    expect(repo.hasEvent('w1', 'k1')).toBe(true);
    expect(repo.hasEvent('w1', 'k2')).toBe(false);
  });
});

describe('evaluateWatches', () => {
  function service(): ExiliumService {
    const snaps = new SnapshotRepository(createDb(':memory:'));
    snaps.save(SNAP);
    return new ExiliumService(snaps);
  }

  test('price_above fires when the item trades above threshold', () => {
    const events = evaluateWatches([watch({})], service(), () => false);
    expect(events).toHaveLength(1);
    expect(events[0]!.payload).toMatchObject({ itemId: 'divine', value: 720, threshold: 700 });
  });

  test('price_below and unmet conditions do not fire', () => {
    const events = evaluateWatches(
      [watch({ id: 'w2', kind: 'price_below', threshold: 700 }), watch({ id: 'w3', threshold: 800 })],
      service(),
      () => false,
    );
    expect(events).toHaveLength(0);
  });

  test('change_abs fires on |7d change| ≥ threshold, optionally category-scoped', () => {
    const events = evaluateWatches(
      [watch({ id: 'w4', kind: 'change_abs', itemId: null, category: 'Currency', threshold: 30 })],
      service(),
      () => false,
    );
    expect(events).toHaveLength(1);
    expect(events[0]!.payload).toMatchObject({ itemId: 'crashed' });
  });

  test('opportunity watches fire on detector signals at or above the edge threshold', () => {
    const events = evaluateWatches(
      [watch({ id: 'w5', kind: 'opportunity', itemId: null, threshold: 10 })],
      service(),
      () => false,
    );
    expect(events.length).toBeGreaterThan(0);
    expect(events[0]!.payload).toHaveProperty('edge');
  });

  test('skips events whose dedupe key was already recorded', () => {
    const events = evaluateWatches([watch({})], service(), () => true);
    expect(events).toHaveLength(0);
  });
});
