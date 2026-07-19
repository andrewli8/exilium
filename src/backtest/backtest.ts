import { detectMeanReversion } from '../signals/mean-reversion.js';
import type { DetectorConfig } from '../mcp/service.js';
import type { MarketSnapshot } from '../domain/types.js';

export interface BacktestOptions {
  /** Forward-move window in wall-clock hours, resolved against fetchedAt. */
  readonly horizonHours: number;
  readonly detectors: DetectorConfig;
}

export interface DetectorBacktest {
  readonly signals: number;
  readonly wins: number;
  readonly hitRate: number;
  /** Mean price move (percent) from signal onset to horizon, sign preserved. */
  readonly avgForwardMovePct: number;
  /** Fraction of ALL items that moved in the signals' predicted directions
   * over the same windows — the null hypothesis a detector must beat. */
  readonly baselineHitRate: number;
}

export interface BacktestReport {
  readonly ticks: number;
  readonly from: string | null;
  readonly to: string | null;
  readonly skippedNoHorizon: number;
  readonly perDetector: Readonly<Record<string, DetectorBacktest>>;
}

/** Replay one category's chronological snapshots and score detector signals.
 *
 * Methodology (each choice exists because the naive version lies):
 * - Only signal ONSETS are scored: a signal instance (detector+item) that was
 *   also firing at the previous tick is the same episode, not a new sample —
 *   sparklines are daily series that barely change between close ticks.
 * - The horizon is wall-clock hours resolved against fetchedAt, because tick
 *   spacing is irregular (gaps whenever no surface was running).
 * - A same-window all-items baseline is reported next to each hit rate; a
 *   60% hit rate in a market where 60% of everything moved that way is zero
 *   information. */
export function runBacktest(snapshots: readonly MarketSnapshot[], opts: BacktestOptions): BacktestReport {
  const acc = new Map<string, { signals: number; wins: number; moveSum: number; baseWins: number; baseTotal: number }>();
  let skippedNoHorizon = 0;
  const horizonMs = opts.horizonHours * 3600_000;
  const times = snapshots.map((s) => Date.parse(s.fetchedAt));

  let previousActive = new Set<string>();
  for (let t = 0; t < snapshots.length; t++) {
    const now = snapshots[t]!;
    const opportunities = detectMeanReversion(now, opts.detectors).filter((o) => o.direction !== null);
    const activeNow = new Set(opportunities.map((o) => `${o.kind}:${o.itemId}`));
    const onsets = opportunities.filter((o) => !previousActive.has(`${o.kind}:${o.itemId}`));
    previousActive = activeNow;
    if (onsets.length === 0) continue;

    const targetTime = times[t]! + horizonMs;
    const futureIndex = times.findIndex((time, i) => i > t && time >= targetTime);
    if (futureIndex === -1) {
      skippedNoHorizon += onsets.length;
      continue;
    }
    const future = snapshots[futureIndex]!;
    const nowPrices = new Map(now.lines.map((l) => [l.itemId, l.primaryValue]));
    const futurePrices = new Map(future.lines.map((l) => [l.itemId, l.primaryValue]));

    for (const o of onsets) {
      const p0 = nowPrices.get(o.itemId);
      const p1 = futurePrices.get(o.itemId);
      if (p0 === undefined || p1 === undefined || p0 <= 0) continue;
      const movePct = ((p1 - p0) / p0) * 100;
      const win = o.direction === 'sell' ? p1 < p0 : p1 > p0;
      // Null baseline: how often did ANY item move the predicted way in this window?
      let baseWins = 0;
      let baseTotal = 0;
      for (const [itemId, q0] of nowPrices) {
        const q1 = futurePrices.get(itemId);
        if (q1 === undefined || q0 <= 0) continue;
        baseTotal += 1;
        if (o.direction === 'sell' ? q1 < q0 : q1 > q0) baseWins += 1;
      }
      const entry = acc.get(o.kind) ?? { signals: 0, wins: 0, moveSum: 0, baseWins: 0, baseTotal: 0 };
      acc.set(o.kind, {
        signals: entry.signals + 1,
        wins: entry.wins + (win ? 1 : 0),
        moveSum: entry.moveSum + movePct,
        baseWins: entry.baseWins + baseWins,
        baseTotal: entry.baseTotal + baseTotal,
      });
    }
  }

  return {
    ticks: snapshots.length,
    from: snapshots[0]?.fetchedAt ?? null,
    to: snapshots[snapshots.length - 1]?.fetchedAt ?? null,
    skippedNoHorizon,
    perDetector: Object.fromEntries(
      [...acc.entries()].map(([kind, e]) => [
        kind,
        {
          signals: e.signals,
          wins: e.wins,
          hitRate: e.signals === 0 ? 0 : e.wins / e.signals,
          avgForwardMovePct: e.signals === 0 ? 0 : e.moveSum / e.signals,
          baselineHitRate: e.baseTotal === 0 ? 0 : e.baseWins / e.baseTotal,
        },
      ]),
    ),
  };
}
