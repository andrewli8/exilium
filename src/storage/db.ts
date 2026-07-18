import Database from 'better-sqlite3';

export type Db = Database.Database;

const SCHEMA = `
CREATE TABLE IF NOT EXISTS snapshots (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  game TEXT NOT NULL,
  league TEXT NOT NULL,
  category TEXT NOT NULL,
  fetched_at TEXT NOT NULL,
  core_json TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_snapshots_lookup ON snapshots (game, league, category, fetched_at);

CREATE TABLE IF NOT EXISTS market_lines (
  snapshot_id INTEGER NOT NULL REFERENCES snapshots(id) ON DELETE CASCADE,
  item_id TEXT NOT NULL,
  name TEXT NOT NULL,
  primary_value REAL NOT NULL,
  volume_primary_value REAL NOT NULL,
  max_volume_currency TEXT,
  max_volume_rate REAL,
  sparkline_json TEXT NOT NULL,
  total_change REAL NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_lines_item ON market_lines (item_id, snapshot_id);
`;

/** Open (or create) the Exilium SQLite database and apply the schema. */
export function createDb(path: string): Db {
  const db = new Database(path);
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');
  db.exec(SCHEMA);
  return db;
}
