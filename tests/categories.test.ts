import { beforeEach, describe, expect, test } from 'vitest';
import { ExiliumService } from '../src/mcp/service.js';
import { createDb } from '../src/storage/db.js';
import { SnapshotRepository } from '../src/storage/snapshot-repository.js';
import type { MarketLine, MarketSnapshot } from '../src/domain/types.js';

function line(overrides: Partial<MarketLine>): MarketLine {
  return {
    itemId: 'x',
    name: 'X',
    category: 'Currency',
    primaryValue: 1,
    volumePrimaryValue: 100,
    maxVolumeCurrency: 'divine',
    maxVolumeRate: 10,
    sparkline: [1, 2, 1, 2, 1, 2, 30],
    totalChange: 30,
    ...overrides,
  };
}

function snap(category: string, lines: readonly MarketLine[]): MarketSnapshot {
  return {
    game: 'poe1',
    league: 'Mirage',
    category,
    fetchedAt: '2026-07-18T18:00:00Z',
    core: { primary: 'chaos', perPrimary: { chaos: 1, divine: 0.0014 } },
    lines,
  };
}

describe('category browsing', () => {
  let service: ExiliumService;

  beforeEach(() => {
    const repo = new SnapshotRepository(createDb(':memory:'));
    repo.save(snap('Currency', [
      line({ itemId: 'divine', name: 'Divine Orb', primaryValue: 720, volumePrimaryValue: 900000 }),
      line({ itemId: 'fusing', name: 'Orb of Fusing', primaryValue: 0.5, volumePrimaryValue: 5000 }),
    ]));
    repo.save(snap('Scarab', [
      line({ itemId: 'ambush', name: 'Ambush Scarab', category: 'Scarab', primaryValue: 5, volumePrimaryValue: 20000, totalChange: -50, sparkline: [1, 2, 1, 2, 1, 2, -50] }),
    ]));
    service = new ExiliumService(repo);
  });

  test('categoryList returns per-category market counts and volume, sorted by volume', () => {
    const cats = service.categoryList('poe1', 'Mirage');
    expect(cats).toEqual([
      { category: 'Currency', markets: 2, volumePrimaryValue: 905000 },
      { category: 'Scarab', markets: 1, volumePrimaryValue: 20000 },
    ]);
  });

  test('listItems returns a category sorted by value by default', () => {
    const items = service.listItems('poe1', 'Mirage', 'Scarab');
    expect(items).toHaveLength(1);
    expect(items[0]!.name).toBe('Ambush Scarab');
    const currency = service.listItems('poe1', 'Mirage', 'Currency');
    expect(currency.map((i) => i.itemId)).toEqual(['divine', 'fusing']);
  });

  test('listItems supports volume and change sorts and is case-insensitive on category', () => {
    const byVolume = service.listItems('poe1', 'Mirage', 'currency', 'volume');
    expect(byVolume[0]!.itemId).toBe('divine');
    const byChange = service.listItems('poe1', 'Mirage', 'scarab', 'change');
    expect(byChange[0]!.totalChange).toBe(-50);
  });

  test('listItems throws a helpful error for unknown categories', () => {
    expect(() => service.listItems('poe1', 'Mirage', 'Wands')).toThrow(/Currency|Scarab/);
  });

  test('moversDetailed returns every market when no limit is given', () => {
    const repo = new SnapshotRepository(createDb(':memory:'));
    repo.save(snap('Big', Array.from({ length: 5000 }, (_, i) =>
      line({ itemId: `it${i}`, name: `Item ${i}`, category: 'Big', primaryValue: 1 + i }))));
    const all = new ExiliumService(repo).moversDetailed('poe1', 'Mirage', undefined, 'Big');
    expect(all).toHaveLength(5000);
    // A limit still caps when explicitly passed (MCP payload trimming).
    expect(new ExiliumService(repo).moversDetailed('poe1', 'Mirage', 10, 'Big')).toHaveLength(10);
  });

  test('moversDetailed, opportunities, and arbitrage accept a category filter', () => {
    const movers = service.moversDetailed('poe1', 'Mirage', 10, 'Scarab');
    expect(movers.every((m) => m.category === 'Scarab')).toBe(true);
    expect(movers).toHaveLength(1);

    const opps = service.opportunities('poe1', 'Mirage', true, 0, 'Scarab').opportunities;
    expect(opps.every((o) => o.category === 'Scarab')).toBe(true);

    const arb = service.arbitrage('poe1', 'Mirage', 0, 'Scarab');
    expect(arb.every((r) => r.category === 'Scarab')).toBe(true);
    expect(service.arbitrage('poe1', 'Mirage', 0, 'Currency').length).toBeGreaterThan(0);
  });
});
