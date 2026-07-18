import type { Db } from './db.js';
import type { CoreRates, MarketLine, MarketSnapshot } from '../domain/types.js';

interface SnapshotRow {
  readonly id: number;
  readonly league: string;
  readonly category: string;
  readonly fetched_at: string;
  readonly core_json: string;
}

interface LineRow {
  readonly item_id: string;
  readonly name: string;
  readonly primary_value: number;
  readonly volume_primary_value: number;
  readonly max_volume_currency: string | null;
  readonly max_volume_rate: number | null;
  readonly sparkline_json: string;
  readonly total_change: number;
}

export interface PricePoint {
  readonly fetchedAt: string;
  readonly primaryValue: number;
  readonly volumePrimaryValue: number;
}

export class SnapshotRepository {
  constructor(private readonly db: Db) {}

  save(snapshot: MarketSnapshot): void {
    const insertSnapshot = this.db.prepare(
      'INSERT INTO snapshots (league, category, fetched_at, core_json) VALUES (?, ?, ?, ?)',
    );
    const insertLine = this.db.prepare(
      `INSERT INTO market_lines
       (snapshot_id, item_id, name, primary_value, volume_primary_value, max_volume_currency, max_volume_rate, sparkline_json, total_change)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    );
    this.db.transaction(() => {
      const { lastInsertRowid } = insertSnapshot.run(
        snapshot.league,
        snapshot.category,
        snapshot.fetchedAt,
        JSON.stringify(snapshot.core),
      );
      for (const l of snapshot.lines) {
        insertLine.run(
          lastInsertRowid,
          l.itemId,
          l.name,
          l.primaryValue,
          l.volumePrimaryValue,
          l.maxVolumeCurrency,
          l.maxVolumeRate,
          JSON.stringify(l.sparkline),
          l.totalChange,
        );
      }
    })();
  }

  latest(league: string, category: string): MarketSnapshot | null {
    const row = this.db
      .prepare(
        'SELECT * FROM snapshots WHERE league = ? AND category = ? ORDER BY fetched_at DESC, id DESC LIMIT 1',
      )
      .get(league, category) as SnapshotRow | undefined;
    return row === undefined ? null : this.hydrate(row);
  }

  latestAll(league: string): readonly MarketSnapshot[] {
    const categories = this.db
      .prepare('SELECT DISTINCT category FROM snapshots WHERE league = ?')
      .all(league) as readonly { category: string }[];
    return categories.flatMap((c) => {
      const s = this.latest(league, c.category);
      return s === null ? [] : [s];
    });
  }

  history(league: string, itemId: string, limit: number): readonly PricePoint[] {
    const rows = this.db
      .prepare(
        `SELECT s.fetched_at, l.primary_value, l.volume_primary_value
         FROM market_lines l JOIN snapshots s ON s.id = l.snapshot_id
         WHERE s.league = ? AND l.item_id = ?
         ORDER BY s.fetched_at DESC LIMIT ?`,
      )
      .all(league, itemId, limit) as readonly { fetched_at: string; primary_value: number; volume_primary_value: number }[];
    return rows
      .map((r) => ({ fetchedAt: r.fetched_at, primaryValue: r.primary_value, volumePrimaryValue: r.volume_primary_value }))
      .reverse();
  }

  leaguesSeen(): readonly string[] {
    const rows = this.db.prepare('SELECT DISTINCT league FROM snapshots').all() as readonly { league: string }[];
    return rows.map((r) => r.league);
  }

  private hydrate(row: SnapshotRow): MarketSnapshot {
    const lines = this.db
      .prepare('SELECT * FROM market_lines WHERE snapshot_id = ?')
      .all(row.id) as readonly LineRow[];
    const core = JSON.parse(row.core_json) as CoreRates;
    const mapped: readonly MarketLine[] = lines.map((l) => ({
      itemId: l.item_id,
      name: l.name,
      category: row.category,
      primaryValue: l.primary_value,
      volumePrimaryValue: l.volume_primary_value,
      maxVolumeCurrency: l.max_volume_currency,
      maxVolumeRate: l.max_volume_rate,
      sparkline: JSON.parse(l.sparkline_json) as readonly number[],
      totalChange: l.total_change,
    }));
    return { league: row.league, category: row.category, fetchedAt: row.fetched_at, core, lines: mapped };
  }
}
