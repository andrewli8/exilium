import { mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, test } from 'vitest';
import { loadSnipeFolder, readSnipeFolderFiles } from '../src/snipe/bettertrading.js';
import { persistSnipeImport } from '../src/snipe/import.js';

const PAYLOAD = {
  tit: 'Currency',
  ver: '1',
  trs: [{ tit: 'Divines', loc: '1:search:abc123' }],
};
const VALID_EXPORT = `3:${Buffer.from(JSON.stringify(PAYLOAD)).toString('base64')}`;

describe('persistSnipeImport', () => {
  const roots: string[] = [];

  afterEach(() => {
    for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
  });

  function folder(): string {
    const root = mkdtempSync(join(tmpdir(), 'exilium-snipe-import-'));
    roots.push(root);
    return join(root, 'BetterTrading');
  }

  test('persists one validated export idempotently under the BetterTrading folder', () => {
    const dir = folder();
    const first = persistSnipeImport({ folder: dir, content: VALID_EXPORT, sourceName: 'clipboard' });
    const second = persistSnipeImport({ folder: dir, content: ` ${VALID_EXPORT}\n`, sourceName: 'clipboard' });
    expect(second.path).toBe(first.path);
    expect(first.created).toBe(true);
    expect(second.created).toBe(false);
    expect(readFileSync(first.path, 'utf8')).toBe(`${VALID_EXPORT}\n`);
    expect(first.targets.map((target) => target.searchId)).toEqual(['abc123']);
    expect(loadSnipeFolder(readSnipeFolderFiles(dir), () => undefined)).toHaveLength(1);
  });

  test('stores each import inside a subdirectory named after the export folder', () => {
    const dir = folder();
    const result = persistSnipeImport({ folder: dir, content: VALID_EXPORT, sourceName: 'clipboard' });
    expect(result.path).toContain(join(dir, 'currency'));
    expect(result.targets[0]?.group).toBe('Currency');
    // The recursive folder loader still finds it.
    expect(loadSnipeFolder(readSnipeFolderFiles(dir), () => undefined)).toHaveLength(1);
  });

  test('a second import with the same title becomes its own new folder', () => {
    const dir = folder();
    const other = `3:${Buffer.from(JSON.stringify({
      tit: 'Currency', ver: '1', trs: [{ tit: 'Mirrors', loc: '1:search:zzz999' }],
    })).toString('base64')}`;
    const first = persistSnipeImport({ folder: dir, content: VALID_EXPORT, sourceName: 'clipboard' });
    const second = persistSnipeImport({ folder: dir, content: other, sourceName: 'clipboard' });
    expect(first.path).toContain(join(dir, 'currency'));
    expect(second.path).toContain(join(dir, 'currency-2'));
    // Re-importing the first content stays idempotent even from a subdirectory.
    const again = persistSnipeImport({ folder: dir, content: VALID_EXPORT, sourceName: 'clipboard' });
    expect(again.path).toBe(first.path);
    expect(again.created).toBe(false);
  });

  test('an untitled export still gets its own folder', () => {
    const dir = folder();
    const untitled = `3:${Buffer.from(JSON.stringify({
      tit: '', ver: '1', trs: [{ tit: 'Divines', loc: '1:search:abc123' }],
    })).toString('base64')}`;
    const result = persistSnipeImport({ folder: dir, content: untitled, sourceName: 'clipboard' });
    expect(result.path).toContain(join(dir, 'import'));
  });

  test('invalid input does not create a folder or source file', () => {
    const dir = folder();
    expect(() => persistSnipeImport({ folder: dir, content: '3:not-json', sourceName: 'clipboard' })).toThrow(/decode|JSON/i);
    expect(readdirSync(join(dir, '..'))).toEqual([]);
  });

  test('different valid sources get different deterministic files', () => {
    const dir = folder();
    const first = persistSnipeImport({ folder: dir, content: VALID_EXPORT, sourceName: 'clipboard' });
    const url = 'https://www.pathofexile.com/trade/search/Allflame/other123 | Other';
    const second = persistSnipeImport({ folder: dir, content: url, sourceName: 'searches.txt' });
    expect(first.path).not.toBe(second.path);
    expect(readdirSync(dir).sort()).toHaveLength(2);
  });
});
