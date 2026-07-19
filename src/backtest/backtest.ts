import { detectMeanReversion } from '../signals/mean-reversion.js';
import type { DetectorConfig } from '../mcp/service.js';
import type { MarketSnapshot } from '../domain/types.js';

export interface BacktestOptions {
  /** How many snapshots ahead to measure the forward move. */
  readonly horizon: number;
  readonly detectors: DetectorConfig;
}

export interface DetectorBacktest {
  readonly signals: number;
  readonly wins: number;
  readonly hitRate: number;
  /** Mean price move (percent) from signal to horizon, sign preserved. */
  readonly avgForwardMovePct: number;
}

export interface BacktestReport {
  readonly ticks: number;
  readonly from: string | null;
  readonly to: string | null;
  /** Signals that fired too close to the end of history to score. */
  readonly skippedNoHorizon: number;
  readonly perDetector: Readonly<Record<string, DetectorBacktest>>;
}

/** Replay one category's chronological snapshots: fire detectors at each
 * tick, then score each directional signal against the price `horizon`
 * snapshots later. Only signals with a direction are scored — a signal that
 * predicts nothing measurable is not counted for or against. */
export function runBacktest(snapshots: readonly MarketSnapshot[], opts: BacktestOptions): BacktestReport {
  const acc = new Map<string, { signals: number; wins: number; moveSum: number }>();
  let skippedNoHorizon = 0;

  for (let t = 0; t < snapshots.length; t++) {
    const now = snapshots[t]!;
    const future = snapshots[t + opts.horizon];
    const opportunities = detectMeanReversion(now, opts.detectors).filter((o) => o.direction !== null);
    if (opportunities.length === 0) continue;
    if (future === undefined) {
      skippedNoHorizon += opportunities.length;
      continue;
    }
    const futurePrices = new Map(future.lines.map((l) => [l.itemId, l.primaryValue]));
    const nowPrices = new Map(now.lines.map((l) => [l.itemId, l.primaryValue]));
    for (const o of opportunities) {
      const p0 = nowPrices.get(o.itemId);
      const p1 = futurePrices.get(o.itemId);
      if (p0 === undefined || p1 === undefined || p0 <= 0) continue;
      const movePct = ((p1 - p0) / p0) * 100;
      const win = o.direction === 'sell' ? p1 < p0 : p1 > p0;
      const entry = acc.get(o.kind) ?? { signals: 0, wins: 0, moveSum: 0 };
      acc.set(o.kind, { signals: entry.signals + 1, wins: entry.wins + (win ? 1 : 0), moveSum: entry.moveSum + movePct });
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
        },
      ]),
    ),
  };
}
