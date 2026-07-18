import { describe, expect, test } from 'vitest';
import { detectMeanReversion } from '../src/signals/mean-reversion.js';
import type { MarketLine, MarketSnapshot } from '../src/domain/types.js';

function line(overrides: Partial<MarketLine>): MarketLine {
  return {
    itemId: 'item',
    name: 'Item',
    category: 'Currency',
    primaryValue: 1,
    volumePrimaryValue: 5000,
    maxVolumeCurrency: 'exalted',
    maxVolumeRate: 10,
    sparkline: [0, 0, 0, 0, 0, 0, 0],
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
    core: { primary: 'divine', perPrimary: { divine: 1, exalted: 435, chaos: 7.6 } },
    lines,
  };
}

const OPTS = { minVolume: 100, zThreshold: 1.5 };

describe('detectMeanReversion', () => {
  test('flags an item whose latest change sits far below its window mean as a buy', () => {
    const crashed = line({ itemId: 'crashed', sparkline: [10, 12, 11, 9, 10, 11, -25], totalChange: -25 });
    const opps = detectMeanReversion(snap([crashed]), OPTS);
    expect(opps).toHaveLength(1);
    const o = opps[0]!;
    expect(o.kind).toBe('mean-reversion');
    expect(o.itemId).toBe('crashed');
    expect(o.edge).toBeGreaterThan(0);
    expect(o.rationale).toMatch(/below/i);
    expect(o.experimental).toBe(false);
    expect(o.dataFreshness).toBe('2026-07-18T18:00:00Z');
  });

  test('flags elevated items as sell candidates with "above" rationale', () => {
    const spiked = line({ itemId: 'spiked', sparkline: [0, 1, -1, 0, 1, 0, 40], totalChange: 40 });
    const opps = detectMeanReversion(snap([spiked]), OPTS);
    expect(opps).toHaveLength(1);
    expect(opps[0]!.rationale).toMatch(/above/i);
  });

  test('ignores items below the volume floor', () => {
    const illiquid = line({ itemId: 'illiquid', volumePrimaryValue: 50, sparkline: [10, 11, 9, 10, 12, 10, -30] });
    expect(detectMeanReversion(snap([illiquid]), OPTS)).toHaveLength(0);
  });

  test('ignores short sparklines and flat (zero-variance) series', () => {
    const short = line({ itemId: 'short', sparkline: [1, 2] });
    const flat = line({ itemId: 'flat', sparkline: [5, 5, 5, 5, 5, 5, 5] });
    expect(detectMeanReversion(snap([short, flat]), OPTS)).toHaveLength(0);
  });

  test('does not flag deviations inside the threshold', () => {
    const calm = line({ itemId: 'calm', sparkline: [0, 2, -2, 1, -1, 2, 1] });
    expect(detectMeanReversion(snap([calm]), OPTS)).toHaveLength(0);
  });

  test('returns opportunities sorted by edge descending with deterministic ids', () => {
    const a = line({ itemId: 'a', sparkline: [10, 11, 9, 10, 11, 9, -10] });
    const b = line({ itemId: 'b', sparkline: [10, 11, 9, 10, 11, 9, -60] });
    const opps = detectMeanReversion(snap([a, b]), OPTS);
    expect(opps.map((o) => o.itemId)).toEqual(['b', 'a']);
    expect(opps[0]!.id).toBe('mean-reversion:poe2:Runes of Aldur:b');
  });
});
