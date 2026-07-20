import { describe, expect, test } from 'vitest';
import React from 'react';
import { render } from 'ink-testing-library';
import { ExiliumTui } from '../src/tui/app.js';
import { ExiliumService } from '../src/mcp/service.js';
import { createDb } from '../src/storage/db.js';
import { SnapshotRepository } from '../src/storage/snapshot-repository.js';
import { WatchRepository } from '../src/storage/watch-repository.js';
import type { MarketSnapshot } from '../src/domain/types.js';

const SNAP: MarketSnapshot = {
  game: 'poe1',
  league: 'Mirage',
  category: 'Currency',
  fetchedAt: '2026-07-18T18:00:00Z',
  core: { primary: 'chaos', perPrimary: { chaos: 1, divine: 0.0014 } },
  lines: [
    {
      itemId: 'divine',
      name: 'Divine Orb',
      category: 'Currency',
      primaryValue: 720,
      volumePrimaryValue: 900000,
      maxVolumeCurrency: 'chaos',
      maxVolumeRate: 0.0014,
      sparkline: [1, 2, 3, 2, 1, 2, 3],
      totalChange: 3,
    },
    {
      itemId: 'crashed',
      name: 'Crashed Orb',
      category: 'Currency',
      primaryValue: 10,
      volumePrimaryValue: 40000,
      maxVolumeCurrency: 'divine',
      maxVolumeRate: 60,
      sparkline: [10, 12, 11, 9, 10, 11, -40],
      totalChange: -40,
    },
  ],
};

function makeService(): ExiliumService {
  const db = createDb(':memory:');
  const repo = new SnapshotRepository(db);
  repo.save(SNAP);
  const watches = new WatchRepository(db);
  watches.upsert({
    id: 'divine-alert',
    game: 'poe1',
    league: 'Mirage',
    kind: 'price_above',
    itemId: 'divine',
    category: null,
    threshold: 700,
    mode: 'repeat',
    webhookUrl: null,
    createdAt: '2026-07-18T17:00:00Z',
    active: true,
  });
  watches.recordEvents([
    {
      watchId: 'divine-alert',
      firedAt: '2026-07-18T17:30:00Z',
      payload: { itemName: 'Divine Orb', value: 715, kind: 'price_above' },
      dedupeKey: 'seed',
    },
  ]);
  return new ExiliumService(repo, undefined, watches);
}

const PROPS = { game: 'poe1' as const, league: 'Mirage', refreshSec: 9999 };

function makeBigService(n: number): ExiliumService {
  const db = createDb(':memory:');
  const repo = new SnapshotRepository(db);
  repo.save({
    ...SNAP,
    lines: Array.from({ length: n }, (_, i) => ({
      itemId: `item-${i}`,
      name: `Item Number ${i}`,
      category: 'Currency',
      primaryValue: 10 + i,
      volumePrimaryValue: 1000 + i,
      maxVolumeCurrency: null,
      maxVolumeRate: null,
      sparkline: [1, 2, 1, 2, 1, 2, 1],
      totalChange: i,
    })),
  });
  return new ExiliumService(repo);
}

const flush = () => new Promise((r) => setTimeout(r, 50));

