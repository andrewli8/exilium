import { normalizeExchangeOverview } from '../sources/ninja/normalize.js';
import type { Game } from '../domain/types.js';
import type { SnapshotRepository } from '../storage/snapshot-repository.js';

/** The subset of NinjaClient that ingestion needs (dependency inversion). */
export interface ExchangeSource {
  getExchangeOverview(game: Game, league: string, type: string): Promise<unknown>;
}

export interface IngestOptions {
  readonly game: Game;
  readonly league: string;
  readonly categories: readonly string[];
  /** Injected clock (ISO-8601) — keeps ingestion deterministic in tests. */
  readonly now: () => string;
  /** Shared minimum seconds between sweeps across ALL processes (TUI +
   * dashboard + watch each have their own timer; the DB is the referee). */
  readonly minIntervalSec?: number;
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
  const minInterval = opts.minIntervalSec ?? 0;
  if (minInterval > 0) {
    const last = repo.lastFetchAt(scope);
    if (last !== null && Date.parse(opts.now()) - Date.parse(last) < minInterval * 1000) {
      return { saved: [], errors: [], skipped: true };
    }
  }
  const saved: string[] = [];
  const errors: IngestError[] = [];
  for (const category of opts.categories) {
    try {
      const raw = await source.getExchangeOverview(opts.game, opts.league, category);
      const snapshot = normalizeExchangeOverview(raw, {
        game: opts.game,
        league: opts.league,
        category,
        fetchedAt: opts.now(),
      });
      repo.save(snapshot);
      saved.push(category);
    } catch (err) {
      errors.push({ category, message: err instanceof Error ? err.message : String(err) });
    }
  }
  if (saved.length > 0) repo.setLastFetchAt(scope, opts.now());
  // Retention: history older than 48h downsamples to hourly. Without this a
  // 24/7 companion writes ~170K rows/day forever.
  repo.prune(opts.now(), 48);
  return { saved, errors };
}
