import { describe, expect, test } from 'vitest';
import { detectCrossRateDivergence } from '../src/signals/cross-rate.js';
import type { MarketLine, MarketSnapshot } from '../src/domain/types.js';

function line(overrides: Partial<MarketLine>): MarketLine {
  return {
    itemId: 'item',
    name: 'Item',
    category: 'Currency',
    primaryValue: 0.01,
    volumePrimaryValue: 5000,
    maxVolumeCurrency: 'exalted',
    maxVolumeRate: 10,
    sparkline: [],
    totalChange: 0,
    ...overrides,
  };
}

function snap(lines: readonly MarketLine[]): MarketSnapshot {
  return {
    game: 'poe2' as const,
    league: 'Runes of Aldur',
    category: 'Currency',
    fetchedAt: '2026-07-18T18:00:00Z',
    core: { primary: 'divine', perPrimary: { divine: 1, exalted: 400, chaos: 8 } },
    lines,
  };
}

const OPTS = { minDivergence: 0.03, minVolume: 100 };

describe('detectCrossRateDivergence', () => {
  test('flags a market whose quote-currency implied price diverges from its divine price', () => {
    // 20 items per exalted, 400 exalted per divine => implied 1/8000 divine each.
    // Listed primaryValue of 1/7200 is ~11% above implied => divergence.
    const diverged = line({ itemId: 'div-item', primaryValue: 1 / 7200, maxVolumeRate: 20 });
    const opps = detectCrossRateDivergence(snap([diverged]), OPTS);
    expect(opps).toHaveLength(1);
    const o = opps[0]!;
    expect(o.kind).toBe('cross-rate-divergence');
    expect(o.experimental).toBe(true);
    expect(o.edge).toBeCloseTo(Math.abs(1 - (1 / 8000) / (1 / 7200)), 5);
    expect(o.rationale).toMatch(/exalted/);
  });

  test('does not flag consistent markets', () => {
    // 20 per exalted => implied 1/8000; primaryValue equals implied.
    const consistent = line({ itemId: 'ok', primaryValue: 1 / 8000, maxVolumeRate: 20 });
    expect(detectCrossRateDivergence(snap([consistent]), OPTS)).toHaveLength(0);
  });

  test('skips lines without quote data, with unknown quote currencies, or below volume floor', () => {
    const noQuote = line({ itemId: 'nq', maxVolumeCurrency: null, maxVolumeRate: null });
    const unknown = line({ itemId: 'uk', maxVolumeCurrency: 'gold', maxVolumeRate: 5, primaryValue: 1 });
    const illiquid = line({ itemId: 'il', primaryValue: 1 / 7200, maxVolumeRate: 20, volumePrimaryValue: 10 });
    expect(detectCrossRateDivergence(snap([noQuote, unknown, illiquid]), OPTS)).toHaveLength(0);
  });

  test('sorts by edge descending', () => {
    const small = line({ itemId: 'small', primaryValue: 1 / 7500, maxVolumeRate: 20 });
    const big = line({ itemId: 'big', primaryValue: 1 / 6000, maxVolumeRate: 20 });
    const opps = detectCrossRateDivergence(snap([small, big]), OPTS);
    expect(opps.map((o) => o.itemId)).toEqual(['big', 'small']);
  });
});
