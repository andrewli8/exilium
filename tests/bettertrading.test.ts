import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, test, vi } from 'vitest';
import {
  decodeBetterTradingExport,
  loadSnipeFolder,
  readSnipeFolderFiles,
  resolveSnipeFolder,
  targetsFromJson,
  targetsFromText,
} from '../src/snipe/bettertrading.js';

const b64 = (s: string): string => Buffer.from(s, 'utf8').toString('base64');

describe('decodeBetterTradingExport', () => {
  test('decodes a v3 folder export into targets', () => {
    const payload = {
      icn: 'alchemy',
      tit: 'Valdo snipes',
      ver: '1',
      trs: [
        { tit: 'Foil Mageblood', loc: '1:search:AbC123' },
        { tit: 'Puzzle box maps', loc: '1:search:XyZ789' },
      ],
    };
    const targets = decodeBetterTradingExport(`3:${b64(JSON.stringify(payload))}`);
    expect(targets).toEqual([
      { label: 'Valdo snipes · Foil Mageblood', realm: 'trade', searchId: 'AbC123', league: null },
      { label: 'Valdo snipes · Puzzle box maps', realm: 'trade', searchId: 'XyZ789', league: null },
    ]);
  });

  test('maps trade-site version 2 to the trade2 realm', () => {
    const payload = { tit: 'PoE2', trs: [{ tit: 'Bow', loc: '2:search:Qq11' }] };
    const [target] = decodeBetterTradingExport(`3:${b64(JSON.stringify(payload))}`);
    expect(target).toMatchObject({ realm: 'trade2', searchId: 'Qq11' });
  });

  test('decodes a v2 export with the older location object shape', () => {
    const payload = {
      title: 'Old folder',
      trades: [{ title: 'Belt', location: { type: 'search', slug: 'OldSlug1', version: '1' } }],
    };
    const targets = decodeBetterTradingExport(`2:${b64(JSON.stringify(payload))}`);
    expect(targets).toEqual([{ label: 'Old folder · Belt', realm: 'trade', searchId: 'OldSlug1', league: null }]);
  });

  test('rejects strings that are not Better Trading exports, with guidance', () => {
    expect(() => decodeBetterTradingExport('nonsense')).toThrow(/Better Trading/i);
    expect(() => decodeBetterTradingExport(`3:${b64('{"nope":true}')}`)).toThrow(/Better Trading/i);
  });
});

describe('targetsFromText', () => {
  test('extracts trade URLs with optional pipe labels, keeping the URL league', () => {
    const text = [
      'https://www.pathofexile.com/trade/search/Allflame/AbC123 | Foil HH',
      '# a comment line without a url',
      'https://www.pathofexile.com/trade/search/Standard/DeF456',
    ].join('\n');
    expect(targetsFromText(text, 'valdo')).toEqual([
      { label: 'Foil HH', realm: 'trade', searchId: 'AbC123', league: 'Allflame' },
      { label: 'valdo', realm: 'trade', searchId: 'DeF456', league: 'Standard' },
    ]);
  });

  test('decodes embedded Better Trading export lines', () => {
    const payload = { tit: 'F', trs: [{ tit: 'T', loc: '1:search:Slug9' }] };
    const text = `3:${b64(JSON.stringify(payload))}\n`;
    expect(targetsFromText(text, 'bt')).toEqual([
      { label: 'F · T', realm: 'trade', searchId: 'Slug9', league: null },
    ]);
  });

  test('ignores lines with neither URLs nor exports', () => {
    expect(targetsFromText('just notes\nmore notes', 'notes')).toEqual([]);
  });
});

