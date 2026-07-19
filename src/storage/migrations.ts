import type { Db } from './db.js';

/** Versioned schema migrations via PRAGMA user_version.
 *
 * Rules: never edit a shipped migration — append a new one. Version 0 means
 * either a fresh database or a legacy DB created before versioning existed;
 * the v1 baseline uses IF NOT EXISTS so both cases converge safely. */

export const CURRENT_SCHEMA_VERSION = 4;

const V1_BASELINE = `
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

CREATE TABLE IF NOT EXISTS journal (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  opportunity_id TEXT NOT NULL,
  item_name TEXT NOT NULL,
  outcome TEXT NOT NULL,
  expected_edge_pct REAL NOT NULL,
  note TEXT,
  recorded_at TEXT NOT NULL
);
`;

interface Migration {
  readonly version: number;
  readonly up: (db: Db) => void;
}

function tableHasColumn(db: Db, table: string, column: string): boolean {
  const cols = db.prepare(`PRAGMA table_info(${table})`).all() as readonly { name: string }[];
  return cols.some((c) => c.name === column);
}

const MIGRATIONS: readonly Migration[] = [
  { version: 1, up: (db) => db.exec(V1_BASELINE) },
  {
    version: 2,
    up: (db) => {
      // Idempotent record_outcome: optional client-supplied key, unique when present.
      if (!tableHasColumn(db, 'journal', 'idempotency_key')) {
        db.exec('ALTER TABLE journal ADD COLUMN idempotency_key TEXT');
      }
      db.exec('CREATE UNIQUE INDEX IF NOT EXISTS idx_journal_idem ON journal (idempotency_key)');
      // Persisted opportunity log: the spine that lets plan/journal/watch
      // events resolve historical signal ids.
      db.exec(`
        CREATE TABLE IF NOT EXISTS opportunity_log (
          id TEXT NOT NULL,
          as_of TEXT NOT NULL,
          detector TEXT NOT NULL,
          game TEXT NOT NULL,
          league TEXT NOT NULL,
          item_id TEXT NOT NULL,
          item_name TEXT NOT NULL,
          edge REAL NOT NULL,
          direction TEXT,
          confidence REAL NOT NULL,
          PRIMARY KEY (id, as_of)
        );
        CREATE INDEX IF NOT EXISTS idx_opplog_id ON opportunity_log (id, as_of DESC);
      `);
      // Shared upstream fetch state so multiple processes respect one cadence.
      db.exec(`
        CREATE TABLE IF NOT EXISTS ingest_state (
          scope TEXT PRIMARY KEY,
          last_fetch_at TEXT,
          cooldown_until TEXT
        );
      `);
    },
  },
  {
    version: 3,
    up: (db) => {
      for (const col of ['category TEXT', 'rationale TEXT', 'experimental INTEGER']) {
        const name = col.split(' ')[0]!;
        if (!tableHasColumn(db, 'opportunity_log', name)) {
          db.exec(`ALTER TABLE opportunity_log ADD COLUMN ${col}`);
        }
      }
    },
  },
  {
    version: 4,
    up: (db) => {
      db.exec(`
        CREATE TABLE IF NOT EXISTS stash_snapshots (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          game TEXT NOT NULL,
          league TEXT NOT NULL,
          account TEXT NOT NULL,
          taken_at TEXT NOT NULL,
          total_value REAL NOT NULL,
          items_json TEXT NOT NULL
        );
        CREATE INDEX IF NOT EXISTS idx_stash_lookup ON stash_snapshots (game, league, account, taken_at);
      `);
    },
  },
];

/** Bring a database to CURRENT_SCHEMA_VERSION. Safe on fresh, current, and
 * legacy pre-versioning databases. */
export function runMigrations(db: Db): void {
  const version = db.pragma('user_version', { simple: true }) as number;
  for (const m of MIGRATIONS) {
    if (m.version > version) {
      db.transaction(() => {
        m.up(db);
        db.pragma(`user_version = ${m.version}`);
      })();
    }
  }
}
