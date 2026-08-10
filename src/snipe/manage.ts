import { parseTradeUrl } from '../trade/live-search.js';
import {
  loadSnipeCatalog,
  loadSnipeManifest,
  resolveCatalogEntry,
  saveSnipeManifest,
  targetKey,
  type CatalogEntry,
  type SnipeManifest,
  type SnipeOverride,
} from './catalog.js';
import { persistSnipeImport } from './import.js';

export interface BuyPrice {
  readonly amount: number;
  readonly currency: string;
}

const MAX_BUY_PATTERN = /^([0-9]+(?:\.[0-9]+)?)\s*(div(?:ine)?s?|c|chaos)$/i;

export function parseMaxBuy(raw: string): BuyPrice {
  const match = MAX_BUY_PATTERN.exec(raw.trim());
  const amount = Number(match?.[1]);
  if (match === null || !Number.isFinite(amount) || amount <= 0) {
    throw new Error(`Invalid max buy "${raw}" — use a positive value such as 20div or 150c.`);
  }
  const unit = match[2]!.toLowerCase();
  return { amount, currency: unit === 'c' || unit === 'chaos' ? 'chaos' : 'divine' };
}

function requireName(name: string | undefined, fallback: string): string {
  const resolved = name?.trim() || fallback;
  if (resolved === '') throw new Error('Snipe name cannot be empty');
  return resolved;
}

function updatedOverrides(
  manifest: SnipeManifest,
  key: string,
  override: SnipeOverride,
): SnipeManifest['overrides'] {
  return { ...manifest.overrides, [key]: override };
}

export interface AddSnipeInput {
  readonly folder: string;
  readonly url: string;
  readonly name?: string;
  readonly maxBuy?: BuyPrice;
  readonly minMarginPct?: number;
}

export function addSnipe(input: AddSnipeInput): CatalogEntry {
  const parsed = parseTradeUrl(input.url);
  const key = targetKey(parsed);
  const catalog = loadSnipeCatalog(input.folder, () => undefined);
  const existing = catalog.find((entry) => entry.key === key);
  const manifest = loadSnipeManifest(input.folder);
  if (existing !== undefined) {
    const current = manifest.overrides[key] ?? {};
    const override: SnipeOverride = {
      ...current,
      enabled: true,
      ...(input.name === undefined ? {} : { label: requireName(input.name, existing.label) }),
      ...(input.maxBuy === undefined ? {} : { maxBuy: input.maxBuy }),
      ...(input.minMarginPct === undefined ? {} : { minMarginPct: input.minMarginPct }),
    };
    saveSnipeManifest(input.folder, { ...manifest, overrides: updatedOverrides(manifest, key, override) });
  } else {
    const target = {
      label: requireName(input.name, parsed.searchId),
      realm: parsed.realm,
      searchId: parsed.searchId,
      league: parsed.league,
      ...(input.maxBuy === undefined ? {} : { maxBuy: input.maxBuy }),
      ...(input.minMarginPct === undefined ? {} : { minMarginPct: input.minMarginPct }),
    };
    saveSnipeManifest(input.folder, { ...manifest, managed: [...manifest.managed, target] });
  }
  return resolveCatalogEntry(loadSnipeCatalog(input.folder, () => undefined), key);
}

export interface EditSnipeInput {
  readonly folder: string;
  readonly selector: string;
  readonly name?: string;
  readonly maxBuy?: BuyPrice | null;
  readonly minMarginPct?: number | null;
  readonly enabled?: boolean;
}

export function editSnipe(input: EditSnipeInput): CatalogEntry {
  const entry = resolveCatalogEntry(loadSnipeCatalog(input.folder, () => undefined), input.selector);
  const manifest = loadSnipeManifest(input.folder);
  const current = manifest.overrides[entry.key] ?? {};
  const override: SnipeOverride = {
    ...current,
    ...(input.name === undefined ? {} : { label: requireName(input.name, entry.label) }),
    ...(input.maxBuy === undefined ? {} : { maxBuy: input.maxBuy }),
    ...(input.minMarginPct === undefined ? {} : { minMarginPct: input.minMarginPct }),
    ...(input.enabled === undefined ? {} : { enabled: input.enabled }),
  };
  saveSnipeManifest(input.folder, {
    ...manifest,
    overrides: updatedOverrides(manifest, entry.key, override),
  });
  return resolveCatalogEntry(loadSnipeCatalog(input.folder, () => undefined), entry.key);
}

export interface RemoveSnipeInput {
  readonly folder: string;
  readonly selector: string;
}

export function removeSnipe(input: RemoveSnipeInput): CatalogEntry {
  const entry = resolveCatalogEntry(loadSnipeCatalog(input.folder, () => undefined), input.selector);
  const manifest = loadSnipeManifest(input.folder);
  if (entry.source === 'Exilium') {
    const overrides = { ...manifest.overrides };
    delete overrides[entry.key];
    saveSnipeManifest(input.folder, {
      ...manifest,
      managed: manifest.managed.filter((target) => targetKey(target) !== entry.key),
      overrides,
    });
    return { ...entry, enabled: false };
  }
  const override: SnipeOverride = { ...(manifest.overrides[entry.key] ?? {}), enabled: false };
  saveSnipeManifest(input.folder, {
    ...manifest,
    overrides: updatedOverrides(manifest, entry.key, override),
  });
  return resolveCatalogEntry(loadSnipeCatalog(input.folder, () => undefined), entry.key);
}

