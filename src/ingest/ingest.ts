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
}

export interface IngestError {
  readonly category: string;
  readonly message: string;
}

export interface IngestResult {
  readonly saved: readonly string[];
  readonly errors: readonly IngestError[];
}

/** Fetch, normalize, and store every category for a league. A failing
 * category is reported, never silently swallowed, and never aborts the rest. */
export async function ingestLeague(
  source: ExchangeSource,
  repo: SnapshotRepository,
  opts: IngestOptions,
): Promise<IngestResult> {
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
  return { saved, errors };
}
