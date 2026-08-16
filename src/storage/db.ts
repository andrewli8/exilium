import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { createRequire } from 'node:module';
import { runMigrations } from './migrations.js';

/** A synchronous SQLite handle. Two backends implement it identically:
 * better-sqlite3 under Node (dev, tests) and bun:sqlite in the compiled
 * single-file binary. Neither is imported statically, so the Bun build never
 * pulls the native module and Node never touches the Bun-only one. */

export interface RunResult {
  readonly changes: number;
  readonly lastInsertRowid: number | bigint;
}

export interface Statement {
  run(...params: unknown[]): RunResult;
  get(...params: unknown[]): unknown;
  all(...params: unknown[]): unknown[];
}

export interface Db {
  pragma(source: string, options?: { simple?: boolean }): unknown;
  exec(sql: string): void;
  prepare(sql: string): Statement;
  transaction<T extends (...args: never[]) => unknown>(fn: T): T;
  close(): void;
}

const isBun = typeof (globalThis as { Bun?: unknown }).Bun !== 'undefined';
const req = createRequire(import.meta.url);

/** better-sqlite3 already matches the Db shape; use it directly under Node. */
function nodeDb(path: string): Db {
  const Database = req('better-sqlite3') as new (p: string) => Db;
  return new Database(path);
}

/** bun:sqlite is close but has no `.pragma()`; wrap it to match Db. */
function bunDb(path: string): Db {
  const { Database } = req('bun:sqlite') as {
    Database: new (p: string) => {
      exec(sql: string): void;
      prepare(sql: string): Statement;
      transaction<T extends (...a: never[]) => unknown>(fn: T): T;
      close(): void;
    };
  };
  const raw = new Database(path);
  return {
    pragma(source, options) {
      if (source.includes('=')) { raw.exec(`PRAGMA ${source}`); return undefined; }
      const row = raw.prepare(`PRAGMA ${source}`).get() as Record<string, unknown> | undefined | null;
      if (row === undefined || row === null) return undefined;
      return options?.simple === true ? Object.values(row)[0] : row;
    },
    exec: (sql) => raw.exec(sql),
    prepare: (sql) => raw.prepare(sql),
    transaction: (fn) => raw.transaction(fn),
    close: () => raw.close(),
  };
}

/** Open (or create) the database and bring its schema to the current version. */
export function createDb(path: string): Db {
  if (path !== ':memory:') mkdirSync(dirname(path), { recursive: true });
  const db = isBun ? bunDb(path) : nodeDb(path);
  db.pragma('journal_mode = WAL');
  // WAL + NORMAL: commits skip the per-transaction fsync (safe in WAL — a
  // power cut can lose the last commits but never corrupts). Ingest sweeps
  // write dozens of transactions back-to-back; on Windows the FULL-mode
  // flushes made each one a visible UI stall.
  db.pragma('synchronous = NORMAL');
  db.pragma('foreign_keys = ON');
  runMigrations(db);
  // Fold the WAL back into the main file when we're the only connection.
  // Long-lived extra processes (MCP servers, stray sessions) block
  // checkpointing, and an unbounded WAL slows every read for everyone.
  try { db.pragma('wal_checkpoint(TRUNCATE)'); } catch { /* busy or in-memory — harmless */ }
  return db;
}
