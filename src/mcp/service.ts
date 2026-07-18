import type { Opportunity, PriceQuote, TradePlan } from '../domain/types.js';
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
  readonly league: string;
  readonly asOf: string | null;
  readonly categories: number;
  readonly topMovers: readonly MoverSummary[];
  readonly topVolume: readonly MoverSummary[];
}

export interface PairHistory {
  readonly itemId: string;
  readonly league: string;
  readonly points: readonly PricePoint[];
  readonly latestSparkline: readonly number[];
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

  leagues(): { leagues: readonly string[] } {
    return { leagues: this.repo.leaguesSeen() };
  }

  marketSnapshot(league: string): MarketSummary {
    const snaps = this.repo.latestAll(league);
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
      league,
      asOf: snaps[0]?.fetchedAt ?? null,
      categories: snaps.length,
      topMovers: [...lines].sort((a, b) => Math.abs(b.totalChange) - Math.abs(a.totalChange)).slice(0, TOP_N).map(toSummary),
      topVolume: [...lines].sort((a, b) => b.volumePrimaryValue - a.volumePrimaryValue).slice(0, TOP_N).map(toSummary),
    };
  }

  pairHistory(league: string, itemId: string, limit = 100): PairHistory {
    const latest = this.repo
      .latestAll(league)
      .flatMap((s) => s.lines)
      .find((l) => l.itemId === itemId);
    return {
      itemId,
      league,
      points: this.repo.history(league, itemId, limit),
      latestSparkline: latest?.sparkline ?? [],
    };
  }

  price(query: string, league: string): PriceQuote | null {
    return priceItem(query, this.repo.latestAll(league));
  }

  opportunities(league: string, includeExperimental: boolean, minEdge = 0): OpportunitiesResult {
    const snaps = this.repo.latestAll(league);
    const all = snaps.flatMap((s) => [
      ...detectMeanReversion(s, this.detectors),
      ...detectCrossRateDivergence(s, this.detectors),
    ]);
    const filtered = all
      .filter((o) => (includeExperimental || !o.experimental) && o.edge >= minEdge)
      .sort((a, b) => b.edge - a.edge);
    return { league, opportunities: filtered };
  }

  plan(league: string, opportunityId: string): TradePlan {
    const { opportunities } = this.opportunities(league, true);
    const opp = opportunities.find((o) => o.id === opportunityId);
    if (opp === undefined) {
      throw new Error(`Unknown opportunity id "${opportunityId}" — call find_opportunities first; ids are recomputed from the latest snapshot.`);
    }
    return draftTradePlan(opp);
  }
}
