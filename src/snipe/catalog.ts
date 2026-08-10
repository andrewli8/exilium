import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, rmSync, unlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { z } from 'zod';
import { loadSnipeFolder, readSnipeFolderFiles, type SnipeTarget } from './bettertrading.js';
import { parseTradeUrl } from '../trade/live-search.js';

export const SNIPE_MANIFEST_NAME = '.exilium-snipes.json';

const priceSchema = z.object({
  amount: z.number().positive(),
  currency: z.string().min(1),
});

const targetSchema = z.object({
  label: z.string().min(1),
  realm: z.enum(['trade', 'trade2']),
  searchId: z.string().min(1),
  league: z.string().min(1).nullable(),
  maxBuy: priceSchema.optional(),
  minMarginPct: z.number().finite().optional(),
});

const overrideSchema = z.object({
  label: z.string().min(1).optional(),
  league: z.string().min(1).nullable().optional(),
  maxBuy: priceSchema.nullable().optional(),
  minMarginPct: z.number().finite().nullable().optional(),
  enabled: z.boolean().optional(),
});

const manifestSchema = z.object({
  version: z.literal(1),
  managed: z.array(targetSchema),
  overrides: z.record(z.string(), overrideSchema),
});

export type SnipeOverride = z.infer<typeof overrideSchema>;
export type SnipeManifest = z.infer<typeof manifestSchema>;

export interface CatalogEntry extends SnipeTarget {
  readonly key: string;
  readonly enabled: boolean;
  readonly source: 'Better Trading' | 'Exilium';
}

export function emptySnipeManifest(): SnipeManifest {
  return { version: 1, managed: [], overrides: {} };
}

export function targetKey(target: Pick<SnipeTarget, 'realm' | 'searchId'>): string {
  return `${target.realm}:${target.searchId}`;
}

function manifestPath(folder: string): string {
  return join(folder, SNIPE_MANIFEST_NAME);
}

export function loadSnipeManifest(folder: string): SnipeManifest {
  const path = manifestPath(folder);
  if (!existsSync(path)) return emptySnipeManifest();
  let parsedJson: unknown;
  try {
    parsedJson = JSON.parse(readFileSync(path, 'utf8'));
  } catch (error) {
    throw new Error(`Invalid Exilium snipe manifest at ${path}: ${error instanceof Error ? error.message : String(error)}`);
  }
  const parsed = manifestSchema.safeParse(parsedJson);
  if (!parsed.success) {
    throw new Error(`Invalid Exilium snipe manifest at ${path}: ${parsed.error.issues[0]?.message ?? 'unknown schema error'}`);
  }
  return parsed.data;
}

export function saveSnipeManifest(folder: string, manifest: SnipeManifest): string {
  const parsed = manifestSchema.safeParse(manifest);
  if (!parsed.success) throw new Error(`Refusing to save invalid snipe manifest: ${parsed.error.issues[0]?.message ?? 'unknown schema error'}`);
  mkdirSync(folder, { recursive: true });
  const path = manifestPath(folder);
  const temp = join(folder, `${SNIPE_MANIFEST_NAME}.${process.pid}.${Date.now()}.tmp`);
  try {
    writeFileSync(temp, `${JSON.stringify(parsed.data, null, 2)}\n`, { encoding: 'utf8', flag: 'wx', mode: 0o600 });
    renameSync(temp, path);
    chmodSync(path, 0o600);
  } catch (error) {
    if (existsSync(temp)) unlinkSync(temp);
    throw error;
  }
  return path;
}

function applyOverride(
  target: SnipeTarget,
  source: CatalogEntry['source'],
  override: SnipeOverride | undefined,
): CatalogEntry {
  const maxBuy = override?.maxBuy === undefined ? target.maxBuy : override.maxBuy;
  const minMarginPct = override?.minMarginPct === undefined ? target.minMarginPct : override.minMarginPct;
  return {
    label: override?.label ?? target.label,
    ...(target.group === undefined ? {} : { group: target.group }),
    realm: target.realm,
    searchId: target.searchId,
    league: override?.league === undefined ? target.league : override.league,
    ...(maxBuy == null ? {} : { maxBuy }),
    ...(minMarginPct == null ? {} : { minMarginPct }),
    key: targetKey(target),
    enabled: override?.enabled ?? true,
    source,
  };
}

export function loadSnipeCatalog(folder: string, warn: (message: string) => void): readonly CatalogEntry[] {
  const manifest = loadSnipeManifest(folder);
  const raw = existsSync(folder) ? loadSnipeFolder(readSnipeFolderFiles(folder), warn, folder) : [];
  const managed: readonly SnipeTarget[] = manifest.managed.map((target) => ({
    label: target.label,
    realm: target.realm,
    searchId: target.searchId,
    league: target.league,
    ...(target.maxBuy === undefined ? {} : { maxBuy: target.maxBuy }),
    ...(target.minMarginPct === undefined ? {} : { minMarginPct: target.minMarginPct }),
  }));
  const combined: Array<{ target: SnipeTarget; source: CatalogEntry['source'] }> = [
    ...raw.map((target) => ({ target, source: 'Better Trading' as const })),
    ...managed.map((target) => ({ target, source: 'Exilium' as const })),
  ];
  const seen = new Set<string>();
  const entries: CatalogEntry[] = [];
  for (const item of combined) {
    const key = targetKey(item.target);
    if (seen.has(key)) continue;
    seen.add(key);
    entries.push(applyOverride(item.target, item.source, manifest.overrides[key]));
  }
  return entries;
}

