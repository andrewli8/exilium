import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, test } from 'vitest';
import { normalizeItemOverview } from '../src/sources/ninja/normalize-items.js';

const CTX = { game: 'poe1' as const, league: 'Mirage', category: 'UniqueWeapon', fetchedAt: '2026-07-20T18:00:00Z' };

const RAW = {
  lines: [
    {
      id: 1,
      detailsId: 'the-golden-charlatan-lion-sword',
      name: 'The Golden Charlatan',
      baseType: 'Lion Sword',
      chaosValue: 207900,
      divineValue: 270,
      listingCount: 3,
      links: 5,
      sparkLine: { data: [0, null, 5, 10], totalChange: 10 },
    },
    {
      id: 2,
      detailsId: 'tabula-rasa-simple-robe-6l',
      name: 'Tabula Rasa',
      baseType: 'Simple Robe',
      chaosValue: 20,
      divineValue: 0.03,
      listingCount: 50,
      links: 6,
      variant: '6L',
      sparkLine: { data: [1, 2], totalChange: 2 },
    },
    { id: 3, detailsId: 'zero-item', name: 'Zero', chaosValue: 0, listingCount: 5, sparkLine: { data: [], totalChange: 0 } },
    { id: 4, detailsId: 'greater-multistrike-1-23c', name: 'Greater Multistrike Support', chaosValue: 5, listingCount: 9, gemLevel: 1, gemQuality: 23, corrupted: true, variant: '1/23c', sparkLine: { data: [1], totalChange: 0 } },
    { id: 5, detailsId: 'awakened-empower-5c', name: 'Awakened Empower Support', chaosValue: 90000, listingCount: 2, gemLevel: 5, corrupted: true, variant: '5c', sparkLine: { data: [1], totalChange: 0 } },
  ],
};

describe('normalizeItemOverview', () => {
  test('maps listing lines into MarketLines with variant-aware names', () => {
    const snap = normalizeItemOverview(RAW, CTX);
    expect(snap.game).toBe('poe1');
    expect(snap.category).toBe('UniqueWeapon');
    expect(snap.core.primary).toBe('chaos');
    expect(snap.core.perPrimary['divine']).toBeCloseTo(270 / 207900, 8); // rate recovered from listing pairs
    const first = snap.lines[0]!;
    expect(first.itemId).toBe('the-golden-charlatan-lion-sword');
    expect(first.name).toBe('The Golden Charlatan (5L)');
    expect(first.primaryValue).toBe(207900);
    expect(first.sparkline).toEqual([0, 5, 10]); // nulls are gaps
    // Depth proxy: value on the market, not trade volume (documented).
    expect(first.volumePrimaryValue).toBe(207900 * 3);
    const tabula = snap.lines[1]!;
    expect(tabula.name).toBe('Tabula Rasa (6L)');
  });

  test('renders gem level/quality/corruption readably instead of the raw variant code', () => {
    const snap = normalizeItemOverview(RAW, CTX);
    const byId = new Map(snap.lines.map((l) => [l.itemId, l.name]));
    expect(byId.get('greater-multistrike-1-23c')).toBe('Greater Multistrike Support (lvl 1, 23q, corrupt)');
    expect(byId.get('awakened-empower-5c')).toBe('Awakened Empower Support (lvl 5, corrupt)');
  });

  test('drops zero-priced lines and rejects malformed payloads', () => {
    const snap = normalizeItemOverview(RAW, CTX);
    expect(snap.lines.map((l) => l.itemId)).not.toContain('zero-item');
    expect(() => normalizeItemOverview({ nope: 1 }, CTX)).toThrow(/item overview/i);
  });

  test('normalizes the recorded real UniqueWeapon payload', () => {
    const raw = JSON.parse(readFileSync(join(__dirname, 'fixtures', 'poe1-uniqueweapon-overview.json'), 'utf8'));
    const snap = normalizeItemOverview(raw, CTX);
    expect(snap.lines.length).toBeGreaterThan(30);
    for (const l of snap.lines) {
      expect(l.primaryValue).toBeGreaterThan(0);
      expect(Number.isFinite(l.volumePrimaryValue)).toBe(true);
      expect(l.sparkline.every((v) => Number.isFinite(v))).toBe(true);
    }
  });
});
