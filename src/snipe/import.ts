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

/** Directory-safe version of a Better Trading folder title. */
function folderDirName(title: string | undefined): string | null {
  if (title === undefined) return null;
  const cleaned = title.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
  return cleaned === '' ? null : cleaned;
}

/** Validate first, then persist an idempotent BetterTrading source file.
 * Whitespace around pasted exports is normalized so repeated imports map to
 * one deterministic SHA-256-derived filename. Each import lands in its own
 * subdirectory named after the export's folder title, so the on-disk layout
 * mirrors the Better Trading folders. */
export function persistSnipeImport(input: PersistSnipeImportInput): ImportResult {
  const normalized = input.content.trim();
  const targets = parseSnipeSource(normalized, input.sourceName);
  const digest = createHash('sha256').update(normalized, 'utf8').digest('hex');
  const subdir = folderDirName(targets[0]?.group);
  const dir = subdir === null ? input.folder : join(input.folder, subdir);
  const path = join(dir, `import-${digest.slice(0, 12)}.bt`);

  mkdirSync(dir, { recursive: true });
  let created = true;
  try {
    writeFileSync(path, `${normalized}\n`, { encoding: 'utf8', flag: 'wx' });
  } catch (err) {
    if (!isAlreadyExists(err)) throw err;
    created = false;
  }
  return { path, created, targets };
}