/** Delete one configure-UI folder. When the group is backed by its own
 * import subdirectory, the directory is removed from disk along with the
 * member overrides; a group living inside shared root files (which may hold
 * other searches and were often written by the user) is never deleted —
 * its searches are reversibly disabled instead. */
export function deleteSnipeFolderGroup(folder: string, group: string): readonly CatalogEntry[] {
  const entries = loadSnipeCatalog(folder, () => undefined);
  const members = entries.filter((entry) => entry.group === group);
  if (members.length === 0) throw new Error(`Unknown snipe folder "${group}"`);
  const manifest = loadSnipeManifest(folder);
  const overrides = { ...manifest.overrides };
  // A payload title can contain anything; only a plain directory name may
  // ever be joined onto the folder path.
  const isPlainDirName = !group.includes('/') && !group.includes('\\') && group !== '.' && group !== '..';
  const dir = isPlainDirName ? join(folder, group) : null;
  if (dir !== null && existsSync(dir)) {
    rmSync(dir, { recursive: true, force: true });
    for (const member of members) delete overrides[member.key];
  } else {
    for (const member of members) overrides[member.key] = { ...overrides[member.key], enabled: false };
  }
  saveSnipeManifest(folder, { ...manifest, overrides });
  return loadSnipeCatalog(folder, () => undefined);
}

export function resolveCatalogEntry(entries: readonly CatalogEntry[], selector: string): CatalogEntry {
  const needle = selector.trim().toLowerCase();
  const exact = entries.filter((entry) =>
    entry.searchId.toLowerCase() === needle || entry.key.toLowerCase() === needle,
  );
  if (exact.length === 1) return exact[0]!;
  if (exact.length > 1) throw new Error(`Ambiguous snipe selector "${selector}"`);
  const labels = entries.filter((entry) => entry.label.toLowerCase().includes(needle));
  if (labels.length === 0) throw new Error(`Unknown snipe selector "${selector}"`);
  if (labels.length > 1) throw new Error(`Ambiguous snipe selector "${selector}"`);
  return labels[0]!;
}

export interface CatalogEdit {
  readonly key: string;
  readonly label?: string;
  readonly url?: string;
  readonly minMarginPct?: number | null;
  readonly enabled?: boolean;
}

export function updateSnipeCatalog(
  folder: string,
  edits: readonly CatalogEdit[],
): readonly CatalogEntry[] {
  const current = loadSnipeCatalog(folder, () => undefined);
  const manifest = loadSnipeManifest(folder);
  const managed = [...manifest.managed];
  const overrides = { ...manifest.overrides };

  for (const edit of edits) {
    const entry = current.find((candidate) => candidate.key === edit.key);
    if (entry === undefined) throw new Error(`Unknown snipe selector "${edit.key}"`);
    if (edit.label !== undefined && edit.label.trim() === '') throw new Error('Snipe label cannot be empty');
    if (edit.minMarginPct !== undefined && edit.minMarginPct !== null && (!Number.isFinite(edit.minMarginPct) || edit.minMarginPct < 0)) {
      throw new Error('Minimum margin must be a non-negative number or blank');
    }

    let destinationKey = edit.key;
    if (edit.url !== undefined) {
      const parsed = parseTradeUrl(edit.url);
      destinationKey = targetKey(parsed);
      if (destinationKey !== edit.key) {
        overrides[edit.key] = { ...overrides[edit.key], enabled: false };
        if (!managed.some((target) => targetKey(target) === destinationKey)) {
          managed.push({
            label: edit.label?.trim() || entry.label,
            realm: parsed.realm,
            searchId: parsed.searchId,
            league: parsed.league,
            ...(entry.maxBuy === undefined ? {} : { maxBuy: entry.maxBuy }),
            ...(edit.minMarginPct == null
              ? entry.minMarginPct === undefined ? {} : { minMarginPct: entry.minMarginPct }
              : { minMarginPct: edit.minMarginPct }),
          });
        }
      }
    }

    overrides[destinationKey] = {
      ...overrides[destinationKey],
      ...(edit.label === undefined ? {} : { label: edit.label.trim() }),
      ...(edit.minMarginPct === undefined ? {} : { minMarginPct: edit.minMarginPct }),
      ...(edit.enabled === undefined ? {} : { enabled: edit.enabled }),
    };
  }

  saveSnipeManifest(folder, { version: 1, managed, overrides });
  return loadSnipeCatalog(folder, () => undefined);
}
