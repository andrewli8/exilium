import type { Game, Opportunity, PriceQuote, TradePlan } from '../domain/types.js';
import { detectCrossRateDivergence } from '../signals/cross-rate.js';
import { detectMeanReversion } from '../signals/mean-reversion.js';
import { draftTradePlan } from '../signals/trade-plan.js';
import { priceItem } from '../pricing/price-item.js';
import { evaluateWatches } from '../signals/watch-eval.js';
import type { PricePoint, SnapshotRepository } from '../storage/snapshot-repository.js';
import type { Watch, WatchEvent, WatchRepository } from '../storage/watch-repository.js';

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

export interface DetailedMover extends MoverSummary {
  readonly sparkline: readonly number[];
}

export interface CategorySummary {
  readonly category: string;
  readonly markets: number;
  readonly volumePrimaryValue: number;
}

export type ItemSort = 'value' | 'volume' | 'change';

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
export interface FiredWatchEvent {
  readonly watchId: string;
  readonly webhookUrl: string | null;
  readonly payload: Record<string, unknown>;
}

export class ExiliumService {
  constructor(
    private readonly repo: SnapshotRepository,
    private readonly detectors: DetectorConfig = DEFAULT_DETECTORS,
    private readonly watches?: WatchRepository,
  ) {}

  private requireWatches(): WatchRepository {
    if (this.watches === undefined) throw new Error('Watches are not enabled for this service instance.');
    return this.watches;
  }

  createWatch(watch: Watch): Watch {
    this.requireWatches().upsert(watch);
    return watch;
  }

  listWatches(): readonly Watch[] {
    return this.requireWatches().list();
  }

  deleteWatch(id: string): boolean {
    const repo = this.requireWatches();
    const existed = repo.list(true).some((w) => w.id === id);
    repo.delete(id);
    return existed;
  }

  /** Evaluate all active watches against the latest snapshots, record fresh
   * events (deduped per snapshot instance), deactivate 'once' watches that
   * fired, and return what fired with any webhook targets. */
  runWatchEvaluation(): readonly FiredWatchEvent[] {
    const repo = this.requireWatches();
    const active = repo.list();
    const events = evaluateWatches(active, this, (watchId, key) => repo.hasEvent(watchId, key));
    repo.recordEvents(events);
    const byId = new Map(active.map((w) => [w.id, w]));
    const firedOnce = new Set(
      events.map((e) => e.watchId).filter((id) => byId.get(id)?.mode === 'once'),
    );
    for (const id of firedOnce) repo.deactivate(id);
    return events.map((e) => ({
      watchId: e.watchId,
      webhookUrl: byId.get(e.watchId)?.webhookUrl ?? null,
      payload: e.payload,
    }));
  }

  pollWatchResults(cursor: number, limit: number): { events: readonly WatchEvent[]; nextCursor: number } {
    this.runWatchEvaluation();
    const events = this.requireWatches().eventsSince(cursor, limit);
    return { events, nextCursor: events.length === 0 ? cursor : events[events.length - 1]!.seq };
  }

  leagues(): { leagues: readonly { game: Game; league: string }[] } {
    return { leagues: this.repo.leaguesSeen() };
  }

  /** Per-category market counts and traded volume, sorted by volume. */
  categoryList(game: Game, league: string): readonly CategorySummary[] {
    return this.repo
      .latestAll(game, league)
      .map((s) => ({
        category: s.category,
        markets: s.lines.length,
        volumePrimaryValue: s.lines.reduce((acc, l) => acc + l.volumePrimaryValue, 0),
      }))
      .sort((a, b) => b.volumePrimaryValue - a.volumePrimaryValue);
  }

  /** Every market in one category (case-insensitive), sorted by value,
   * volume, or change. Throws listing valid categories on a bad name. */
  listItems(game: Game, league: string, category: string, sort: ItemSort = 'value'): readonly DetailedMover[] {
    const snaps = this.repo.latestAll(game, league);
    const match = snaps.find((s) => s.category.toLowerCase() === category.toLowerCase());
    if (match === undefined) {
      const valid = snaps.map((s) => s.category).join(', ');
      throw new Error(`Unknown category "${category}" for ${game}/${league}. Available: ${valid}`);
    }
    const sorters: Record<ItemSort, (a: DetailedMover, b: DetailedMover) => number> = {
      value: (a, b) => b.primaryValue - a.primaryValue,
      volume: (a, b) => b.volumePrimaryValue - a.volumePrimaryValue,
      change: (a, b) => Math.abs(b.totalChange) - Math.abs(a.totalChange),
    };
    return match.lines
      .map((l) => ({
        itemId: l.itemId,
        name: l.name,
        category: l.category,
        primaryValue: l.primaryValue,
        totalChange: l.totalChange,
        volumePrimaryValue: l.volumePrimaryValue,
        sparkline: l.sparkline,
      }))
      .sort(sorters[sort]);
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

  /** Top movers including their sparkline series (for the TUI detail pane). */
  moversDetailed(game: Game, league: string, limit: number, category?: string): readonly DetailedMover[] {
    return this.repo
      .latestAll(game, league)
      .filter((s) => category === undefined || s.category.toLowerCase() === category.toLowerCase())
      .flatMap((s) => s.lines)
      .sort((a, b) => Math.abs(b.totalChange) - Math.abs(a.totalChange))
      .slice(0, limit)
      .map((l) => ({
        itemId: l.itemId,
        name: l.name,
        category: l.category,
        primaryValue: l.primaryValue,
        totalChange: l.totalChange,
        volumePrimaryValue: l.volumePrimaryValue,
        sparkline: l.sparkline,
      }));
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

  opportunities(game: Game, league: string, includeExperimental: boolean, minEdge = 0, category?: string): OpportunitiesResult {
    const snaps = this.repo
      .latestAll(game, league)
      .filter((s) => category === undefined || s.category.toLowerCase() === category.toLowerCase());
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
  arbitrage(game: Game, league: string, minDivergencePct = 0, category?: string): readonly ArbRow[] {
    const snaps = this.repo
      .latestAll(game, league)
      .filter((s) => category === undefined || s.category.toLowerCase() === category.toLowerCase());
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
