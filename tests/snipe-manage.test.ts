import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, test } from 'vitest';
import { loadSnipeCatalog, loadSnipeManifest } from '../src/snipe/catalog.js';
import {
  addSnipe,
  editSnipe,
  formatSnipeCatalog,
  parseMaxBuy,
  removeSnipe,
  runInteractiveSnipeEditor,
} from '../src/snipe/manage.js';

function folder(withImport = false): string {
  const dir = mkdtempSync(join(tmpdir(), 'exilium-manage-'));
  if (withImport) {
    writeFileSync(join(dir, 'import.txt'), 'https://www.pathofexile.com/trade/search/Allflame/aaa111 | Sublime Vision\n');
  }
  return dir;
}

describe('snipe management', () => {
  test.each([
    ['20div', { amount: 20, currency: 'divine' }],
    ['20 divine', { amount: 20, currency: 'divine' }],
    ['150c', { amount: 150, currency: 'chaos' }],
    ['1.5 chaos', { amount: 1.5, currency: 'chaos' }],
  ])('parses max-buy value %s', (raw, expected) => {
    expect(parseMaxBuy(raw)).toEqual(expected);
  });

  test.each(['', 'zero div', '0div', '-2c', '2 mirrors'])('rejects invalid max-buy value %s', (raw) => {
    expect(() => parseMaxBuy(raw)).toThrow(/max buy/i);
  });

  test('adds a managed target from a live URL', () => {
    const dir = folder();
    const entry = addSnipe({
      folder: dir,
      url: 'https://www.pathofexile.com/trade/search/Allflame/9zRjda6KHK/live',
      name: 'Sublime Vision',
      maxBuy: { amount: 20, currency: 'divine' },
      minMarginPct: 15,
    });
    expect(entry).toMatchObject({ searchId: '9zRjda6KHK', label: 'Sublime Vision', source: 'Exilium', enabled: true });
    expect(loadSnipeManifest(dir).managed).toHaveLength(1);
  });

  test('adding an imported target updates and re-enables it instead of duplicating it', () => {
    const dir = folder(true);
    editSnipe({ folder: dir, selector: 'aaa111', enabled: false });
    addSnipe({
      folder: dir,
      url: 'https://www.pathofexile.com/trade/search/Allflame/aaa111/live',
      name: 'Cheap Sublime',
    });
    const entries = loadSnipeCatalog(dir, () => undefined);
    expect(entries).toHaveLength(1);
    expect(entries[0]).toMatchObject({ label: 'Cheap Sublime', enabled: true, source: 'Better Trading' });
    expect(loadSnipeManifest(dir).managed).toHaveLength(0);
  });

  test('edits and clears imported target rules through overrides', () => {
    const dir = folder(true);
    editSnipe({
      folder: dir,
      selector: 'sublime',
      name: 'Cheap Sublime',
      maxBuy: { amount: 18, currency: 'divine' },
      minMarginPct: 12,
    });
    expect(loadSnipeCatalog(dir, () => undefined)[0]).toMatchObject({
      label: 'Cheap Sublime', maxBuy: { amount: 18, currency: 'divine' }, minMarginPct: 12,
    });
    editSnipe({ folder: dir, selector: 'aaa111', maxBuy: null, minMarginPct: null });
    const cleared = loadSnipeCatalog(dir, () => undefined)[0]!;
    expect(cleared).not.toHaveProperty('maxBuy');
    expect(cleared).not.toHaveProperty('minMarginPct');
  });

  test('remove disables imported targets but permanently removes managed targets', () => {
    const dir = folder(true);
    const managed = addSnipe({ folder: dir, url: 'https://www.pathofexile.com/trade/search/Allflame/bbb222', name: 'Mageblood' });
    expect(removeSnipe({ folder: dir, selector: 'aaa111' })).toMatchObject({ enabled: false, source: 'Better Trading' });
    expect(loadSnipeCatalog(dir, () => undefined).find((entry) => entry.searchId === 'aaa111')?.enabled).toBe(false);
    removeSnipe({ folder: dir, selector: managed.searchId });
    expect(loadSnipeCatalog(dir, () => undefined).find((entry) => entry.searchId === managed.searchId)).toBeUndefined();
  });

  test('formats enabled state, rules, and source for the CLI', () => {
    const dir = folder(true);
    editSnipe({ folder: dir, selector: 'aaa111', enabled: false, minMarginPct: 15 });
    const rendered = formatSnipeCatalog(loadSnipeCatalog(dir, () => undefined));
    expect(rendered).toContain('aaa111');
    expect(rendered).toContain('disabled');
    expect(rendered).toContain('15%');
    expect(rendered).toContain('Better Trading');
  });

  test('interactive editor retries invalid actions, edits an import, and adds a live URL', async () => {
    const dir = folder(true);
    const answers = [
      'wat',
      'e', 'aaa111', 'Cheap Sublime', '', '15', 'd',
      'a', 'https://www.pathofexile.com/trade/search/Allflame/bbb222/live', 'Mageblood', '20div', '',
      'done',
    ];
    const output: string[] = [];
    await runInteractiveSnipeEditor({
      folder: dir,
      question: async () => answers.shift() ?? 'done',
      out: (message) => output.push(message),
      warn: (message) => output.push(message),
    });
    const entries = loadSnipeCatalog(dir, () => undefined);
    expect(entries.find((entry) => entry.searchId === 'aaa111')).toMatchObject({
      label: 'Cheap Sublime', minMarginPct: 15, enabled: false,
    });
    expect(entries.find((entry) => entry.searchId === 'bbb222')).toMatchObject({
      label: 'Mageblood', maxBuy: { amount: 20, currency: 'divine' }, enabled: true,
    });
    expect(output.join('\n')).toMatch(/Unknown action/i);
    expect(output.join('\n')).toContain('Cheap Sublime');
  });
});
