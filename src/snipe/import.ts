import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readdirSync, writeFileSync } from 'node:fs';
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

/** Find a previously imported file with this digest at the root or one
 * level down, so identical re-imports stay idempotent wherever they live. */
function findExistingImport(root: string, fileName: string): string | null {
  if (!existsSync(root)) return null;
  const direct = join(root, fileName);
  if (existsSync(direct)) return direct;
  for (const entry of readdirSync(root, { withFileTypes: true })) {
    if (!entry.isDirectory() || entry.name.startsWith('.')) continue;
    const candidate = join(root, entry.name, fileName);
    if (existsSync(candidate)) return candidate;
  }
  return null;
}

/** Validate first, then persist an idempotent BetterTrading source file.
 * Whitespace around pasted exports is normalized so repeated imports map to
 * one deterministic SHA-256-derived filename. Every NEW import mints its own
 * subdirectory — named after the export's folder title, uniquified with
 * -2/-3 suffixes — so each import is its own folder in the configure UI. */
export function persistSnipeImport(input: PersistSnipeImportInput): ImportResult {
  const normalized = input.content.trim();
  const targets = parseSnipeSource(normalized, input.sourceName);
  const digest = createHash('sha256').update(normalized, 'utf8').digest('hex');
  const fileName = `import-${digest.slice(0, 12)}.bt`;

  const existing = findExistingImport(input.folder, fileName);
  if (existing !== null) return { path: existing, created: false, targets };

  const base = folderDirName(targets[0]?.group) ?? 'import';
  let dir = join(input.folder, base);
  for (let suffix = 2; existsSync(dir); suffix += 1) dir = join(input.folder, `${base}-${suffix}`);
  const path = join(dir, fileName);
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
