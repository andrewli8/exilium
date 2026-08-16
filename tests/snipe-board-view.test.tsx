import React from 'react';
import { describe, expect, test, vi } from 'vitest';
import { render } from 'ink-testing-library';
import type { CatalogEntry } from '../src/snipe/catalog.js';
import { SnipeBoardView } from '../src/snipe/board-view.js';
import { travelStoreListing } from '../src/snipe/console.js';
import { SnipeStore } from '../src/snipe/store.js';
import type { SnipeAlert } from '../src/snipe/engine.js';

const flush = () => new Promise((resolve) => setTimeout(resolve, 40));
const target = (id: string): CatalogEntry => ({ key: `trade:${id}`, label: `Target ${id}`, realm: 'trade', searchId: id, league: 'Allflame', enabled: true, source: 'Exilium' });
const alert = (id: string, marginPct = 25, overrides: Partial<SnipeAlert> = {}): SnipeAlert => ({
  targetId: 'trade:one', targetLabel: 'Target one', source: 'live', listingId: id, itemName: `Valdo ${id}`, priceText: '10 divine', seller: 'Seller', listedAt: null,
  searchUrl: 'https://www.pathofexile.com/trade/search/Allflame/one', listedChaos: 2_000, marginChaos: 500, marginPct, marginText: `+${marginPct}%`, freshnessText: 'ref 1m ago', stale: false,
  unknownMargin: false, minMarginPct: 20, targetMinMarginPct: null, qualifiesMargin: marginPct >= 20,
  ...overrides,
});

