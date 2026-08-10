import React from 'react';
import { describe, expect, test, vi } from 'vitest';
import { render } from 'ink-testing-library';
import type { CatalogEntry } from '../src/snipe/catalog.js';
import { SnipeBoardView } from '../src/snipe/board-view.js';
import { SnipeStore } from '../src/snipe/store.js';
import type { SnipeAlert } from '../src/snipe/engine.js';

const flush = () => new Promise((resolve) => setTimeout(resolve, 40));
const target = (id: string): CatalogEntry => ({ key: `trade:${id}`, label: `Target ${id}`, realm: 'trade', searchId: id, league: 'Allflame', enabled: true, source: 'Exilium' });
const alert = (id: string, marginPct = 25): SnipeAlert => ({
  targetId: 'trade:one', targetLabel: 'Target one', source: 'live', listingId: id, itemName: `Valdo ${id}`, priceText: '10 divine', seller: 'Seller', listedAt: null,
  searchUrl: 'https://www.pathofexile.com/trade/search/Allflame/one', listedChaos: 2_000, marginChaos: 500, marginPct, marginText: `+${marginPct}%`, freshnessText: 'ref 1m ago', stale: false,
  unknownMargin: false, minMarginPct: 20, targetMinMarginPct: null, qualifiesMargin: marginPct >= 20,
});

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

  test('Shift+Enter exposes the selected search hidden Valdo rows', async () => {
    const store = new SnipeStore([target('one')]);
    store.ingest(alert('hidden', 10));
    const ui = render(<SnipeBoardView store={store} onTravel={async () => ({ action: 'failed', detail: 'unused' })} />);
    ui.stdin.write('\u001b[13;2u');
    await flush();
    expect(ui.lastFrame()).toContain('Valdo hidden');
    expect(store.snapshot().queue.view).toBe('detail');
  });

  test('collapses Chrome protocol traces into one recovery line', async () => {
    const store = new SnipeStore([target('one')]);
    store.ingest(alert('failed'));
    store.dispatch({ type: 'travel-start', listingId: 'failed' });
    store.dispatch({ type: 'travel-failure', listingId: 'failed', detail: 'Browser.setDownloadBehavior\nCall log:\nraw protocol trace' });
    const ui = render(<SnipeBoardView store={store} onTravel={async () => ({ action: 'failed', detail: 'unused' })} />);
    await flush();
    expect(ui.lastFrame()).toContain('Chrome unavailable — run exilium chrome, then press Enter again');
    expect(ui.lastFrame()).not.toContain('Call log:');
  });
});
