import { describe, expect, test } from 'vitest';
import { runBacktest } from '../src/backtest/backtest.js';
import type { MarketLine, MarketSnapshot } from '../src/domain/types.js';

/** Build a chronological series of snapshots for one item whose latest
 * sparkline entry spikes at tick `spikeAt`, with prices following `prices`. */
function series(prices: readonly number[], spikeAt: number): readonly MarketSnapshot[] {
  return prices.map((price, t) => {
    const quietWindow = [1, -1, 2, -2, 1, -1];
    const latest = t === spikeAt ? 80 : 1; // spike well past z and deviation floors
    const line: MarketLine = {
      itemId: 'item',
      name: 'Item',
      category: 'Currency',
      primaryValue: price,
      volumePrimaryValue: 5000,
      maxVolumeCurrency: null,
      maxVolumeRate: null,
      sparkline: [...quietWindow, latest],
      totalChange: latest,
    };
    return {
      game: 'poe1' as const,
      league: 'Backtest',
      category: 'Currency',
      fetchedAt: `2026-07-19T${String(t).padStart(2, '0')}:00:00Z`,
      core: { primary: 'chaos', perPrimary: { chaos: 1 } },
      lines: [line],
    };
  });
}

const OPTS = { horizon: 2, detectors: { minVolume: 100, zThreshold: 1.5, minDeviationPct: 10, minDivergence: 0.03 } };

describe('runBacktest', () => {
  test('a sell signal followed by a price drop counts as a win with the forward move recorded', () => {
    // Spike at t=1 (price 100), price falls to 80 by t=3 (horizon 2).
    const report = runBacktest(series([100, 100, 90, 80, 80], 1), OPTS);
    const mr = report.perDetector['mean-reversion']!;
    expect(mr.signals).toBe(1);
    expect(mr.wins).toBe(1);
    expect(mr.hitRate).toBe(1);
    expect(mr.avgForwardMovePct).toBeCloseTo(-20);
  });

  test('a sell signal followed by a rise counts as a loss', () => {
    const report = runBacktest(series([100, 100, 110, 120, 130], 1), OPTS);
    const mr = report.perDetector['mean-reversion']!;
    expect(mr.signals).toBe(1);
    expect(mr.wins).toBe(0);
    expect(mr.hitRate).toBe(0);
  });

  test('signals too close to the end of history are excluded, not guessed', () => {
    // Spike at the last tick: no t+horizon price exists.
    const report = runBacktest(series([100, 100, 100], 2), OPTS);
    expect(report.perDetector['mean-reversion']?.signals ?? 0).toBe(0);
    expect(report.skippedNoHorizon).toBeGreaterThan(0);
  });

  test('reports the evaluated window honestly', () => {
    const report = runBacktest(series([100, 100, 90, 80, 80], 1), OPTS);
    expect(report.ticks).toBe(5);
    expect(report.from).toBe('2026-07-19T00:00:00Z');
    expect(report.to).toBe('2026-07-19T04:00:00Z');
  });

  test('empty history returns an empty report instead of crashing', () => {
    const report = runBacktest([], OPTS);
    expect(report.ticks).toBe(0);
    expect(Object.keys(report.perDetector)).toHaveLength(0);
  });
});
