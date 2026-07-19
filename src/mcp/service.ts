import type { Game, Opportunity, PriceQuote, TradePlan } from '../domain/types.js';
import { detectCrossRateDivergence } from '../signals/cross-rate.js';
import { detectMeanReversion } from '../signals/mean-reversion.js';
import { draftTradePlan } from '../signals/trade-plan.js';
import { priceItem } from '../pricing/price-item.js';
import type { PricePoint, SnapshotRepository } from '../storage/snapshot-repository.js';

export interface DetectorConfig {
  readonly minVolume: number;
  readonly zThreshold: number;
  readonly minDivergence: number;
}

const DEFAULT_DETECTORS: DetectorConfig = { minVolume: 100, zThreshold: 1.5, minDivergence: 0.03 };

export interface MoverSummary {
  readonly itemId: string;
  readonly name: string;
  readonly category: string;
  readonly primaryValue: number;
  readonly totalChange: number;
  readonly volumePrimaryValue: number;
}

export interface MarketSummary {
  readonly game: Game;
  readonly primaryCurrency: string;
  readonly league: string;
  readonly asOf: string | null;
  readonly categories: number;
  readonly topMovers: readonly MoverSummary[];
  readonly topVolume: readonly MoverSummary[];
}

export interface PairHistory {
  readonly itemId: string;
  readonly game: Game;
  readonly league: string;
  readonly points: readonly PricePoint[];
  readonly latestSparkline: readonly number[];
}

/** One market's cross-rate consistency check — the raw arbitrage view. */
export interface ArbRow {
  readonly itemId: string;
  readonly itemName: string;
  readonly category: string;
  /** Listed price in the primary currency. */
  readonly listed: number;
  /** Price implied by the highest-volume quote pair and core rates. */
  readonly implied: number;
  readonly quoteCurrency: string;
  readonly divergencePct: number;
  readonly volumePrimaryValue: number;
}

export interface OpportunitiesResult {
  readonly league: string;
  readonly opportunities: readonly Opportunity[];
}

const TOP_N = 10;

/** Serves the MCP tool surface from stored snapshots only — this layer never
 * performs upstream requests (PRD invariant: agents cannot spend our quota). */
export class ExiliumService {
  constructor(
    private readonly repo: SnapshotRepository,
    private readonly detectors: DetectorConfig = DEFAULT_DETECTORS,
  ) {}

  leagues(): { leagues: readonly { game: Game; league: string }[] } {
    return { leagues: this.repo.leaguesSeen() };
  }

  marketSnapshot(game: Game, league: string): MarketSummary {
    const snaps = this.repo.latestAll(game, league);
    const lines = snaps.flatMap((s) => s.lines);
    const toSummary = (l: (typeof lines)[number]): MoverSummary => ({
      itemId: l.itemId,
      name: l.name,
      category: l.category,
      primaryValue: l.primaryValue,
      totalChange: l.totalChange,
      volumePrimaryValue: l.volumePrimaryValue,
    });
    return {
      game,
      primaryCurrency: snaps[0]?.core.primary ?? 'chaos',
      league,
      asOf: snaps[0]?.fetchedAt ?? null,
      categories: snaps.length,
      topMovers: [...lines].sort((a, b) => Math.abs(b.totalChange) - Math.abs(a.totalChange)).slice(0, TOP_N).map(toSummary),
      topVolume: [...lines].sort((a, b) => b.volumePrimaryValue - a.volumePrimaryValue).slice(0, TOP_N).map(toSummary),
    };
  }

  pairHistory(game: Game, league: string, itemId: string, limit = 100): PairHistory {
    const latest = this.repo
      .latestAll(game, league)
      .flatMap((s) => s.lines)
      .find((l) => l.itemId === itemId);
    return {
      itemId,
      game,
      league,
      points: this.repo.history(game, league, itemId, limit),
      latestSparkline: latest?.sparkline ?? [],
    };
  }

  price(query: string, game: Game, league: string): PriceQuote | null {
    return priceItem(query, this.repo.latestAll(game, league));
  }

  opportunities(game: Game, league: string, includeExperimental: boolean, minEdge = 0): OpportunitiesResult {
    const snaps = this.repo.latestAll(game, league);
    const all = snaps.flatMap((s) => [
      ...detectMeanReversion(s, this.detectors),
      ...detectCrossRateDivergence(s, this.detectors),
    ]);
    const filtered = all
      .filter((o) => (includeExperimental || !o.experimental) && o.edge >= minEdge)
      .sort((a, b) => b.edge - a.edge);
    return { league, opportunities: filtered };
  }

  /** Raw cross-rate arbitrage table: listed vs implied price for every
   * market with a usable quote pair, regardless of threshold. */
  arbitrage(game: Game, league: string, minDivergencePct = 0): readonly ArbRow[] {
    const snaps = this.repo.latestAll(game, league);
    const rows = snaps.flatMap((s) =>
      s.lines.flatMap((l): ArbRow[] => {
        if (l.maxVolumeCurrency === null || l.maxVolumeRate === null || l.maxVolumeRate <= 0) return [];
        const quotePerPrimary = s.core.perPrimary[l.maxVolumeCurrency];
        if (quotePerPrimary === undefined || quotePerPrimary <= 0) return [];
        const implied = 1 / (l.maxVolumeRate * quotePerPrimary);
        const divergencePct = Math.abs(1 - implied / l.primaryValue) * 100;
        if (divergencePct < minDivergencePct) return [];
        return [
          {
            itemId: l.itemId,
            itemName: l.name,
            category: l.category,
            listed: l.primaryValue,
            implied,
            quoteCurrency: l.maxVolumeCurrency,
            divergencePct,
            volumePrimaryValue: l.volumePrimaryValue,
          },
        ];
      }),
    );
    return [...rows].sort((a, b) => b.divergencePct - a.divergencePct);
  }

  plan(game: Game, league: string, opportunityId: string): TradePlan {
    const { opportunities } = this.opportunities(game, league, true);
    const opp = opportunities.find((o) => o.id === opportunityId);
    if (opp === undefined) {
      throw new Error(`Unknown opportunity id "${opportunityId}" — call find_opportunities first; ids are recomputed from the latest snapshot.`);
    }
    return draftTradePlan(opp);
  }
}
