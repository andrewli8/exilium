import React from 'react';
import { describe, expect, test, vi } from 'vitest';
import { render } from 'ink-testing-library';
import type { CatalogEntry } from '../src/snipe/catalog.js';
import { SnipeConfigureOverlay } from '../src/snipe/configure.js';

const flush = () => new Promise((resolve) => setTimeout(resolve, 40));

function entry(id: string, enabled = true): CatalogEntry {
  return { key: `trade:${id}`, label: `Target ${id}`, realm: 'trade', searchId: id, league: 'Allflame', enabled, source: 'Exilium' };
}

describe('SnipeConfigureOverlay', () => {
  test('Space toggles a search and Enter saves then starts enabled keys', async () => {
    const onSave = vi.fn(async (entries: readonly CatalogEntry[]) => entries);
    const onStart = vi.fn(async () => undefined);
    const ui = render(
      <SnipeConfigureOverlay entries={[entry('one'), entry('two')]} onSave={onSave} onStart={onStart} onClose={() => undefined} />,
    );
    ui.stdin.write(' ');
    await flush();
    ui.stdin.write('\r');
    await flush();

    expect(onSave.mock.calls[0]?.[0][0]).toMatchObject({ key: 'trade:one', enabled: false });
    expect(onStart).toHaveBeenCalledWith(['trade:two']);
  });

  test('invalid import remains open with an actionable error', async () => {
    const onClose = vi.fn();
    const onImport = vi.fn(async () => { throw new Error('expected "2:<base64>" or "3:<base64>"'); });
    const ui = render(
      <SnipeConfigureOverlay entries={[]} onSave={async (entries) => entries} onStart={async () => undefined} onClose={onClose} onImport={onImport} />,
    );
    ui.stdin.write('i');
    await flush();
    ui.stdin.write('not-an-export');
    await flush();
    ui.stdin.write('\r');
    await flush();

    expect(ui.lastFrame()).toMatch(/expected "2:<base64>" or "3:<base64>"/i);
    expect(onClose).not.toHaveBeenCalled();
  });

  test('e edits label, URL, and per-search floor before saving', async () => {
    const onSave = vi.fn(async (entries: readonly CatalogEntry[]) => entries);
    const ui = render(
      <SnipeConfigureOverlay entries={[entry('one')]} onSave={onSave} onStart={async () => undefined} onClose={() => undefined} />,
    );
    ui.stdin.write('e');
    await flush();
    expect(ui.lastFrame()).toContain('label:');
    ui.stdin.write('\u001b[3~');
    await flush();
    ui.stdin.write('Renamed');
    await flush();
    ui.stdin.write('\t');
    await flush();
    ui.stdin.write('\u001b[3~');
    await flush();
    ui.stdin.write('https://www.pathofexile.com/trade/search/Allflame/newid9');
    await flush();
    ui.stdin.write('\t');
    await flush();
    ui.stdin.write('\u001b[3~');
    await flush();
    ui.stdin.write('25');
    await flush();
    ui.stdin.write('\r');
    await flush();
    ui.stdin.write('\r');
    await flush();

    expect(onSave.mock.calls[0]?.[0][0]).toMatchObject({ label: 'Renamed', searchId: 'newid9', minMarginPct: 25 });
  });
});
