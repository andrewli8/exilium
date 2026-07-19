import type { Db } from './db.js';
import type { Game } from '../domain/types.js';

export type WatchKind = 'price_above' | 'price_below' | 'change_abs' | 'opportunity';
export type WatchMode = 'once' | 'repeat';

export interface Watch {
  readonly id: string;
  readonly game: Game;
  readonly league: string;
  readonly kind: WatchKind;
  readonly itemId: string | null;
  readonly category: string | null;
  /** price_above/below: price in primary currency; change_abs & opportunity: percent. */
  readonly threshold: number;
  readonly mode: WatchMode;
  readonly webhookUrl: string | null;
  readonly createdAt: string;
  readonly active: boolean;
}

export interface WatchEventInput {
  readonly watchId: string;
  readonly firedAt: string;
  readonly payload: Record<string, unknown>;
  /** Prevents refiring for the same condition instance (item + snapshot). */
  readonly dedupeKey: string;
}

export interface WatchEvent extends WatchEventInput {
  readonly seq: number;
}

const SCHEMA = `
CREATE TABLE IF NOT EXISTS watches (
  id TEXT PRIMARY KEY,
  game TEXT NOT NULL,
  league TEXT NOT NULL,
  kind TEXT NOT NULL,
  item_id TEXT,
  category TEXT,
  threshold REAL NOT NULL,
  mode TEXT NOT NULL DEFAULT 'once',
  webhook_url TEXT,
  created_at TEXT NOT NULL,
  active INTEGER NOT NULL DEFAULT 1
);
CREATE TABLE IF NOT EXISTS watch_events (
  seq INTEGER PRIMARY KEY AUTOINCREMENT,
  watch_id TEXT NOT NULL,
  fired_at TEXT NOT NULL,
  payload_json TEXT NOT NULL,
  dedupe_key TEXT NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_watch_events_dedupe ON watch_events (watch_id, dedupe_key);
`;

interface WatchRow {
  readonly id: string;
  readonly game: Game;
  readonly league: string;
  readonly kind: WatchKind;
  readonly item_id: string | null;
  readonly category: string | null;
  readonly threshold: number;
  readonly mode: WatchMode;
  readonly webhook_url: string | null;
  readonly created_at: string;
  readonly active: number;
}

export class WatchRepository {
  constructor(private readonly db: Db) {
    db.exec(SCHEMA);
  }

  upsert(watch: Watch): void {
    this.db
      .prepare(
        `INSERT INTO watches (id, game, league, kind, item_id, category, threshold, mode, webhook_url, created_at, active)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(id) DO UPDATE SET
           game=excluded.game, league=excluded.league, kind=excluded.kind, item_id=excluded.item_id,
           category=excluded.category, threshold=excluded.threshold, mode=excluded.mode,
           webhook_url=excluded.webhook_url, active=excluded.active`,
      )
      .run(
        watch.id,
        watch.game,
        watch.league,
        watch.kind,
        watch.itemId,
        watch.category,
        watch.threshold,
        watch.mode,
        watch.webhookUrl,
        watch.createdAt,
        watch.active ? 1 : 0,
      );
  }

  list(includeInactive = false): readonly Watch[] {
    const rows = this.db
      .prepare(`SELECT * FROM watches ${includeInactive ? '' : 'WHERE active = 1'} ORDER BY created_at`)
      .all() as readonly WatchRow[];
    return rows.map((r) => ({
      id: r.id,
      game: r.game,
      league: r.league,
      kind: r.kind,
      itemId: r.item_id,
      category: r.category,
      threshold: r.threshold,
      mode: r.mode,
      webhookUrl: r.webhook_url,
      createdAt: r.created_at,
      active: r.active === 1,
    }));
  }

  deactivate(id: string): void {
    this.db.prepare('UPDATE watches SET active = 0 WHERE id = ?').run(id);
  }

  delete(id: string): void {
    this.db.transaction(() => {
      this.db.prepare('DELETE FROM watch_events WHERE watch_id = ?').run(id);
      this.db.prepare('DELETE FROM watches WHERE id = ?').run(id);
    })();
  }

  recordEvents(events: readonly WatchEventInput[]): void {
    const insert = this.db.prepare(
      'INSERT OR IGNORE INTO watch_events (watch_id, fired_at, payload_json, dedupe_key) VALUES (?, ?, ?, ?)',
    );
    this.db.transaction(() => {
      for (const e of events) insert.run(e.watchId, e.firedAt, JSON.stringify(e.payload), e.dedupeKey);
    })();
  }

  hasEvent(watchId: string, dedupeKey: string): boolean {
    return (
      this.db
        .prepare('SELECT 1 FROM watch_events WHERE watch_id = ? AND dedupe_key = ? LIMIT 1')
        .get(watchId, dedupeKey) !== undefined
    );
  }

  eventsSince(cursorSeq: number, limit: number): readonly WatchEvent[] {
    const rows = this.db
      .prepare('SELECT * FROM watch_events WHERE seq > ? ORDER BY seq LIMIT ?')
      .all(cursorSeq, limit) as readonly { seq: number; watch_id: string; fired_at: string; payload_json: string; dedupe_key: string }[];
    return rows.map((r) => ({
      seq: r.seq,
      watchId: r.watch_id,
      firedAt: r.fired_at,
      payload: JSON.parse(r.payload_json) as Record<string, unknown>,
      dedupeKey: r.dedupe_key,
    }));
  }
}