describe('SnipeBoardView', () => {
  test('shows watched searches while the table has no listings', async () => {
    const store = new SnipeStore([target('one'), target('two')]);
    const ui = render(<SnipeBoardView store={store} onTravel={async () => ({ action: 'failed', detail: 'unused' })} />);
    expect(ui.lastFrame()).toContain('Target one');
    expect(ui.lastFrame()).toContain('Target two');
    expect(ui.lastFrame()).toContain('Threshold: +0% profit');
    expect(ui.lastFrame()).toContain('press t to change');
    expect(ui.lastFrame()).toMatch(/waiting for listings/i);
  });

  test('Enter with an empty table explains why and does not travel', async () => {
    const store = new SnipeStore([target('one')]);
    const travel = vi.fn(async () => ({ action: 'failed' as const, detail: 'unused' }));
    const ui = render(<SnipeBoardView store={store} onTravel={travel} />);
    ui.stdin.write('\r');
    await flush();
    expect(travel).not.toHaveBeenCalled();
    expect(ui.lastFrame()).toMatch(/no listings yet/i);
  });

  test('renders the Price/Profit/Time/Reward table with below-floor rows kept visible', async () => {
    const store = new SnipeStore([target('one')]);
    store.ingest(alert('good', 25));
    store.ingest(alert('dim', 5, { marginChaos: 80 }));
    const ui = render(<SnipeBoardView store={store} onTravel={async () => ({ action: 'failed', detail: 'unused' })} />);
    const frame = ui.lastFrame()!;
    expect(frame).toContain('PRICE');
    expect(frame).toContain('PROFIT');
    expect(frame).toContain('TIME');
    expect(frame).toContain('REWARD');
    expect(frame).toContain('Valdo good');
    expect(frame).toContain('Valdo dim');
    expect(frame).toContain('+500c');
    expect(frame).toContain('+80c');
  });

  test('Enter travels the selected listing and reports Travel sent', async () => {
    const store = new SnipeStore([target('one')]);
    store.ingest(alert('go', 25));
    const travel = vi.fn(async () => ({ action: 'traveled' as const, detail: 'clicked' }));
    const ui = render(<SnipeBoardView store={store} onTravel={(listingId) => travelStoreListing(store, listingId, travel)} />);
    ui.stdin.write('\r');
    await flush();
    expect(travel).toHaveBeenCalledTimes(1);
    expect(ui.lastFrame()).toContain('Travel sent');
  });

  test('arrow keys walk the flat table across searches', async () => {
    const store = new SnipeStore([target('one'), target('two')]);
    store.ingest(alert('first', 25, { listedAt: '2026-08-09T12:01:00.000Z' }));
    store.ingest(alert('second', 25, { targetId: 'trade:two', targetLabel: 'Target two', listedAt: '2026-08-09T12:00:00.000Z' }));
    const ui = render(<SnipeBoardView store={store} onTravel={async () => ({ action: 'failed', detail: 'unused' })} />);
    ui.stdin.write('[B');
    await flush();
    expect(store.snapshot().queue.selectedListingId).toBe('second');
    expect(store.snapshot().queue.selectedTargetId).toBe('trade:two');
  });

  test('Shift+arrows jump ten rows at a time', async () => {
    const store = new SnipeStore([target('one')]);
    for (let i = 0; i < 15; i += 1) {
      store.ingest(alert(`row-${i}`, 25, { listedAt: new Date(Date.parse('2026-08-09T12:00:00Z') - i * 60_000).toISOString() }));
    }
    const ui = render(<SnipeBoardView store={store} onTravel={async () => ({ action: 'failed', detail: 'unused' })} />);
    expect(store.snapshot().queue.selectedListingId).toBe('row-0');
    ui.stdin.write('\u001b[1;2B'); // Shift+Down
    await flush();
    expect(store.snapshot().queue.selectedListingId).toBe('row-10');
    ui.stdin.write('\u001b[1;2A'); // Shift+Up
    await flush();
    expect(store.snapshot().queue.selectedListingId).toBe('row-0');
  });

  test('j/k walk rows and J/K jump ten — navigation without arrow keys', async () => {
    const store = new SnipeStore([target('one')]);
    for (let i = 0; i < 15; i += 1) {
      store.ingest(alert(`row-${i}`, 25, { listedAt: new Date(Date.parse('2026-08-09T12:00:00Z') - i * 60_000).toISOString() }));
    }
    const ui = render(<SnipeBoardView store={store} onTravel={async () => ({ action: 'failed', detail: 'unused' })} />);
    ui.stdin.write('j');
    await flush();
    expect(store.snapshot().queue.selectedListingId).toBe('row-1');
    ui.stdin.write('k');
    await flush();
    expect(store.snapshot().queue.selectedListingId).toBe('row-0');
    ui.stdin.write('J');
    await flush();
    expect(store.snapshot().queue.selectedListingId).toBe('row-10');
    ui.stdin.write('K');
    await flush();
    expect(store.snapshot().queue.selectedListingId).toBe('row-0');
  });

  test('Shift+Enter opens the selected listing search detail', async () => {
    const store = new SnipeStore([target('one')]);
    store.ingest(alert('hidden', 10));
    const ui = render(<SnipeBoardView store={store} onTravel={async () => ({ action: 'failed', detail: 'unused' })} />);
    ui.stdin.write('[13;2u');
    await flush();
    expect(ui.lastFrame()).toContain('Valdo hidden');
    expect(store.snapshot().queue.view).toBe('detail');
  });

  test('t opens the threshold prompt and Enter applies the new floor', async () => {
    const store = new SnipeStore([target('one')], { minMarginPct: 20 });
    const ui = render(<SnipeBoardView store={store} onTravel={async () => ({ action: 'failed', detail: 'unused' })} />);
    ui.stdin.write('t');
    await flush();
    expect(ui.lastFrame()).toMatch(/set threshold/i);
    ui.stdin.write('35');
    await flush();
    ui.stdin.write('\r');
    await flush();
    expect(store.snapshot().floor).toBe(35);
    expect(ui.lastFrame()).toContain('Threshold: +35% profit');
  });

  test('the open threshold prompt claims keyboard capture on the store', async () => {
    const store = new SnipeStore([target('one')], { minMarginPct: 20 });
    const ui = render(<SnipeBoardView store={store} onTravel={async () => ({ action: 'failed', detail: 'unused' })} />);
    expect(store.snapshot().keyboardCapture).toBe(false);
    ui.stdin.write('t');
    await flush();
    expect(store.snapshot().keyboardCapture).toBe(true);
    ui.stdin.write('');
    await flush();
    expect(store.snapshot().keyboardCapture).toBe(false);
  });

  test('t accepts a flat divine threshold like 5d', async () => {
    const store = new SnipeStore([target('one')], { minMarginPct: 0 });
    store.setChaosPerDivine(200);
    store.ingest(alert('big', 3, { marginChaos: 1_200 }));
    store.ingest(alert('small', 40, { marginChaos: 300 }));
    const ui = render(<SnipeBoardView store={store} onTravel={async () => ({ action: 'failed', detail: 'unused' })} />);
    ui.stdin.write('t');
    await flush();
    ui.stdin.write('5d');
    await flush();
    ui.stdin.write('\r');
    await flush();
    expect(store.snapshot().flatFloor).toEqual({ chaos: 1_000, label: '5d' });
    expect(ui.lastFrame()).toContain('Threshold: +5d profit');
  });

  test('t accepts a flat chaos threshold like 800c', async () => {
    const store = new SnipeStore([target('one')], { minMarginPct: 0 });
    const ui = render(<SnipeBoardView store={store} onTravel={async () => ({ action: 'failed', detail: 'unused' })} />);
    ui.stdin.write('t');
    await flush();
    ui.stdin.write('800c');
    await flush();
    ui.stdin.write('\r');
    await flush();
    expect(store.snapshot().flatFloor).toEqual({ chaos: 800, label: '800c' });
    expect(ui.lastFrame()).toContain('Threshold: +800c profit');
  });

  test('f still works as a threshold alias', async () => {
    const store = new SnipeStore([target('one')], { minMarginPct: 20 });
    const ui = render(<SnipeBoardView store={store} onTravel={async () => ({ action: 'failed', detail: 'unused' })} />);
    ui.stdin.write('f');
    await flush();
    ui.stdin.write('9');
    await flush();
    ui.stdin.write('\r');
    await flush();
    expect(store.snapshot().floor).toBe(9);
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

  test('shows scheduler cooldown in the board header', () => {
    const store = new SnipeStore([target('one')]);
    store.setStatus('COOLDOWN 4s');
    const ui = render(<SnipeBoardView store={store} onTravel={async () => ({ action: 'failed', detail: 'unused' })} />);
    expect(ui.lastFrame()).toContain('COOLDOWN 4s');
    expect(ui.lastFrame()).not.toContain('SEEDING 0/1');
  });
});
