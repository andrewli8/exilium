import { existsSync, mkdirSync, mkdtempSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, test } from 'vitest';
import {
  emptySnipeManifest,
  loadSnipeCatalog,
  loadSnipeManifest,
  resolveCatalogEntry,
  saveSnipeManifest,
  targetKey,
  updateSnipeCatalog,
} from '../src/snipe/catalog.js';

function folder(): string {
  return mkdtempSync(join(tmpdir(), 'exilium-catalog-'));
}

function writeImported(dir: string): void {
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'better-trading.txt'), [
    'https://www.pathofexile.com/trade/search/Allflame/aaa111 | Sublime Vision',
    'https://www.pathofexile.com/trade/search/Allflame/bbb222 | Mageblood',
  ].join('\n'));
}

describe('snipe catalog', () => {
  test('loads Better Trading targets with stable keys and source labels', () => {
    const dir = folder();
    writeImported(dir);
    expect(loadSnipeCatalog(dir, () => undefined).map((entry) => ({
      key: entry.key,
      label: entry.label,
      enabled: entry.enabled,
      source: entry.source,
    }))).toEqual([
      { key: 'trade:aaa111', label: 'Sublime Vision', enabled: true, source: 'Better Trading' },
      { key: 'trade:bbb222', label: 'Mageblood', enabled: true, source: 'Better Trading' },
    ]);
  });

  test('merges managed targets and applies nullable overrides without rewriting imports', () => {
    const dir = folder();
    writeImported(dir);
    const importedBefore = readFileSync(join(dir, 'better-trading.txt'), 'utf8');
    saveSnipeManifest(dir, {
      version: 1,
      managed: [{ label: 'Nimis', realm: 'trade', searchId: 'ccc333', league: 'Allflame', minMarginPct: 5 }],
      overrides: {
        'trade:aaa111': {
          label: 'Cheap Sublime',
          maxBuy: { amount: 20, currency: 'divine' },
          minMarginPct: 15,
          enabled: false,
        },
        'trade:ccc333': { minMarginPct: null },
      },
    });
    const entries = loadSnipeCatalog(dir, () => undefined);
    expect(entries[0]).toMatchObject({ label: 'Cheap Sublime', enabled: false, maxBuy: { amount: 20, currency: 'divine' }, minMarginPct: 15 });
    expect(entries[2]).toMatchObject({ label: 'Nimis', enabled: true, source: 'Exilium' });
    expect(entries[2]).not.toHaveProperty('minMarginPct');
    expect(readFileSync(join(dir, 'better-trading.txt'), 'utf8')).toBe(importedBefore);
  });

  test('deduplicates a managed target already supplied by Better Trading', () => {
    const dir = folder();
    writeImported(dir);
    saveSnipeManifest(dir, {
      version: 1,
      managed: [{ label: 'Duplicate', realm: 'trade', searchId: 'aaa111', league: null }],
      overrides: {},
    });
    expect(loadSnipeCatalog(dir, () => undefined).filter((entry) => entry.searchId === 'aaa111')).toHaveLength(1);
  });

  test('resolves exact ids, stable keys, and unique label substrings', () => {
    const dir = folder();
    writeImported(dir);
    const entries = loadSnipeCatalog(dir, () => undefined);
    expect(resolveCatalogEntry(entries, 'aaa111').searchId).toBe('aaa111');
    expect(resolveCatalogEntry(entries, 'trade:bbb222').label).toBe('Mageblood');
    expect(resolveCatalogEntry(entries, 'sublime').searchId).toBe('aaa111');
    expect(() => resolveCatalogEntry(entries, 'missing')).toThrow(/Unknown/);
    expect(() => resolveCatalogEntry(entries, 'm')).toThrow(/Ambiguous/);
  });

  test('writes a validated 0600 manifest atomically and leaves no temp file', () => {
    const dir = folder();
    const path = saveSnipeManifest(dir, emptySnipeManifest());
    expect(existsSync(path)).toBe(true);
    expect(statSync(path).mode & 0o777).toBe(0o600);
    expect(JSON.parse(readFileSync(path, 'utf8'))).toEqual({ version: 1, managed: [], overrides: {} });
    expect(loadSnipeManifest(dir)).toEqual(emptySnipeManifest());
  });

  test('rejects a malformed manifest without overwriting it', () => {
    const dir = folder();
    const path = join(dir, '.exilium-snipes.json');
    writeFileSync(path, '{broken');
    expect(() => loadSnipeCatalog(dir, () => undefined)).toThrow(/manifest/i);
    expect(readFileSync(path, 'utf8')).toBe('{broken');
  });

  test('targetKey includes the realm', () => {
    expect(targetKey({ realm: 'trade2', searchId: 'same' })).toBe('trade2:same');
  });

  test('applies batch configuration edits in one manifest write', () => {
    const dir = folder();
    writeImported(dir);
    const entries = updateSnipeCatalog(dir, [
      { key: 'trade:aaa111', enabled: false, label: 'Configured Sublime', minMarginPct: 25 },
      { key: 'trade:bbb222', enabled: true },
    ]);

    expect(entries[0]).toMatchObject({ label: 'Configured Sublime', enabled: false, minMarginPct: 25 });
    expect(loadSnipeManifest(dir).overrides['trade:aaa111']).toMatchObject({ enabled: false, label: 'Configured Sublime', minMarginPct: 25 });
  });

  test('replacing a trade URL disables the old target and creates a managed replacement', () => {
    const dir = folder();
    writeImported(dir);
    const entries = updateSnipeCatalog(dir, [{
      key: 'trade:aaa111',
      url: 'https://www.pathofexile.com/trade/search/Allflame/replacement9',
      label: 'Replacement',
      enabled: true,
    }]);

    expect(entries.find((entry) => entry.key === 'trade:aaa111')?.enabled).toBe(false);
    expect(entries.find((entry) => entry.key === 'trade:replacement9')).toMatchObject({ label: 'Replacement', enabled: true, source: 'Exilium' });
  });
});
