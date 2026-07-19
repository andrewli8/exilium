import type { MarketSnapshot, Opportunity } from '../domain/types.js';
import { mean, stddev, volumeConfidence } from './stats.js';

export interface MeanReversionOptions {
  /** Minimum traded volume (in the primary currency) for a line to be considered. */
  readonly minVolume: number;
  /** Z-score of the latest change vs the window required to flag. */
  readonly zThreshold: number;
  /** Minimum |latest − mean| in percentage points. Statistical outliers on
   * whisper-quiet series are not tradeable after fees; this floor drops them. */
  readonly minDeviationPct: number;
}

const MIN_SPARKLINE_POINTS = 4;

/** Flag items whose latest sparkline change deviates sharply from their
 * trailing-window mean — candidates to revert toward trend. Heuristic:
 * edge is the gap (in percentage points / 100) between latest and mean. */
export function detectMeanReversion(snapshot: MarketSnapshot, opts: MeanReversionOptions): readonly Opportunity[] {
  const opps = snapshot.lines.flatMap((l): Opportunity[] => {
    if (l.volumePrimaryValue < opts.minVolume) return [];
    if (l.sparkline.length < MIN_SPARKLINE_POINTS) return [];
    const window = l.sparkline.slice(0, -1);
    const latest = l.sparkline[l.sparkline.length - 1]!;
    const m = mean(window);
    const sd = stddev(window);
    if (sd === 0) return [];
    const z = (latest - m) / sd;
    if (Math.abs(z) < opts.zThreshold) return [];
    if (Math.abs(latest - m) < opts.minDeviationPct) return [];
    const direction = latest < m ? 'below' : 'above';
    const action = latest < m ? 'buy (expect recovery toward trend)' : 'sell (expect pullback toward trend)';
    return [
      {
        id: `mean-reversion:${snapshot.game}:${snapshot.league}:${l.itemId}`,
        kind: 'mean-reversion',
        game: snapshot.game,
        league: snapshot.league,
        itemId: l.itemId,
        itemName: l.name,
        category: l.category,
        edge: Math.abs(latest - m) / 100,
        confidence: volumeConfidence(l.volumePrimaryValue),
        rationale: `Latest daily change ${latest.toFixed(1)}% is ${Math.abs(z).toFixed(1)} standard deviations ${direction} its window mean of ${m.toFixed(1)}% — ${action}.`,
        dataFreshness: snapshot.fetchedAt,
        experimental: false,
      },
    ];
  });
  return [...opps].sort((a, b) => b.edge - a.edge);
}
