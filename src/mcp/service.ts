import type { Game, Opportunity, PriceQuote, TradePlan } from '../domain/types.js';
import { detectCrossRateDivergence } from '../signals/cross-rate.js';
import { detectMeanReversion } from '../signals/mean-reversion.js';
import { draftTradePlan } from '../signals/trade-plan.js';
import { priceItem } from '../pricing/price-item.js';
import { evaluateWatches } from '../signals/watch-eval.js';
import type { PricePoint, SnapshotRepository } from '../storage/snapshot-repository.js';
import type { Watch, WatchEvent, WatchRepository } from '../storage/watch-repository.js';
import type { JournalEntry, JournalEntryInput, JournalRepository, JournalSummary } from '../storage/journal-repository.js';
import { assessFreshness } from '../domain/freshness.js';
import { change24hFromHistory, change24hFromSparkline } from '../signals/change24h.js';
import { runBacktest } from '../backtest/backtest.js';
import type { BacktestReport } from '../backtest/backtest.js';
import type { OpportunityLogRepository } from '../storage/opportunity-log-repository.js';

export interface DetectorConfig {
  readonly minVolume: number;
  readonly zThreshold: number;
  readonly minDeviationPct: number;
  readonly minDivergence: number;
}

const DEFAULT_DETECTORS: DetectorConfig = { minVolume: 100, zThreshold: 1.5, minDeviationPct: 10, minDivergence: 0.03 };

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
  /** 24h change %: stored history first, sparkline last-day segment as
   * fallback, null on day one. */
  readonly change24h: number | null;
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
  /** Divines per one primary unit (null when the rate is unknown). */
  readonly divinePerPrimary: number | null;
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
    private readonly journal?: JournalRepository,
    private readonly oppLog?: OpportunityLogRepository,
  ) {}

  /** Persist the current signals durably (idempotent per id+asOf). Called by
   * refresh loops so ids referenced by plans/journal/watches stay resolvable. */
  logOpportunities(game: Game, league: string): void {
    if (this.oppLog === undefined) return;
    this.oppLog.record(this.opportunities(game, league, true).opportunities);
  }

  /** Resolve an opportunity id: live signals first, then the durable log. */
  resolveOpportunity(game: Game, league: string, id: string): Opportunity | null {
    const live = this.opportunities(game, league, true).opportunities.find((o) => o.id === id);
    if (live !== undefined) return live;
    return this.oppLog?.resolve(id) ?? null;
  }

  /** Per-detector track record: journal fill reality + cached backtest. */
  trackRecord(game: Game, league: string): Record<string, { journalFillRate: number | null; journalCount: number; backtest: { hitRate: number; baselineHitRate: number; signals: number } | null }> {
    const journal = this.journal?.summary();
    const backtest = this.cachedBacktest(game, league, 6);
    const detectors = new Set<string>(['mean-reversion', 'cross-rate-divergence']);
    for (const d of Object.keys(journal?.perDetector ?? {})) detectors.add(d);
    return Object.fromEntries(
      [...detectors].map((d) => {
        const j = journal?.perDetector[d];
        const b = backtest?.perDetector[d];
        return [
          d,
          {
            journalFillRate: j?.fillRate ?? null,
            journalCount: j?.total ?? 0,
            backtest: b === undefined ? null : { hitRate: b.hitRate, baselineHitRate: b.baselineHitRate, signals: b.signals },
          },
        ];
      }),
    );
  }

  private backtestCache = new Map<string, { maxAsOf: string | null; report: BacktestReport }>();

  /** Backtest over stored history, cached until new snapshots arrive. */
  cachedBacktest(game: Game, league: string, horizonHours: number): BacktestReport {
    const latest = this.repo.latestAll(game, league);
    const maxAsOf = latest[0]?.fetchedAt ?? null;
    const key = `${game}:${league}:${horizonHours}`;
    const cached = this.backtestCache.get(key);
    if (cached !== undefined && cached.maxAsOf === maxAsOf) return cached.report;
    const merged: Record<string, { signals: number; wins: number; moveSum: number; baseSum: number }> = {};
    let ticks = 0;
    let skipped = 0;
    let from: string | null = null;
    let to: string | null = null;
    for (const s of latest) {
      const report = runBacktest(this.repo.snapshotTimeline(game, league, s.category), {
        horizonHours,
        detectors: this.detectors,
      });
      ticks = Math.max(ticks, report.ticks);
      skipped += report.skippedNoHorizon;
      if (report.from !== null && (from === null || report.from < from)) from = report.from;
      if (report.to !== null && (to === null || report.to > to)) to = report.to;
      for (const [kind, d] of Object.entries(report.perDetector)) {
        const e = merged[kind] ?? { signals: 0, wins: 0, moveSum: 0, baseSum: 0 };
        merged[kind] = {
          signals: e.signals + d.signals,
          wins: e.wins + d.wins,
          moveSum: e.moveSum + d.avgForwardMovePct * d.signals,
          baseSum: e.baseSum + d.baselineHitRate * d.signals,
        };
      }
    }
    const report: BacktestReport = {
      ticks,
      from,
      to,
      skippedNoHorizon: skipped,
      perDetector: Object.fromEntries(
        Object.entries(merged).map(([kind, e]) => [
          kind,
          {
            signals: e.signals,
            wins: e.wins,
            hitRate: e.signals === 0 ? 0 : e.wins / e.signals,
            avgForwardMovePct: e.signals === 0 ? 0 : e.moveSum / e.signals,
            baselineHitRate: e.signals === 0 ? 0 : e.baseSum / e.signals,
          },
        ]),
      ),
    };
    this.backtestCache.set(key, { maxAsOf, report });
    return report;
  }

  /** Freshness envelope for MCP responses. */
  freshness(game: Game, league: string): { asOf: string | null; ageSec: number | null; level: string | null } {
    const asOf = this.repo.latestAll(game, league)[0]?.fetchedAt ?? null;
    const f = assessFreshness(asOf, Date.now());
    return { asOf, ageSec: f?.ageSec ?? null, level: f?.level ?? null };
  }

  private requireJournal(): JournalRepository {
    if (this.journal === undefined) throw new Error('Journal is not enabled for this service instance.');
    return this.journal;
  }

  recordOutcome(entry: JournalEntryInput): JournalSummary {
    const journal = this.requireJournal();
    journal.record(entry);
    return journal.summary();
  }

  recordOutcomeIdempotent(entry: JournalEntryInput): { recorded: boolean; summary: JournalSummary } {
    const journal = this.requireJournal();
    const recorded = journal.record(entry);
    return { recorded, summary: journal.summary() };
  }

  journalEntries(limit = 50): { entries: readonly JournalEntry[]; summary: JournalSummary } {
    const journal = this.requireJournal();
    return { entries: journal.list(limit), summary: journal.summary() };
  }

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

  recentWatchEvents(limit = 20): readonly WatchEvent[] {
    return this.requireWatches().latestEvents(limit);
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
        change24h: change24hFromSparkline(l.sparkline),
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
      divinePerPrimary:
        snaps[0]?.core.primary === 'divine' ? 1 : snaps[0]?.core.perPrimary['divine'] ?? null,
      league,
      asOf: snaps[0]?.fetchedAt ?? null,
      categories: snaps.length,
      topMovers: [...lines].sort((a, b) => Math.abs(b.totalChange) - Math.abs(a.totalChange)).slice(0, TOP_N).map(toSummary),
      topVolume: [...lines].sort((a, b) => b.volumePrimaryValue - a.volumePrimaryValue).slice(0, TOP_N).map(toSummary),
    };
  }

  /** Top movers including sparklines and 24h change. Ranked by |24h change|
   * when derivable, falling back to the 7d figure. */
  moversDetailed(game: Game, league: string, limit: number, category?: string): readonly DetailedMover[] {
    const snaps = this.repo
      .latestAll(game, league)
      .filter((s) => category === undefined || s.category.toLowerCase() === category.toLowerCase());
    const nowMs = Date.now();
    const dayAgoByCategory = new Map<string, ReadonlyMap<string, number>>();
    for (const s of snaps) {
      dayAgoByCategory.set(
        s.category,
        this.repo.pricesNear(game, league, s.category, new Date(nowMs - 24 * 3600_000).toISOString(), 6),
      );
    }
    return snaps
      .flatMap((s) => s.lines)
      .map((l) => {
        const dayAgo = dayAgoByCategory.get(l.category)?.get(l.itemId);
        const fromHistory =
          dayAgo !== undefined && dayAgo > 0 ? ((l.primaryValue - dayAgo) / dayAgo) * 100 : null;
        const change24h = fromHistory ?? change24hFromSparkline(l.sparkline);
        return {
          itemId: l.itemId,
          name: l.name,
          category: l.category,
          primaryValue: l.primaryValue,
          totalChange: l.totalChange,
          volumePrimaryValue: l.volumePrimaryValue,
          sparkline: l.sparkline,
          change24h,
        };
      })
      .sort((a, b) => Math.abs(b.change24h ?? b.totalChange) - Math.abs(a.change24h ?? a.totalChange))
      .slice(0, limit);
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
    const opp = this.resolveOpportunity(game, league, opportunityId);
    if (opp === null) {
      throw new Error(`Unknown opportunity id "${opportunityId}" — not in current signals or the opportunity log. Call find_opportunities first.`);
    }
    return draftTradePlan(opp);
  }
}
