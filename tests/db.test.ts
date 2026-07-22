import { describe, expect, test } from 'vitest';
import { createDb } from '../src/storage/db.js';

/** The Db interface must behave identically whichever backend is active
 * (better-sqlite3 under Node, bun:sqlite in the compiled binary). These run
 * under Node, exercising the interface the repos depend on. */
describe('createDb (Db interface)', () => {
  test('prepare/run/get/all round-trip with positional params', () => {
    const db = createDb(':memory:');
    db.exec('CREATE TABLE t (id INTEGER PRIMARY KEY, name TEXT, n REAL)');
    const ins = db.prepare('INSERT INTO t (name, n) VALUES (?, ?)');
    const r = ins.run('divine', 720);
    expect(r.changes).toBe(1);
    expect(Number(r.lastInsertRowid)).toBe(1);
    ins.run('chaos', 1);
    expect(db.prepare('SELECT name FROM t WHERE n = ?').get(720)).toEqual({ name: 'divine' });
    expect(db.prepare('SELECT COUNT(*) AS c FROM t').get()).toEqual({ c: 2 });
    expect((db.prepare('SELECT name FROM t ORDER BY n').all() as { name: string }[]).map((x) => x.name)).toEqual(['chaos', 'divine']);
  });

  test('pragma reads and writes user_version', () => {
    const db = createDb(':memory:');
    db.pragma('user_version = 7');
    expect(db.pragma('user_version', { simple: true })).toBe(7);
  });

  test('transaction commits as a unit', () => {
    const db = createDb(':memory:');
    db.exec('CREATE TABLE t (v INTEGER)');
    const ins = db.prepare('INSERT INTO t (v) VALUES (?)');
    db.transaction(() => { ins.run(1); ins.run(2); ins.run(3); })();
    expect(db.prepare('SELECT COUNT(*) AS c FROM t').get()).toEqual({ c: 3 });
  });

  test('a fresh db is migrated to the current schema version', () => {
    const db = createDb(':memory:');
    const tables = (db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all() as { name: string }[]).map((t) => t.name);
    expect(tables).toContain('snapshots');
    expect(tables).toContain('opportunity_log');
  });
});
