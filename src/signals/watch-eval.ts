import type { ExiliumService } from '../mcp/service.js';
import type { Watch, WatchEventInput } from '../storage/watch-repository.js';

/** Evaluate active watches against the latest snapshots. `alreadyFired`
 * answers "was (watchId, dedupeKey) recorded before?" so conditions fire once
 * per snapshot instance. Pure aside from reads through the service. */
export function evaluateWatches(
  watches: readonly Watch[],
  service: ExiliumService,
  alreadyFired: (watchId: string, dedupeKey: string) => boolean,
): readonly WatchEventInput[] {
  return watches.filter((w) => w.active).flatMap((w): WatchEventInput[] => {
    const summary = service.marketSnapshot(w.game, w.league);
    if (summary.asOf === null) return [];
    const fresh = (key: string): boolean => !alreadyFired(w.id, key);

    if (w.kind === 'price_above' || w.kind === 'price_below') {
      if (w.itemId === null) return [];
      const quote = service.price(w.itemId, w.game, w.league);
      if (quote === null) return [];
      const met = w.kind === 'price_above' ? quote.primaryValue >= w.threshold : quote.primaryValue <= w.threshold;
      const key = `${w.itemId}:${quote.asOf}`;
      if (!met || !fresh(key)) return [];
      return [
        {
          watchId: w.id,
          firedAt: quote.asOf,
          dedupeKey: key,
          payload: {
            kind: w.kind as string,
            itemId: quote.itemId,
            itemName: quote.name,
            value: quote.primaryValue,
            currency: quote.primaryCurrency,
            threshold: w.threshold,
          },
        },
      ];
    }

    if (w.kind === 'change_abs') {
      return service
        .moversDetailed(w.game, w.league, 1000, w.category ?? undefined)
        .filter((m) => (w.itemId === null || m.itemId === w.itemId) && Math.abs(m.totalChange) >= w.threshold)
        .filter((m) => fresh(`${m.itemId}:${summary.asOf}`))
        .map((m) => ({
          watchId: w.id,
          firedAt: summary.asOf ?? '',
          dedupeKey: `${m.itemId}:${summary.asOf}`,
          payload: {
            kind: w.kind,
            itemId: m.itemId,
            itemName: m.name,
            totalChange: m.totalChange,
            value: m.primaryValue,
            threshold: w.threshold,
          },
        }));
    }

    // kind === 'opportunity'
    return service
      .opportunities(w.game, w.league, false, w.threshold / 100, w.category ?? undefined)
      .opportunities.filter((o) => w.itemId === null || o.itemId === w.itemId)
      .filter((o) => fresh(`${o.id}:${o.dataFreshness}`))
      .map((o) => ({
        watchId: w.id,
        firedAt: o.dataFreshness,
        dedupeKey: `${o.id}:${o.dataFreshness}`,
        payload: {
          kind: w.kind,
          opportunityId: o.id,
          itemId: o.itemId,
          itemName: o.itemName,
          detector: o.kind,
          edge: o.edge,
          confidence: o.confidence,
          rationale: o.rationale,
        },
      }));
  });
}
