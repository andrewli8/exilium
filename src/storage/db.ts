import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import Database from 'better-sqlite3';

export type Db = Database.Database;

/** Open (or create) the Exilium SQLite database and bring its schema to the
 * current version (see migrations.ts). */
export function createDb(path: string): Db {
  if (path !== ':memory:') mkdirSync(dirname(path), { recursive: true });
  const db = new Database(path);
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');
  // Imported lazily at call time would create a cycle; migrations only
  // depends on the Db type from this module.
  runMigrationsRef(db);
  return db;
}

import { runMigrations as runMigrationsRef } from './migrations.js';
