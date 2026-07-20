import { normalizeExchangeOverview } from '../sources/ninja/normalize.js';
import { normalizeItemOverview } from '../sources/ninja/normalize-items.js';
import type { Game } from '../domain/types.js';
import type { CategorySpec } from '../config.js';
import type { SnapshotRepository } from '../storage/snapshot-repository.js';

/** The subset of NinjaClient that ingestion needs (dependency inversion). */
export interface ExchangeSource {
  getExchangeOverview(game: Game, league: string, type: string): Promise<unknown>;
  getItemOverview?(game: Game, league: string, type: string): Promise<unknown>;
}

export interface IngestOptions {
  readonly game: Game;
  readonly league: string;
  readonly categories: readonly CategorySpec[];
  /** Injected clock (ISO-8601) — keeps ingestion deterministic in tests. */
  readonly now: () => string;
  /** Shared minimum seconds between sweeps across ALL processes (TUI +
   * dashboard + watch each have their own timer; the DB is the referee).
   * DEFAULTS ON (240s). Pass 0 to force — only `exilium ingest` does. */
  readonly minIntervalSec?: number;
  /** Item-listing categories are slow movers and huge (SkillGem alone is
   * 5k+ lines): they refresh at most hourly unless forced. */
  readonly itemsMinIntervalSec?: number;
}

export interface IngestError {
  readonly category: string;
  readonly message: string;
}

export interface IngestResult {
  readonly saved: readonly string[];
  readonly errors: readonly IngestError[];
  /** True when another process fetched recently and this sweep was skipped. */
  readonly skipped?: boolean;
}

/** Fetch, normalize, and store every category for a league. A failing
 * category is reported, never silently swallowed, and never aborts the rest. */
export async function ingestLeague(
  source: ExchangeSource,
  repo: SnapshotRepository,
  opts: IngestOptions,
): Promise<IngestResult> {
  const scope = `${opts.game}:${opts.league}`;
  const itemsScope = `${scope}:items`;
  const minInterval = opts.minIntervalSec ?? 240;
  if (minInterval > 0) {
    const last = repo.lastFetchAt(scope);
    if (last !== null && Date.parse(opts.now()) - Date.parse(last) < minInterval * 1000) {
      return { saved: [], errors: [], skipped: true };
    }
  }
  const itemsMinInterval = opts.itemsMinIntervalSec ?? (opts.minIntervalSec === 0 ? 0 : 3600);
  const lastItems = repo.lastFetchAt(itemsScope);
  const itemsDue =
    itemsMinInterval === 0 ||
    lastItems === null ||
    Date.parse(opts.now()) - Date.parse(lastItems) >= itemsMinInterval * 1000;

  const saved: string[] = [];
  const errors: IngestError[] = [];
  let itemsSaved = false;
  for (const spec of opts.categories) {
    if (spec.source === 'items' && !itemsDue) continue;
    try {
      const ctx = { game: opts.game, league: opts.league, category: spec.name, fetchedAt: opts.now() };
      let snapshot;
      if (spec.source === 'items') {
        if (source.getItemOverview === undefined) continue;
        snapshot = normalizeItemOverview(await source.getItemOverview(opts.game, opts.league, spec.name), ctx);
        itemsSaved = true;
      } else {
        snapshot = normalizeExchangeOverview(await source.getExchangeOverview(opts.game, opts.league, spec.name), ctx);
      }
      repo.save(snapshot);
      saved.push(spec.name);
    } catch (err) {
      errors.push({ category: spec.name, message: err instanceof Error ? err.message : String(err) });
    }
  }
  if (saved.length > 0) repo.setLastFetchAt(scope, opts.now());
  if (itemsSaved) repo.setLastFetchAt(itemsScope, opts.now());
  // Retention: history older than 48h downsamples to hourly. Without this a
  // 24/7 companion writes ~170K rows/day forever.
  repo.prune(opts.now(), 48);
  return { saved, errors };
}
