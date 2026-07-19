import type { Db } from './db.js';
import type { Game, Opportunity } from '../domain/types.js';

/** Durable record of every signal the detectors fired. This is the spine of
 * the accuracy loop: trade plans, journal entries, and watch events all
 * reference opportunity ids, and without this log those ids decay as soon as
 * the next snapshot lands. */
export class OpportunityLogRepository {
  constructor(private readonly db: Db) {}

  record(opportunities: readonly Opportunity[]): void {
    const insert = this.db.prepare(
      `INSERT OR IGNORE INTO opportunity_log
       (id, as_of, detector, game, league, item_id, item_name, edge, direction, confidence, category, rationale, experimental)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    );
    this.db.transaction(() => {
      for (const o of opportunities) {
        insert.run(
          o.id,
          o.dataFreshness,
          o.kind,
          o.game,
          o.league,
          o.itemId,
          o.itemName,
          o.edge,
          o.direction,
          o.confidence,
          o.category,
          o.rationale,
          o.experimental ? 1 : 0,
        );
      }
    })();
  }

  /** Latest logged instance of an opportunity id, reconstructed fully enough
   * to draft a trade plan from history. */
  resolve(id: string): Opportunity | null {
    const row = this.db
      .prepare('SELECT * FROM opportunity_log WHERE id = ? ORDER BY as_of DESC LIMIT 1')
      .get(id) as
      | {
          id: string;
          as_of: string;
          detector: Opportunity['kind'];
          game: Game;
          league: string;
          item_id: string;
          item_name: string;
          edge: number;
          direction: 'buy' | 'sell' | null;
          confidence: number;
          category: string | null;
          rationale: string | null;
          experimental: number | null;
        }
      | undefined;
    if (row === undefined) return null;
    return {
      id: row.id,
      kind: row.detector,
      game: row.game,
      league: row.league,
      itemId: row.item_id,
      itemName: row.item_name,
      category: row.category ?? 'Unknown',
      edge: row.edge,
      confidence: row.confidence,
      direction: row.direction,
      rationale: row.rationale ?? '(logged signal — rationale not recorded)',
      dataFreshness: row.as_of,
      experimental: row.experimental === 1,
    };
  }

  countFor(id: string): number {
    return (this.db.prepare('SELECT COUNT(*) AS n FROM opportunity_log WHERE id = ?').get(id) as { n: number }).n;
  }
}
