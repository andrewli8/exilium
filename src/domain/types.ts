/** Core immutable domain types. All prices are denominated in the game's
 * primary currency (PoE1: Chaos Orb, PoE2: Divine Orb) unless a field name
 * says otherwise. */

export type Game = 'poe1' | 'poe2';

export interface League {
  readonly id: string;
  readonly name: string;
}

/** One market line from the in-game Currency Exchange, normalized. */
export interface MarketLine {
  readonly itemId: string;
  readonly name: string;
  readonly category: string;
  /** Price in the game's primary currency. */
  readonly primaryValue: number;
  /** Total traded volume, denominated in the primary currency. */
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

/** Reference rates from the snapshot core: units per one primary-currency
 * unit (PoE1 primary: chaos; PoE2 primary: divine). */
export interface CoreRates {
  readonly primary: string;
  readonly perPrimary: Readonly<Record<string, number>>;
}

export interface MarketSnapshot {
  readonly game: Game;
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
  readonly game: Game;
  readonly league: string;
  readonly itemId: string;
  readonly itemName: string;
  readonly category: string;
  /** Expected edge as a fraction (0.05 = 5%), before gold fees. */
  readonly edge: number;
  /** 0..1 heuristic confidence (volume- and freshness-driven). */
  readonly confidence: number;
  /** Trade direction the signal implies; null when the signal has no
   * single direction (e.g. cross-rate divergence has two legs). */
  readonly direction: 'buy' | 'sell' | null;
  readonly rationale: string;
  readonly dataFreshness: string; // ISO-8601 of underlying snapshot
  readonly experimental: boolean;
}

export interface PriceQuote {
  readonly itemId: string;
  readonly name: string;
  readonly game: Game;
  readonly league: string;
  /** The game's pricing unit for this quote (PoE1: chaos, PoE2: divine). */
  readonly primaryCurrency: string;
  readonly primaryValue: number;
  /** Value converted into each other core currency (e.g. divine, exalted). */
  readonly conversions: Readonly<Record<string, number>>;
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