describe('targetsFromJson', () => {
  test('parses structured targets with per-target overrides', () => {
    const json = JSON.stringify({
      targets: [
        {
          label: 'Cheap Valdo boxes',
          url: 'https://www.pathofexile.com/trade/search/Allflame/VvV111',
          maxBuy: { amount: 30, currency: 'chaos' },
          minMarginPct: 25,
        },
        { slug: 'SsS222', realm: 'trade' },
      ],
    });
    expect(targetsFromJson(json, 'valdo')).toEqual([
      {
        label: 'Cheap Valdo boxes',
        realm: 'trade',
        searchId: 'VvV111',
        league: 'Allflame',
        maxBuy: { amount: 30, currency: 'chaos' },
        minMarginPct: 25,
      },
      { label: 'valdo', realm: 'trade', searchId: 'SsS222', league: null },
    ]);
  });

  test('accepts a bare array', () => {
    const json = JSON.stringify([{ slug: 'A1', label: 'x' }]);
    expect(targetsFromJson(json, 'f')).toEqual([{ label: 'x', realm: 'trade', searchId: 'A1', league: null }]);
  });

  test('rejects entries with neither url nor slug', () => {
    expect(() => targetsFromJson(JSON.stringify([{ label: 'broken' }]), 'f')).toThrow(/url or slug/i);
  });
});

describe('loadSnipeFolder', () => {
  test('merges files, dedupes by realm+searchId (first wins), and warns on bad files', () => {
    const warn = vi.fn();
    const targets = loadSnipeFolder(
      [
        { path: '/f/a.txt', content: 'https://www.pathofexile.com/trade/search/Allflame/Dup1 | first' },
        { path: '/f/b.json', content: JSON.stringify([{ slug: 'Dup1', label: 'second' }]) },
        { path: '/f/broken.json', content: '{not json' },
        { path: '/f/c.txt', content: 'https://www.pathofexile.com/trade/search/Allflame/Uniq2' },
      ],
      warn,
    );
    expect(targets.map((t) => `${t.searchId}:${t.label}`)).toEqual(['Dup1:first', 'Uniq2:c']);
    expect(warn).toHaveBeenCalledTimes(1);
    expect(String(warn.mock.calls[0]![0])).toContain('broken.json');
  });
});

describe('folder resolution and reading', () => {
  const base = mkdtempSync(join(tmpdir(), 'exilium-bt-'));
  afterAll(() => rmSync(base, { recursive: true, force: true }));

  test('resolveSnipeFolder precedence: flag, env, cwd, home fallback', () => {
    const cwdFolder = join(base, 'cwd', 'BetterTrading');
    mkdirSync(cwdFolder, { recursive: true });
    const opts = { env: {}, cwd: join(base, 'cwd'), home: join(base, 'home') };
    expect(resolveSnipeFolder({ ...opts, flagValue: '/explicit' })).toBe('/explicit');
    expect(resolveSnipeFolder({ ...opts, env: { EXILIUM_BETTERTRADING: '/from-env' } })).toBe('/from-env');
    expect(resolveSnipeFolder(opts)).toBe(cwdFolder);
    expect(resolveSnipeFolder({ ...opts, cwd: join(base, 'elsewhere') })).toBe(
      join(base, 'home', '.exilium', 'BetterTrading'),
    );
  });

  test('readSnipeFolderFiles walks recursively, skipping hidden and unknown extensions', () => {
    const dir = join(base, 'folder');
    mkdirSync(join(dir, 'nested'), { recursive: true });
    writeFileSync(join(dir, 'a.txt'), 'x');
    writeFileSync(join(dir, 'nested', 'b.json'), '[]');
    writeFileSync(join(dir, '.hidden.txt'), 'x');
    writeFileSync(join(dir, 'image.png'), 'x');
    writeFileSync(join(dir, 'README.txt'), 'docs with example urls — never targets');
    const files = readSnipeFolderFiles(dir);
    expect(files.map((f) => f.path.slice(dir.length + 1)).sort()).toEqual(['a.txt', join('nested', 'b.json')]);
    expect(files.find((f) => f.path.endsWith('a.txt'))?.content).toBe('x');
  });
});
