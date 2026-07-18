import { describe, expect, test } from 'vitest';
import { normalizeExchangeOverview } from '../src/sources/ninja/normalize.js';

const RAW = {
  core: {
    items: [{ id: 'divine', name: 'Divine Orb', category: 'Currency', detailsId: 'divine-orb' }],
    rates: { exalted: 435.3, chaos: 7.62 },
    primary: 'divine',
    secondary: 'chaos',
  },
  lines: [
    {
      id: 'chaos',
      primaryValue: 0.1313,
      volumePrimaryValue: 139275,
      maxVolumeCurrency: 'divine',
      maxVolumeRate: 7.62,
      sparkline: { totalChange: 7.16, data: [0.97, 2.21, 8.12, 11.92, 12.86, 14.77, 7.16] },
    },
    {
      id: 'mystery-orb',
      primaryValue: 2.5,
      volumePrimaryValue: 10,
      sparkline: { totalChange: 0, data: [0] },
    },
  ],
  items: [
    { id: 'chaos', name: 'Chaos Orb', category: 'Currency', detailsId: 'chaos-orb' },
  ],
};

const CTX = { league: 'Runes of Aldur', category: 'Currency', fetchedAt: '2026-07-18T18:00:00Z' };

describe('normalizeExchangeOverview', () => {
  test('maps lines to MarketLines with names resolved from items', () => {
    const snap = normalizeExchangeOverview(RAW, CTX);
    expect(snap.league).toBe('Runes of Aldur');
    expect(snap.lines).toHaveLength(2);
    const chaos = snap.lines[0]!;
    expect(chaos.itemId).toBe('chaos');
    expect(chaos.name).toBe('Chaos Orb');
    expect(chaos.primaryValue).toBe(0.1313);
    expect(chaos.maxVolumeCurrency).toBe('divine');
    expect(chaos.sparkline).toEqual([0.97, 2.21, 8.12, 11.92, 12.86, 14.77, 7.16]);
    expect(chaos.totalChange).toBe(7.16);
  });

  test('falls back to item id when name is unknown and nulls missing quote fields', () => {
    const snap = normalizeExchangeOverview(RAW, CTX);
    const mystery = snap.lines[1]!;
    expect(mystery.name).toBe('mystery-orb');
    expect(mystery.maxVolumeCurrency).toBeNull();
    expect(mystery.maxVolumeRate).toBeNull();
  });

  test('exposes core rates as units-per-divine including divine itself', () => {
    const snap = normalizeExchangeOverview(RAW, CTX);
    expect(snap.core.primary).toBe('divine');
    expect(snap.core.perDivine).toEqual({ divine: 1, exalted: 435.3, chaos: 7.62 });
  });

  test('rejects malformed payloads with a clear error', () => {
    expect(() => normalizeExchangeOverview({ nope: true }, CTX)).toThrow(/exchange overview/i);
  });

  test('treats null sparkline entries (no-trade days) as gaps', () => {
    const raw = {
      ...RAW,
      lines: [{ id: 'chaos', primaryValue: 0.1, volumePrimaryValue: 10, sparkline: { totalChange: 2, data: [1, null, 3, null, 2] } }],
    };
    const snap = normalizeExchangeOverview(raw, CTX);
    expect(snap.lines[0]!.sparkline).toEqual([1, 3, 2]);
  });

  test('drops lines with non-positive prices', () => {
    const raw = { ...RAW, lines: [...RAW.lines, { id: 'zero', primaryValue: 0, volumePrimaryValue: 0, sparkline: { totalChange: 0, data: [] } }] };
    const snap = normalizeExchangeOverview(raw, CTX);
    expect(snap.lines.map((l) => l.itemId)).not.toContain('zero');
  });
});
