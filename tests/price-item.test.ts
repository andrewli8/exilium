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

const POE2_SNAP: MarketSnapshot = {
  game: 'poe2',
  league: 'Runes of Aldur',
  category: 'Currency',
  fetchedAt: '2026-07-18T18:00:00Z',
  core: { primary: 'divine', perPrimary: { divine: 1, exalted: 400, chaos: 8 } },
  lines: [
    line({}),
    line({ itemId: 'greater-essence-of-haste', name: 'Greater Essence of Haste', primaryValue: 0.02, volumePrimaryValue: 500 }),
    line({ itemId: 'greater-essence-of-ruin', name: 'Greater Essence of Ruin', primaryValue: 0.05, volumePrimaryValue: 9000 }),
  ],
};

const POE1_SNAP: MarketSnapshot = {
  game: 'poe1',
  league: 'Mirage',
  category: 'Currency',
  fetchedAt: '2026-07-18T18:00:00Z',
  core: { primary: 'chaos', perPrimary: { chaos: 1, divine: 0.0014 } },
  lines: [line({ itemId: 'fusing', name: 'Orb of Fusing', primaryValue: 0.5 })],
};

describe('priceItem', () => {
  test('prices by exact item id in the snapshot primary currency with cross-currency conversions', () => {
    const q = priceItem('chaos', [POE2_SNAP]);
    expect(q).not.toBeNull();
    expect(q!.primaryCurrency).toBe('divine');
    expect(q!.primaryValue).toBe(0.13);
    expect(q!.conversions['exalted']).toBeCloseTo(0.13 * 400);
    expect(q!.conversions['chaos']).toBeCloseTo(0.13 * 8);
    expect(q!.league).toBe('Runes of Aldur');
    expect(q!.game).toBe('poe2');
    expect(q!.asOf).toBe('2026-07-18T18:00:00Z');
  });

  test('uses chaos as the primary for PoE1 snapshots', () => {
    const q = priceItem('fusing', [POE1_SNAP]);
    expect(q!.primaryCurrency).toBe('chaos');
    expect(q!.primaryValue).toBe(0.5);
    expect(q!.conversions['divine']).toBeCloseTo(0.5 * 0.0014);
  });

  test('matches by name case-insensitively', () => {
    const q = priceItem('chaos orb', [POE2_SNAP]);
    expect(q!.itemId).toBe('chaos');
  });

  test('falls back to substring match, preferring the highest-volume candidate', () => {
    const q = priceItem('greater essence', [POE2_SNAP]);
    expect(q!.itemId).toBe('greater-essence-of-ruin');
  });

  test('prefers the item own variant lines over other lines containing the name', () => {
    const snap: MarketSnapshot = {
      ...POE1_SNAP,
      lines: [
        line({ itemId: 'valdo-mb', name: 'Squandered Highlands (Foil Mageblood)', primaryValue: 10_000, volumePrimaryValue: 999_999 }),
        line({ itemId: 'mageblood-4f', name: 'Mageblood (4 Flasks)', primaryValue: 42_000, volumePrimaryValue: 5_000 }),
        line({ itemId: 'mageblood-5f', name: 'Mageblood (5 Flasks)', primaryValue: 282_000, volumePrimaryValue: 1_000 }),
      ],
    };
    // "Mageblood" must resolve to the belt's own variants — the Valdo map
    // line merely contains the word and has more volume.
    expect(priceItem('Mageblood', [snap])?.itemId).toBe('mageblood-4f');
  });

  test('returns null when nothing matches', () => {
    expect(priceItem('mirror of kalandra', [POE2_SNAP])).toBeNull();
  });

  test('rejects blank queries', () => {
    expect(() => priceItem('   ', [POE2_SNAP])).toThrow(/query/i);
  });
});