describe('ExiliumTui', () => {
  test('renders header with league, primary currency, and the movers view by default', () => {
    const { lastFrame } = render(<ExiliumTui service={makeService()} {...PROPS} />);
    const frame = lastFrame()!;
    expect(frame).toContain('EXILIUM');
    expect(frame).toContain('poe1/Mirage');
    expect(frame).toContain('chaos');
    expect(frame).toContain('Crashed Orb');
    expect(frame).toContain('ITEM'); // movers table header — tab labels truncate in the narrow test terminal
  });

  test('shows a sparkline detail for the selected row', () => {
    const { lastFrame } = render(<ExiliumTui service={makeService()} {...PROPS} />);
    expect(lastFrame()!).toMatch(/[▁▂▃▄▅▆▇█]{3,}/);
  });

  test('switches to opportunities view on "2" and arbitrage view on "3"', async () => {
    const { lastFrame, stdin } = render(<ExiliumTui service={makeService()} {...PROPS} />);
    await flush();
    stdin.write('2');
    await flush();
    expect(lastFrame()!).toContain('mean-reversion');
    stdin.write('3');
    await flush();
    expect(lastFrame()!).toMatch(/IMPLIED/i);
  });

  test('moves the selection with arrow keys', async () => {
    const { lastFrame, stdin } = render(<ExiliumTui service={makeService()} {...PROPS} />);
    await flush();
    const before = lastFrame()!;
    stdin.write('[B'); // down arrow
    await flush();
    const after = lastFrame()!;
    expect(before).not.toEqual(after);
  });

  test('opportunities pane shows the trade plan for the selected row', async () => {
    const { lastFrame, stdin } = render(<ExiliumTui service={makeService()} {...PROPS} />);
    await flush();
    stdin.write('2');
    await flush();
    const frame = lastFrame()!;
    expect(frame).toContain('exilium journal add');
    expect(frame).toMatch(/never executes|expected edge/i);
  });

  test('pressing 4 shows the watch-events pane', async () => {
    const { lastFrame, stdin } = render(<ExiliumTui service={makeService()} {...PROPS} />);
    await flush();
    stdin.write('4');
    await flush();
    const frame = lastFrame()!;
    expect(frame).toContain('divine-alert');
    expect(frame).toContain('Divine Orb');
    expect(frame).toContain('715');
  });

  test('calls onIngest automatically on the autoIngestSec cadence', async () => {
    let calls = 0;
    const onIngest = async () => { calls += 1; };
    render(<ExiliumTui service={makeService()} {...PROPS} autoIngestSec={0.05} onIngest={onIngest} />);
    await new Promise((r) => setTimeout(r, 200));
    expect(calls).toBeGreaterThanOrEqual(2);
  });

  test('shows a freshness indicator for old data', () => {
    const { lastFrame } = render(<ExiliumTui service={makeService()} {...PROPS} />);
    expect(lastFrame()!).toMatch(/h ago|m ago|just now/);
  });

  test('c cycles the category filter; arrow keys never leave navigation', async () => {
    // Two categories: cycling to the second must filter rows to it, and the
    // right arrow must NOT change the category (it pages instead).
    const db = createDb(':memory:');
    const repo = new SnapshotRepository(db);
    repo.save(SNAP); // Currency: Divine Orb, Crashed Orb
    repo.save({
      ...SNAP,
      category: 'Scarab',
      lines: [{ ...SNAP.lines[0]!, itemId: 'ambush', name: 'Ambush Scarab', category: 'Scarab' }],
    });
    const service = new ExiliumService(repo);
    const { lastFrame, stdin } = render(<ExiliumTui service={service} {...PROPS} />);
    await flush();
    stdin.write('c'); // All -> first category
    await flush();
    stdin.write('c'); // -> second category
    await flush();
    const frames = [lastFrame()!];
    const scarabOnly = frames[0]!.includes('Ambush Scarab') && !frames[0]!.includes('Divine Orb');
    const currencyOnly = frames[0]!.includes('Divine Orb') && !frames[0]!.includes('Ambush Scarab');
    expect(scarabOnly || currencyOnly).toBe(true); // filtered to exactly one category
    stdin.write('\u001B[C'); // right arrow: pages, must not change the filter
    await flush();
    expect(lastFrame()!.includes('Ambush Scarab')).toBe(frames[0]!.includes('Ambush Scarab'));
  });

  test('shift+arrow jump also works during sort mode', async () => {
    const { lastFrame, stdin } = render(<ExiliumTui service={makeBigService(40)} {...PROPS} />);
    await flush();
    stdin.write('f');
    await flush();
    stdin.write('\u001B[1;2B'); // shift+down: 10 rows, direction untouched
    await flush();
    expect(lastFrame()!).toMatch(/row 11 of 40/);
    expect(lastFrame()!).toContain('▼');
  });

  test('large chaos prices display in divines with a unit tag', () => {
    const { lastFrame } = render(<ExiliumTui service={makeService()} {...PROPS} />);
    // Divine Orb at 720c with divine rate 0.0014 ≈ 1.01 div → shown as div.
    expect(lastFrame()!).toMatch(/1\.01\s*div/);
  });

  test('shows a 24H change column in the movers view', () => {
    const { lastFrame } = render(<ExiliumTui service={makeService()} {...PROPS} />);
    expect(lastFrame()!).toContain('24H');
  });

  test('s enters search mode and filters rows as you type', async () => {
    const { lastFrame, stdin } = render(<ExiliumTui service={makeService()} {...PROPS} />);
    await flush();
    stdin.write('s');
    await flush();
    expect(lastFrame()!).toMatch(/search:/i);
    stdin.write('crash');
    await flush();
    const frame = lastFrame()!;
    expect(frame).toContain('Crashed Orb');
    expect(frame).not.toContain('Divine Orb');
    stdin.write('\u001B'); // esc clears the filter
    await flush();
    expect(lastFrame()!).toContain('Divine Orb');
  });

  test('arrows scroll rows during sort mode without touching the direction', async () => {
    const { lastFrame, stdin } = render(<ExiliumTui service={makeBigService(40)} {...PROPS} />);
    await flush();
    stdin.write('f');
    await flush();
    expect(lastFrame()!).toContain('▼');
    stdin.write('\u001B[B'); // scrolls, does not flip the sort
    stdin.write('\u001B[B');
    await flush();
    const frame = lastFrame()!;
    expect(frame).toContain('ITEM▼'); // header marker unchanged
    expect(frame).not.toContain('ITEM▲');
    expect(frame).toMatch(/row 3 of 40/);
  });

  test('selection scrolls past the viewport and shows position', async () => {
    const { lastFrame, stdin } = render(<ExiliumTui service={makeBigService(40)} {...PROPS} />);
    await flush();
    for (let i = 0; i < 30; i++) stdin.write('\u001B[B');
    await flush();
    const frame = lastFrame()!;
    expect(frame).toMatch(/31 of 40/);
  });

  test('f only toggles direction on the current column, never advancing', async () => {
    const { lastFrame, stdin } = render(<ExiliumTui service={makeService()} {...PROPS} />);
    await flush();
    stdin.write('f'); // enter sort mode: first column, descending
    await flush();
    expect(lastFrame()!).toContain('ITEM▼');
    stdin.write('f'); // toggle: ascending, same column
    await flush();
    expect(lastFrame()!).toContain('ITEM▲');
    stdin.write('f'); // toggle back: descending, STILL the same column
    await flush();
    expect(lastFrame()!).toContain('ITEM▼');
    expect(lastFrame()!).not.toContain('CATEGORY▼');
    stdin.write('\u001B[C'); // right arrow changes column explicitly
    await flush();
    expect(lastFrame()!).toContain('CATEGORY▼');
  });

  test('shift+arrow jumps 10 rows', async () => {
    const { lastFrame, stdin } = render(<ExiliumTui service={makeBigService(40)} {...PROPS} />);
    await flush();
    stdin.write('\u001B[1;2B'); // shift+down
    await flush();
    expect(lastFrame()!).toMatch(/row 11 of 40/);
    stdin.write('\u001B[1;2A'); // shift+up
    await flush();
    expect(lastFrame()!).toMatch(/row 1 of 40/);
  });

  test('arrows keep scrolling while a search filter is active', async () => {
    const { lastFrame, stdin } = render(<ExiliumTui service={makeBigService(40)} {...PROPS} />);
    await flush();
    stdin.write('s');
    await flush();
    stdin.write('Item'); // matches all 40 fixture rows
    await flush();
    stdin.write('\u001B[B'); // down while still in search mode
    stdin.write('\u001B[B');
    await flush();
    expect(lastFrame()!).toMatch(/row 3 of 40/);
    stdin.write('\u001B[1;2B'); // shift+down works here too
    await flush();
    expect(lastFrame()!).toMatch(/row 13 of 40/);
  });

  test('enter on a selected row opens its trade link', async () => {
    const opened: string[] = [];
    const { stdin } = render(
      <ExiliumTui service={makeService()} {...PROPS} onOpenLink={(url) => { opened.push(url); }} />,
    );
    await flush();
    stdin.write('\r');
    await flush();
    expect(opened).toHaveLength(1);
    expect(opened[0]).toContain('/trade/search/Mirage?q=');
    expect(decodeURIComponent(opened[0]!)).toContain('"type"');
  });

  test('shows the empty state when no data is ingested', () => {
    const repo = new SnapshotRepository(createDb(':memory:'));
    const { lastFrame } = render(
      <ExiliumTui service={new ExiliumService(repo)} {...PROPS} />,
    );
    expect(lastFrame()!).toMatch(/no data/i);
  });
});
