import { createHash } from 'node:crypto';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { parseSnipeSource, type SnipeTarget } from './bettertrading.js';

export interface PersistSnipeImportInput {
  readonly folder: string;
  readonly content: string;
  readonly sourceName: string;
}

export interface ImportResult {
  readonly path: string;
  readonly created: boolean;
  readonly targets: readonly SnipeTarget[];
}

function isAlreadyExists(err: unknown): boolean {
  return typeof err === 'object' && err !== null && 'code' in err && err.code === 'EEXIST';
}

/** Validate first, then persist an idempotent BetterTrading source file.
 * Whitespace around pasted exports is normalized so repeated imports map to
 * one deterministic SHA-256-derived filename. */
export function persistSnipeImport(input: PersistSnipeImportInput): ImportResult {
  const normalized = input.content.trim();
  const targets = parseSnipeSource(normalized, input.sourceName);
  const digest = createHash('sha256').update(normalized, 'utf8').digest('hex');
  const path = join(input.folder, `import-${digest.slice(0, 12)}.bt`);

  mkdirSync(input.folder, { recursive: true });
  let created = true;
  try {
    writeFileSync(path, `${normalized}\n`, { encoding: 'utf8', flag: 'wx' });
  } catch (err) {
    if (!isAlreadyExists(err)) throw err;
    created = false;
  }
  return { path, created, targets };
}
