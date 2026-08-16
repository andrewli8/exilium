import React from 'react';
import { describe, expect, test, vi } from 'vitest';
import { render } from 'ink-testing-library';
import type { CatalogEntry } from '../src/snipe/catalog.js';
import { SnipeConfigureOverlay } from '../src/snipe/configure.js';

const flush = () => new Promise((resolve) => setTimeout(resolve, 40));

function entry(id: string, enabled = true): CatalogEntry {
  return { key: `trade:${id}`, label: `Target ${id}`, realm: 'trade', searchId: id, league: 'Allflame', enabled, source: 'Exilium' };
}

function grouped(id: string, group: string, enabled = true): CatalogEntry {
  return { ...entry(id, enabled), group, label: `${group} · Target ${id}` };
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

  test('grouped entries render as collapsed folders with enabled counts', async () => {
    const ui = render(
      <SnipeConfigureOverlay
        entries={[grouped('one', 'valdos'), grouped('two', 'valdos', false), grouped('three', 'gambles')]}
        onSave={async (entries) => entries}
        onStart={async () => undefined}
        onClose={() => undefined}
      />,
    );
    const frame = ui.lastFrame()!;
    expect(frame).toContain('valdos');
    expect(frame).toContain('1/2 enabled');
    expect(frame).toContain('gambles');
    expect(frame).toContain('1/1 enabled');
    expect(frame).not.toContain('Target one'); // collapsed by default
  });

  test('right arrow opens a folder and Space toggles a single search inside', async () => {
    const onSave = vi.fn(async (entries: readonly CatalogEntry[]) => entries);
    const onStart = vi.fn(async () => undefined);
    const ui = render(
      <SnipeConfigureOverlay
        entries={[grouped('one', 'valdos'), grouped('two', 'valdos')]}
        onSave={onSave}
        onStart={onStart}
        onClose={() => undefined}
      />,
    );
    ui.stdin.write('[C'); // expand valdos
    await flush();
    expect(ui.lastFrame()).toContain('Target one');
    ui.stdin.write('[B'); // onto first entry
    await flush();
    ui.stdin.write(' ');
    await flush();
    ui.stdin.write('\r');
    await flush();
    expect(onSave.mock.calls[0]?.[0][0]).toMatchObject({ key: 'trade:one', enabled: false });
    expect(onStart).toHaveBeenCalledWith(['trade:two']);
  });

  test('l opens a folder, h closes it, and j moves the cursor — no arrow keys', async () => {
    const onSave = vi.fn(async (entries: readonly CatalogEntry[]) => entries);
    const onStart = vi.fn(async () => undefined);
    const ui = render(
      <SnipeConfigureOverlay
        entries={[grouped('one', 'valdos'), grouped('two', 'valdos')]}
        onSave={onSave}
        onStart={onStart}
        onClose={() => undefined}
      />,
    );
    ui.stdin.write('l'); // expand valdos
    await flush();
    expect(ui.lastFrame()).toContain('Target one');
    ui.stdin.write('j'); // onto first entry
    await flush();
    ui.stdin.write(' ');
    await flush();
    expect(ui.lastFrame()).toContain('[ ]');
    ui.stdin.write('h'); // collapse back to the folder row
    await flush();
    expect(ui.lastFrame()).not.toContain('Target one');
  });

  test('Space on a folder row toggles the whole folder', async () => {
    const onStart = vi.fn(async () => undefined);
    const ui = render(
      <SnipeConfigureOverlay
        entries={[grouped('one', 'valdos'), grouped('two', 'valdos', false), grouped('three', 'gambles')]}
        onSave={async (entries) => entries}
        onStart={onStart}
        onClose={() => undefined}
      />,
    );
    ui.stdin.write(' '); // valdos has a disabled entry → enable all of it
    await flush();
    expect(ui.lastFrame()).toContain('2/2 enabled');
    ui.stdin.write(' '); // now fully enabled → disable the folder
    await flush();
    expect(ui.lastFrame()).toContain('0/2 enabled');
    ui.stdin.write('\r');
    await flush();
    expect(onStart).toHaveBeenCalledWith(['trade:three']);
  });

  test('Shift+Down jumps ten rows and long lists window with more markers', async () => {
    const onSave = vi.fn(async (entries: readonly CatalogEntry[]) => entries);
    const many = Array.from({ length: 20 }, (_, i) => entry(`e${i}`));
    const ui = render(
      <SnipeConfigureOverlay entries={many} onSave={onSave} onStart={async () => undefined} onClose={() => undefined} />,
    );
    expect(ui.lastFrame()).toMatch(/more below/);
    expect(ui.lastFrame()).not.toContain('Target e19');
    ui.stdin.write('\u001b[1;2B'); // Shift+Down → row 10
    await flush();
    ui.stdin.write(' ');
    await flush();
    ui.stdin.write('\r');
    await flush();
    expect(onSave.mock.calls[0]?.[0][10]).toMatchObject({ key: 'trade:e10', enabled: false });
  });

  test('Backspace on a folder asks for confirmation before deleting', async () => {
    const onDeleteFolder = vi.fn(async () => [grouped('three', 'gambles')]);
    const ui = render(
      <SnipeConfigureOverlay
        entries={[grouped('one', 'valdos'), grouped('two', 'valdos'), grouped('three', 'gambles')]}
        onSave={async (entries) => entries}
        onStart={async () => undefined}
        onClose={() => undefined}
        onDeleteFolder={onDeleteFolder}
      />,
    );
    ui.stdin.write(''); // backspace on the valdos folder row
    await flush();
    expect(ui.lastFrame()).toMatch(/delete folder .*valdos.*2 search/i);
    ui.stdin.write('n');
    await flush();
    expect(onDeleteFolder).not.toHaveBeenCalled();
    expect(ui.lastFrame()).toContain('valdos');

    ui.stdin.write('');
    await flush();
    ui.stdin.write('y');
    await flush();
    expect(onDeleteFolder).toHaveBeenCalledWith('valdos');
    expect(ui.lastFrame()).not.toContain('valdos');
    expect(ui.lastFrame()).toContain('gambles');
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
