import type { MarketSnapshot } from '../domain/types.js';
import { assessFreshness, type Freshness } from '../domain/freshness.js';
import { priceItem } from '../pricing/price-item.js';

/** Margin math for snipes: what a live listing costs in chaos versus what
 * poe.ninja says the item is worth. Pure — snapshots and the clock come in,
 * an assessment comes out. Unknown is always represented as null, never a
 * guessed number. */

export interface ListingPrice {
  readonly amount: number;
  readonly currency: string;
}

export interface MarginAssessment {
  /** Listing price converted to chaos; null when unpriced or the currency
   * has no known rate. */
  readonly listedChaos: number | null;
  /** poe.ninja reference value in chaos; null when the item has no
   * aggregate price (rares, unindexed names). */
  readonly referenceChaos: number | null;
  readonly referenceName: string | null;
  readonly marginChaos: number | null;
  /** Margin as a percent of the reference price. */
  readonly marginPct: number | null;
  readonly referenceAsOf: string | null;
  /** Age of the reference price — 'live' means within 10 minutes. */
  readonly freshness: Freshness | null;
}

export interface AssessMarginOptions {
  readonly itemName: string;
  readonly price: ListingPrice | null;
  readonly snapshots: readonly MarketSnapshot[];
  readonly nowMs: number;
}

/** Chaos value of one unit of `currency`, from the freshest snapshot that
 * quotes it (perPrimary holds units-per-chaos). */
function chaosPerUnit(currency: string, snapshots: readonly MarketSnapshot[]): number | null {
  const bearing = snapshots
    .filter((s) => s.core.perPrimary[currency] !== undefined && s.core.perPrimary[currency] !== 0)
    .sort((a, b) => Date.parse(b.fetchedAt) - Date.parse(a.fetchedAt));
  const rate = bearing[0]?.core.perPrimary[currency];
  return rate === undefined ? null : 1 / rate;
}

/** Convert a listing price to chaos; null when the currency has no known
 * rate in the snapshots. */
export function toChaos(price: ListingPrice, snapshots: readonly MarketSnapshot[]): number | null {
  const unit = chaosPerUnit(price.currency, snapshots);
  return unit === null ? null : price.amount * unit;
}

export function assessMargin(opts: AssessMarginOptions): MarginAssessment {
  const quote = priceItem(opts.itemName, opts.snapshots);
  const referenceChaos = quote?.primaryValue ?? null;
  const referenceAsOf = quote?.asOf ?? null;

  const listedChaos = opts.price === null ? null : toChaos(opts.price, opts.snapshots);

  const marginChaos = listedChaos !== null && referenceChaos !== null ? referenceChaos - listedChaos : null;
  const marginPct = marginChaos !== null && referenceChaos !== null && referenceChaos > 0 ? (marginChaos / referenceChaos) * 100 : null;

  return {
    listedChaos,
    referenceChaos,
    referenceName: quote?.name ?? null,
    marginChaos,
    marginPct,
    referenceAsOf,
    freshness: assessFreshness(referenceAsOf, opts.nowMs),
  };
}

export interface MarginGateResult {
  readonly pass: boolean;
  /** True when a threshold was set but the margin could not be computed —
   * the alert still fires, marked so the human knows to judge it. */
  readonly unknownMargin: boolean;
}

export function passesMarginGate(assessment: MarginAssessment, minMarginPct: number | null): MarginGateResult {
  if (minMarginPct === null) return { pass: true, unknownMargin: false };
  if (assessment.marginPct === null) return { pass: true, unknownMargin: true };
  return { pass: assessment.marginPct >= minMarginPct, unknownMargin: false };
}
