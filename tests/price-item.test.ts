import { describe, expect, test } from 'vitest';
import { priceItem } from '../src/pricing/price-item.js';
import type { MarketLine, MarketSnapshot } from '../src/domain/types.js';

function line(overrides: Partial<MarketLine>): MarketLine {
  return {
    itemId: 'chaos',
    name: 'Chaos Orb',
    category: 'Currency',
    primaryValue: 0.13,
    volumePrimaryValue: 100000,
    maxVolumeCurrency: 'divine',
    maxVolumeRate: 7.6,
    sparkline: [],
    totalChange: 0,
    ...overrides,
  };
}

const SNAP: MarketSnapshot = {
  league: 'Runes of Aldur',
  category: 'Currency',
  fetchedAt: '2026-07-18T18:00:00Z',
  core: { primary: 'divine', perDivine: { divine: 1, exalted: 400, chaos: 8 } },
  lines: [
    line({}),
    line({ itemId: 'greater-essence-of-haste', name: 'Greater Essence of Haste', primaryValue: 0.02, volumePrimaryValue: 500 }),
    line({ itemId: 'greater-essence-of-ruin', name: 'Greater Essence of Ruin', primaryValue: 0.05, volumePrimaryValue: 9000 }),
  ],
};

describe('priceItem', () => {
  test('prices by exact item id with divine/exalted/chaos conversions', () => {
    const q = priceItem('chaos', [SNAP]);
    expect(q).not.toBeNull();
    expect(q!.divineValue).toBe(0.13);
    expect(q!.exaltedValue).toBeCloseTo(0.13 * 400);
    expect(q!.chaosValue).toBeCloseTo(0.13 * 8);
    expect(q!.league).toBe('Runes of Aldur');
    expect(q!.asOf).toBe('2026-07-18T18:00:00Z');
  });

  test('matches by name case-insensitively', () => {
    const q = priceItem('chaos orb', [SNAP]);
    expect(q!.itemId).toBe('chaos');
  });

  test('falls back to substring match, preferring the highest-volume candidate', () => {
    const q = priceItem('greater essence', [SNAP]);
    expect(q!.itemId).toBe('greater-essence-of-ruin');
  });

  test('returns null when nothing matches', () => {
    expect(priceItem('mirror of kalandra', [SNAP])).toBeNull();
  });

  test('rejects blank queries', () => {
    expect(() => priceItem('   ', [SNAP])).toThrow(/query/i);
  });
});
