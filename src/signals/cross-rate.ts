import type { MarketSnapshot, Opportunity } from '../domain/types.js';
import { volumeConfidence } from './stats.js';
import { formatNumber } from '../domain/format-price.js';

export interface CrossRateOptions {
  /** Minimum |implied/listed - 1| divergence to flag (0.03 = 3%). */
  readonly minDivergence: number;
  readonly minVolume: number;
}

/** EXPERIMENTAL: compare each market's divine-denominated price against the
 * price implied by its highest-volume quote pair (e.g. exalted) and the core
 * cross rates. Persistent divergence marks one leg as mispriced. Snapshot
 * data is minutes old — treat as research signal, not a guaranteed fill. */
export function detectCrossRateDivergence(snapshot: MarketSnapshot, opts: CrossRateOptions): readonly Opportunity[] {
  const { perPrimary } = snapshot.core;
  const opps = snapshot.lines.flatMap((l): Opportunity[] => {
    if (l.volumePrimaryValue < opts.minVolume) return [];
    if (l.maxVolumeCurrency === null || l.maxVolumeRate === null || l.maxVolumeRate <= 0) return [];
    const quotePerDivine = perPrimary[l.maxVolumeCurrency];
    if (quotePerDivine === undefined || quotePerDivine <= 0) return [];
    // maxVolumeRate = items per one quote unit; items per divine = rate * quotePerDivine.
    const impliedPrimaryValue = 1 / (l.maxVolumeRate * quotePerDivine);
    const divergence = Math.abs(1 - impliedPrimaryValue / l.primaryValue);
    if (divergence < opts.minDivergence) return [];
    const cheapLeg = impliedPrimaryValue < l.primaryValue ? l.maxVolumeCurrency : snapshot.core.primary;
    return [
      {
        id: `cross-rate-divergence:${snapshot.game}:${snapshot.league}:${l.itemId}`,
        kind: 'cross-rate-divergence',
        game: snapshot.game,
        league: snapshot.league,
        itemId: l.itemId,
        itemName: l.name,
        category: l.category,
        edge: divergence,
        confidence: volumeConfidence(l.volumePrimaryValue) * 0.5, // experimental haircut
        direction: null,
        rationale: `Priced at ${formatNumber(l.primaryValue)} divine but the ${l.maxVolumeCurrency} pair implies ${formatNumber(impliedPrimaryValue)} divine (${(divergence * 100).toFixed(1)}% gap) — the ${cheapLeg} leg is the cheaper route.`,
        dataFreshness: snapshot.fetchedAt,
        experimental: true,
      },
    ];
  });
  return [...opps].sort((a, b) => b.edge - a.edge);
}
