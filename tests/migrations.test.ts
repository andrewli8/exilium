import Database from 'better-sqlite3';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, test } from 'vitest';
import { createDb } from '../src/storage/db.js';
import { CURRENT_SCHEMA_VERSION } from '../src/storage/migrations.js';

const dir = mkdtempSync(join(tmpdir(), 'exilium-mig-'));
afterAll(() => rmSync(dir, { recursive: true, force: true }));

describe('schema migrations', () => {
  test('a fresh database lands on the current version with all tables', () => {
    const db = createDb(':memory:');
    expect(db.pragma('user_version', { simple: true })).toBe(CURRENT_SCHEMA_VERSION);
    const tables = (db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all() as { name: string }[]).map((t) => t.name);
    for (const t of ['snapshots', 'market_lines', 'watches', 'watch_events', 'journal', 'opportunity_log']) {
      expect(tables).toContain(t);
    }
  });

  test('reopening an up-to-date database is a no-op', () => {
    const path = join(dir, 'reopen.db');
    createDb(path).close();
    const db = createDb(path);
    expect(db.pragma('user_version', { simple: true })).toBe(CURRENT_SCHEMA_VERSION);
    db.close();
  });

  test('a legacy pre-versioning database is stamped and upgraded without data loss', () => {
    const path = join(dir, 'legacy.db');
    // Simulate a DB created before migrations existed: v1-era tables, user_version 0.
    const legacy = new Database(path);
    legacy.exec(`
      CREATE TABLE snapshots (id INTEGER PRIMARY KEY AUTOINCREMENT, game TEXT NOT NULL, league TEXT NOT NULL,
        category TEXT NOT NULL, fetched_at TEXT NOT NULL, core_json TEXT NOT NULL);
      CREATE TABLE market_lines (snapshot_id INTEGER NOT NULL, item_id TEXT NOT NULL, name TEXT NOT NULL,
        primary_value REAL NOT NULL, volume_primary_value REAL NOT NULL, max_volume_currency TEXT,
        max_volume_rate REAL, sparkline_json TEXT NOT NULL, total_change REAL NOT NULL);
      CREATE TABLE journal (id INTEGER PRIMARY KEY AUTOINCREMENT, opportunity_id TEXT NOT NULL, item_name TEXT NOT NULL,
        outcome TEXT NOT NULL, expected_edge_pct REAL NOT NULL, note TEXT, recorded_at TEXT NOT NULL);
      INSERT INTO snapshots (game, league, category, fetched_at, core_json)
        VALUES ('poe1', 'Mirage', 'Currency', '2026-07-18T00:00:00Z', '{"primary":"chaos","perPrimary":{"chaos":1}}');
      INSERT INTO journal (opportunity_id, item_name, outcome, expected_edge_pct, recorded_at)
        VALUES ('mean-reversion:poe1:Mirage:x', 'X', 'filled', 20, '2026-07-18T00:00:00Z');
    `);
    legacy.close();

    const db = createDb(path);
    expect(db.pragma('user_version', { simple: true })).toBe(CURRENT_SCHEMA_VERSION);
    // Old data survives.
    expect((db.prepare('SELECT COUNT(*) AS n FROM snapshots').get() as { n: number }).n).toBe(1);
    expect((db.prepare('SELECT COUNT(*) AS n FROM journal').get() as { n: number }).n).toBe(1);
    // New columns/tables from later migrations exist.
    const journalCols = (db.prepare('PRAGMA table_info(journal)').all() as { name: string }[]).map((c) => c.name);
    expect(journalCols).toContain('idempotency_key');
    expect(() => db.prepare('SELECT COUNT(*) FROM opportunity_log').get()).not.toThrow();
    db.close();
  });
});
