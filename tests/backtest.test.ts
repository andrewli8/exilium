import { describe, expect, test } from 'vitest';
import { runBacktest } from '../src/backtest/backtest.js';
import type { MarketLine, MarketSnapshot } from '../src/domain/types.js';

/** Chronological hourly snapshots. `spikes` maps itemId -> ticks where its
 * sparkline shows the planted spike; `prices` maps itemId -> price series. */
function series(prices: Readonly<Record<string, readonly number[]>>, spikes: Readonly<Record<string, readonly number[]>>): readonly MarketSnapshot[] {
  const ticks = Object.values(prices)[0]!.length;
  return Array.from({ length: ticks }, (_, t) => {
    const lines: MarketLine[] = Object.entries(prices).map(([itemId, ps]) => {
      const spiking = (spikes[itemId] ?? []).includes(t);
      return {
        itemId,
        name: itemId,
        category: 'Currency',
        primaryValue: ps[t]!,
        volumePrimaryValue: 5000,
        maxVolumeCurrency: null,
        maxVolumeRate: null,
        sparkline: [1, -1, 2, -2, 1, -1, spiking ? 80 : 1],
        totalChange: spiking ? 80 : 1,
      };
    });
    return {
      game: 'poe1' as const,
      league: 'Backtest',
      category: 'Currency',
      fetchedAt: `2026-07-19T${String(t).padStart(2, '0')}:00:00Z`,
      core: { primary: 'chaos', perPrimary: { chaos: 1 } },
      lines,
    };
  });
}

const OPTS = { horizonHours: 2, detectors: { minVolume: 100, zThreshold: 1.5, minDeviationPct: 10, minDivergence: 0.03 } };

describe('runBacktest', () => {
  test('scores a sell signal that reverts as a win, with baseline from all items', () => {
    // Signal item spikes at t=1 (100) and falls to 80 by t=3 (2h horizon).
    // Bystander rises over the same window, so the sell baseline is 50%.
    const report = runBacktest(
      series(
        { target: [100, 100, 90, 80, 80], bystander: [50, 50, 55, 60, 60] },
        { target: [1] },
      ),
      OPTS,
    );
    const mr = report.perDetector['mean-reversion']!;
    expect(mr.signals).toBe(1);
    expect(mr.wins).toBe(1);
    expect(mr.hitRate).toBe(1);
    expect(mr.avgForwardMovePct).toBeCloseTo(-20);
    expect(mr.baselineHitRate).toBeCloseTo(0.5);
  });

  test('a spike persisting across consecutive ticks counts as ONE signal onset, not many', () => {
    // The daily sparkline barely changes between close ticks: same spike
    // visible at t=1 and t=2 must not double-count.
    const report = runBacktest(
      series({ target: [100, 100, 100, 80, 80, 80] }, { target: [1, 2] }),
      OPTS,
    );
    expect(report.perDetector['mean-reversion']!.signals).toBe(1);
  });

  test('the horizon is wall-clock, resolved against fetchedAt', () => {
    // Hourly ticks, horizonHours 2 → the t=1 signal scores against t=3.
    const report = runBacktest(series({ target: [100, 100, 120, 70, 200] }, { target: [1] }), OPTS);
    const mr = report.perDetector['mean-reversion']!;
    expect(mr.avgForwardMovePct).toBeCloseTo(-30); // 100 → 70, not 120 or 200
  });

  test('signals with no snapshot at the horizon are excluded and counted', () => {
    const report = runBacktest(series({ target: [100, 100, 100] }, { target: [2] }), OPTS);
    expect(report.perDetector['mean-reversion']?.signals ?? 0).toBe(0);
    expect(report.skippedNoHorizon).toBe(1);
  });

  test('reports the evaluated window and empty history does not crash', () => {
    const report = runBacktest(series({ target: [100, 100, 90, 80, 80] }, { target: [1] }), OPTS);
    expect(report.ticks).toBe(5);
    expect(report.from).toBe('2026-07-19T00:00:00Z');
    expect(report.to).toBe('2026-07-19T04:00:00Z');
    expect(runBacktest([], OPTS).ticks).toBe(0);
  });
});