export function formatSnipeCatalog(entries: readonly CatalogEntry[]): string {
  const header = 'STATE\tID\tNAME\tLEAGUE\tMAX BUY\tMIN MARGIN\tSOURCE';
  const rows = entries.map((entry) => [
    entry.enabled ? 'enabled' : 'disabled',
    entry.searchId,
    entry.label,
    entry.league ?? 'current',
    entry.maxBuy === undefined ? '-' : `${entry.maxBuy.amount} ${entry.maxBuy.currency}`,
    entry.minMarginPct === undefined ? '-' : `${entry.minMarginPct}%`,
    entry.source,
  ].join('\t'));
  return [header, ...rows].join('\n');
}

export interface InteractiveSnipeEditorDeps {
  readonly folder: string;
  readonly question: (prompt: string) => Promise<string>;
  readonly out: (message: string) => void;
  readonly warn: (message: string) => void;
}

function optionalMargin(raw: string): number | null | undefined {
  const value = raw.trim().toLowerCase();
  if (value === '') return undefined;
  if (value === 'none') return null;
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) throw new Error('Minimum margin must be a finite number, "none", or blank');
  return parsed;
}

function optionalMaxBuy(raw: string): BuyPrice | null | undefined {
  const value = raw.trim().toLowerCase();
  if (value === '') return undefined;
  if (value === 'none') return null;
  return parseMaxBuy(value);
}

/** Cross-platform readline manager. It deliberately owns no readline
 * instance: the CLI supplies `question`, while tests inject deterministic
 * answers. Errors remain inside the loop so one typo does not exit. */
export async function runInteractiveSnipeEditor(deps: InteractiveSnipeEditorDeps): Promise<void> {
  for (;;) {
    const entries = loadSnipeCatalog(deps.folder, deps.warn);
    deps.out(entries.length === 0 ? 'No snipes configured.' : formatSnipeCatalog(entries));
    const action = (await deps.question('[a]dd [e]dit [t]oggle [r]emove [i]mport [done]: ')).trim().toLowerCase();
    if (action === 'done' || action === 'q' || action === 'quit') return;
    try {
      if (action === 'a' || action === 'add') {
        const url = (await deps.question('Trade search URL: ')).trim();
        const name = (await deps.question('Name (blank uses search ID): ')).trim();
        const maxBuy = optionalMaxBuy(await deps.question('Max buy (20div/150c, blank for none): '));
        const minMarginPct = optionalMargin(await deps.question('Minimum margin % (blank for none): '));
        const entry = addSnipe({
          folder: deps.folder,
          url,
          ...(name === '' ? {} : { name }),
          ...(maxBuy == null ? {} : { maxBuy }),
          ...(minMarginPct == null ? {} : { minMarginPct }),
        });
        deps.out(`Added ${entry.label} (${entry.searchId}).`);
      } else if (action === 'e' || action === 'edit') {
        const selector = (await deps.question('ID or label: ')).trim();
        const name = (await deps.question('New name (blank keeps current): ')).trim();
        const maxBuy = optionalMaxBuy(await deps.question('Max buy (value, none to clear, blank to keep): '));
        const minMarginPct = optionalMargin(await deps.question('Minimum margin % (number, none to clear, blank to keep): '));
        const state = (await deps.question('State ([e]nable/[d]isable/blank keep): ')).trim().toLowerCase();
        if (state !== '' && state !== 'e' && state !== 'enable' && state !== 'd' && state !== 'disable') {
          throw new Error('State must be enable, disable, or blank');
        }
        const entry = editSnipe({
          folder: deps.folder,
          selector,
          ...(name === '' ? {} : { name }),
          ...(maxBuy === undefined ? {} : { maxBuy }),
          ...(minMarginPct === undefined ? {} : { minMarginPct }),
          ...(state === '' ? {} : { enabled: state === 'e' || state === 'enable' }),
        });
        deps.out(`Updated ${entry.label} (${entry.searchId}).`);
      } else if (action === 't' || action === 'toggle') {
        const selector = (await deps.question('ID or label: ')).trim();
        const entry = resolveCatalogEntry(loadSnipeCatalog(deps.folder, deps.warn), selector);
        const updated = editSnipe({ folder: deps.folder, selector: entry.key, enabled: !entry.enabled });
        deps.out(`${updated.enabled ? 'Enabled' : 'Disabled'} ${updated.label}.`);
      } else if (action === 'r' || action === 'remove') {
        const selector = (await deps.question('ID or label: ')).trim();
        const entry = removeSnipe({ folder: deps.folder, selector });
        deps.out(`${entry.source === 'Better Trading' ? 'Disabled' : 'Removed'} ${entry.label}.`);
      } else if (action === 'i' || action === 'import') {
        const content = await deps.question('Paste Better Trading export: ');
        const imported = persistSnipeImport({ folder: deps.folder, content, sourceName: 'interactive editor' });
        deps.out(`Imported ${imported.targets.length} search${imported.targets.length === 1 ? '' : 'es'}.`);
      } else {
        deps.out(`Unknown action "${action}".`);
      }
    } catch (error) {
      deps.out(`Error: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
}
