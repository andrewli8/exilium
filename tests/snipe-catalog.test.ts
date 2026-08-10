import { existsSync, mkdirSync, mkdtempSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, test } from 'vitest';
import {
  deleteSnipeFolderGroup,
  emptySnipeManifest,
  loadSnipeCatalog,
  loadSnipeManifest,
  resolveCatalogEntry,
  saveSnipeManifest,
  targetKey,
  updateSnipeCatalog,
} from '../src/snipe/catalog.js';

const EXPORT_VALDOS = `3:${Buffer.from(JSON.stringify({
  tit: 'valdos', ver: '1', trs: [{ tit: 'mageblood', loc: '1:search:DelDir1' }],
})).toString('base64')}`;

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

  test('deleting an import-directory folder removes the directory and its overrides', () => {
    const dir = folder();
    mkdirSync(join(dir, 'valdos'), { recursive: true });
    writeFileSync(join(dir, 'valdos', 'import-abc.bt'), `${EXPORT_VALDOS}\n`);
    writeImported(dir); // unrelated root file stays
    saveSnipeManifest(dir, {
      ...emptySnipeManifest(),
      overrides: { 'trade:DelDir1': { enabled: false } },
    });

    const before = loadSnipeCatalog(dir, () => undefined);
    expect(before.find((entry) => entry.key === 'trade:DelDir1')).toMatchObject({ group: 'valdos' });

    const result = deleteSnipeFolderGroup(dir, 'valdos');
    expect(existsSync(join(dir, 'valdos'))).toBe(false);
    expect(result.some((entry) => entry.key === 'trade:DelDir1')).toBe(false);
    expect(loadSnipeManifest(dir).overrides['trade:DelDir1']).toBeUndefined();
    expect(result.some((entry) => entry.key === 'trade:aaa111')).toBe(true);
  });

  test('deleting a group deletes root files that belong wholly to it', () => {
    const dir = folder();
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'saved.txt'), `${EXPORT_VALDOS}\n`);
    writeImported(dir); // unrelated ungrouped file must survive

    const result = deleteSnipeFolderGroup(dir, 'valdos');
    expect(existsSync(join(dir, 'saved.txt'))).toBe(false);
    expect(result.some((entry) => entry.key === 'trade:DelDir1')).toBe(false);
    expect(result.some((entry) => entry.key === 'trade:aaa111')).toBe(true);
  });

  test('a file shared with another folder survives; only the members are disabled', () => {
    const dir = folder();
    mkdirSync(dir, { recursive: true });
    const other = `3:${Buffer.from(JSON.stringify({
      tit: 'gambles', ver: '1', trs: [{ tit: 'unids', loc: '1:search:Mixed99' }],
    })).toString('base64')}`;
    writeFileSync(join(dir, 'mixed.txt'), `${EXPORT_VALDOS}\n${other}\n`);

    const result = deleteSnipeFolderGroup(dir, 'valdos');
    expect(existsSync(join(dir, 'mixed.txt'))).toBe(true);
    expect(result.find((entry) => entry.key === 'trade:DelDir1')).toMatchObject({ enabled: false });
    expect(result.find((entry) => entry.key === 'trade:Mixed99')).toMatchObject({ enabled: true });
  });
});
