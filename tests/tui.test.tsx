import { describe, expect, test } from 'vitest';
import React from 'react';
import { render } from 'ink-testing-library';
import { ExiliumTui } from '../src/tui/app.js';
import { ExiliumService } from '../src/mcp/service.js';
import { createDb } from '../src/storage/db.js';
import { SnapshotRepository } from '../src/storage/snapshot-repository.js';
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
  const repo = new SnapshotRepository(createDb(':memory:'));
  repo.save(SNAP);
  return new ExiliumService(repo);
}

const PROPS = { game: 'poe1' as const, league: 'Mirage', refreshSec: 9999 };

const flush = () => new Promise((r) => setTimeout(r, 50));

describe('ExiliumTui', () => {
  test('renders header with league, primary currency, and the movers view by default', () => {
    const { lastFrame } = render(<ExiliumTui service={makeService()} {...PROPS} />);
    const frame = lastFrame()!;
    expect(frame).toContain('EXILIUM');
    expect(frame).toContain('poe1/Mirage');
    expect(frame).toContain('chaos');
    expect(frame).toContain('Crashed Orb');
    expect(frame).toContain('MOVERS');
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
    expect(lastFrame()!).toContain('Implied');
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

  test('shows the empty state when no data is ingested', () => {
    const repo = new SnapshotRepository(createDb(':memory:'));
    const { lastFrame } = render(
      <ExiliumTui service={new ExiliumService(repo)} {...PROPS} />,
    );
    expect(lastFrame()!).toMatch(/no data/i);
  });
});
