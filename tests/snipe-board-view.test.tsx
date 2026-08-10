import React from 'react';
import { describe, expect, test, vi } from 'vitest';
import { render } from 'ink-testing-library';
import type { CatalogEntry } from '../src/snipe/catalog.js';
import { SnipeBoardView } from '../src/snipe/board-view.js';
import { SnipeStore } from '../src/snipe/store.js';

const flush = () => new Promise((resolve) => setTimeout(resolve, 40));
const target = (id: string): CatalogEntry => ({ key: `trade:${id}`, label: `Target ${id}`, realm: 'trade', searchId: id, league: 'Allflame', enabled: true, source: 'Exilium' });

describe('SnipeBoardView', () => {
  test('renders and navigates enabled searches with no candidates', async () => {
    const store = new SnipeStore([target('one'), target('two')]);
    const ui = render(<SnipeBoardView store={store} onTravel={async () => ({ action: 'failed', detail: 'unused' })} />);
    expect(ui.lastFrame()).toContain('Target one');
    expect(ui.lastFrame()).toContain('Target two');
    expect(ui.lastFrame()).toContain('NO MATCH');

    ui.stdin.write('\u001b[B');
    await flush();
    expect(store.snapshot().queue.selectedTargetId).toBe('trade:two');
  });

  test('Enter on an empty search explains why and does not travel', async () => {
    const store = new SnipeStore([target('one')]);
    const travel = vi.fn(async () => ({ action: 'failed' as const, detail: 'unused' }));
    const ui = render(<SnipeBoardView store={store} onTravel={travel} />);
    ui.stdin.write('\r');
    await flush();
    expect(travel).not.toHaveBeenCalled();
    expect(ui.lastFrame()).toMatch(/no candidate.*20%/i);
  });
});
