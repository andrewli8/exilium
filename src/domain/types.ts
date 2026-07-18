/** Core immutable domain types. All prices are denominated in Divine Orbs
 * (poe.ninja's primary) unless a field name says otherwise. */

export type Game = 'poe2';

export interface League {
  readonly id: string;
  readonly name: string;
}

/** One market line from the in-game Currency Exchange, normalized. */
export interface MarketLine {
  readonly itemId: string;
  readonly name: string;
  readonly category: string;
  /** Price in Divine Orbs. */
  readonly primaryValue: number;
  /** Total traded volume, denominated in Divine Orbs. */
  readonly volumePrimaryValue: number;
  /** Currency id of the highest-volume quote pair (e.g. 'exalted'). */
  readonly maxVolumeCurrency: string | null;
  /** Units of this item per one maxVolumeCurrency. */
  readonly maxVolumeRate: number | null;
  /** Daily % changes over the trailing window (poe.ninja sparkline). */
  readonly sparkline: readonly number[];
  /** Overall % change across the sparkline window. */
  readonly totalChange: number;
}

/** Reference rates from the snapshot core: units per one Divine Orb. */
export interface CoreRates {
  readonly primary: string;
  readonly perDivine: Readonly<Record<string, number>>;
}

export interface MarketSnapshot {
  readonly league: string;
  readonly category: string;
  readonly fetchedAt: string; // ISO-8601
  readonly core: CoreRates;
  readonly lines: readonly MarketLine[];
}

export type OpportunityKind = 'mean-reversion' | 'cross-rate-divergence';

export interface Opportunity {
  readonly id: string;
  readonly kind: OpportunityKind;
  readonly league: string;
  readonly itemId: string;
  readonly itemName: string;
  readonly category: string;
  /** Expected edge as a fraction (0.05 = 5%), before gold fees. */
  readonly edge: number;
  /** 0..1 heuristic confidence (volume- and freshness-driven). */
  readonly confidence: number;
  readonly rationale: string;
  readonly dataFreshness: string; // ISO-8601 of underlying snapshot
  readonly experimental: boolean;
}

export interface PriceQuote {
  readonly itemId: string;
  readonly name: string;
  readonly league: string;
  readonly divineValue: number;
  readonly exaltedValue: number | null;
  readonly chaosValue: number | null;
  readonly confidence: number;
  readonly asOf: string;
}

export interface TradePlanStep {
  readonly order: number;
  readonly instruction: string;
}

/** A human-executable plan. Exilium never executes trades. */
export interface TradePlan {
  readonly opportunityId: string;
  readonly summary: string;
  readonly steps: readonly TradePlanStep[];
  readonly expectedEdge: number;
  readonly goldFeeNote: string;
  readonly humanExecutionNote: string;
}
