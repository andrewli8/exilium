import type { Db } from './db.js';
import type { Game } from '../domain/types.js';
import type { StashItem } from '../trade/stash.js';

export interface StashSnapshotInput {
  readonly game: Game;
  readonly league: string;
  readonly account: string;
  readonly takenAt: string;
  readonly totalValue: number;
  readonly items: readonly StashItem[];
}

export interface StashSnapshot extends StashSnapshotInput {
  readonly id: number;
}

export interface NetWorthPoint {
  readonly takenAt: string;
  readonly totalValue: number;
}

/** Stash snapshots over time: the delta baseline for "did my trades actually
 * happen" and the net-worth line every economy tool lives on. */
export class StashRepository {
  constructor(private readonly db: Db) {}

  save(input: StashSnapshotInput): void {
    this.db
      .prepare(
        'INSERT INTO stash_snapshots (game, league, account, taken_at, total_value, items_json) VALUES (?, ?, ?, ?, ?, ?)',
      )
      .run(input.game, input.league, input.account, input.takenAt, input.totalValue, JSON.stringify(input.items));
  }

  latest(game: Game, league: string, account: string): StashSnapshot | null {
    const row = this.db
      .prepare(
        'SELECT * FROM stash_snapshots WHERE game = ? AND league = ? AND account = ? ORDER BY taken_at DESC, id DESC LIMIT 1',
      )
      .get(game, league, account) as
      | { id: number; game: Game; league: string; account: string; taken_at: string; total_value: number; items_json: string }
      | undefined;
    if (row === undefined) return null;
    return {
      id: row.id,
      game: row.game,
      league: row.league,
      account: row.account,
      takenAt: row.taken_at,
      totalValue: row.total_value,
      items: JSON.parse(row.items_json) as readonly StashItem[],
    };
  }

  netWorthHistory(game: Game, league: string, account: string, limit: number): readonly NetWorthPoint[] {
    const rows = this.db
      .prepare(
        'SELECT taken_at, total_value FROM stash_snapshots WHERE game = ? AND league = ? AND account = ? ORDER BY taken_at DESC LIMIT ?',
      )
      .all(game, league, account, limit) as readonly { taken_at: string; total_value: number }[];
    return rows.map((r) => ({ takenAt: r.taken_at, totalValue: r.total_value })).reverse();
  }
}
