import React from 'react';
import { render } from 'ink-testing-library';
import { describe, expect, test, vi } from 'vitest';
import type { SnipeTarget } from '../src/snipe/bettertrading.js';
import type { SnipeAlert } from '../src/snipe/engine.js';
import { SnipeQueueApp, SnipeTargetPicker } from '../src/snipe/console.js';
import type { TravelResult } from '../src/snipe/travel.js';
import { glyphs } from '../src/tui/glyphs.js';

const TARGETS: readonly SnipeTarget[] = [
  { label: 'Currency', realm: 'trade', searchId: 'aaa', league: null },
  { label: 'Uniques', realm: 'trade', searchId: 'bbb', league: null },
];

function alert(id: string): SnipeAlert {
  return {
    targetLabel: `Target ${id}`,
    listingId: id,
    itemName: `Item ${id}`,
    priceText: '10 divine',
    seller: `Seller ${id}`,
    listedAt: '2026-08-09T12:00:00Z',
    searchUrl: `https://www.pathofexile.com/trade/search/Allflame/${id}`,
    listedChaos: 2_000,
    marginChaos: 500,
    marginPct: 25,
    marginText: '+500c (+25.0%)',
    freshnessText: 'ref 1m ago',
    stale: false,
    unknownMargin: false,
  };
}

const flush = async (milliseconds = 0): Promise<void> => {
  await new Promise((resolve) => setTimeout(resolve, milliseconds));
};

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => { resolve = done; });
  return { promise, resolve };
}

describe('SnipeTargetPicker', () => {
  test('Space toggles searches and Enter submits only this run selection', async () => {
    const submitted: string[][] = [];
    const ui = render(
      <SnipeTargetPicker
        targets={TARGETS}
        onSubmit={(targets) => submitted.push(targets.map((target) => target.searchId))}
        onCancel={() => undefined}
      />,
    );
    expect(ui.lastFrame()).toContain('[ ] Currency');
    ui.stdin.write(' ');
    await flush();
    ui.stdin.write('\u001B[B');
    await flush();
    ui.stdin.write(' ');
    await flush();
    ui.stdin.write('\r');
    await flush();
    expect(submitted).toEqual([['aaa', 'bbb']]);
  });

  test('a selects all and Escape cancels without submitting', async () => {
    const submitted = vi.fn();
    const cancelled = vi.fn();
    const ui = render(
      <SnipeTargetPicker targets={TARGETS} onSubmit={submitted} onCancel={cancelled} />,
    );
    ui.stdin.write('a');
    await flush();
    expect(ui.lastFrame()).toContain('[x] Currency');
    expect(ui.lastFrame()).toContain('[x] Uniques');
    ui.stdin.write('\u001B');
    // Ink briefly buffers Escape so it can distinguish it from an arrow-key
    // sequence split across stdin chunks.
    await flush(30);
    expect(cancelled).toHaveBeenCalledTimes(1);
    expect(submitted).not.toHaveBeenCalled();
  });

  test('number keys toggle visible rows and Enter does nothing with no selection', async () => {
    const submitted = vi.fn();
    const ui = render(
      <SnipeTargetPicker targets={TARGETS} onSubmit={submitted} onCancel={() => undefined} />,
    );
    ui.stdin.write('\r');
    await flush();
    expect(submitted).not.toHaveBeenCalled();
    ui.stdin.write('2');
    await flush();
    ui.stdin.write('\r');
    await flush();
    expect(submitted.mock.calls[0]?.[0].map((target: SnipeTarget) => target.searchId)).toEqual(['bbb']);
  });
});

describe('SnipeQueueApp', () => {
  test('ingests an externally accumulated alert when the backing array is reused', async () => {
    const alerts: SnipeAlert[] = [];
    const onTravel = async (): Promise<TravelResult> => ({ action: 'failed', detail: 'unused' });
    const ui = render(<SnipeQueueApp alerts={alerts} onTravel={onTravel} />);
    expect(ui.lastFrame()).toContain('No snipe alerts yet');
    alerts.push(alert('one'));
    ui.rerender(<SnipeQueueApp alerts={alerts} onTravel={onTravel} />);
    await flush();
    expect(ui.lastFrame()).toContain('Item one');
  });

  test('a dismissed alert is not replayed when a later cumulative snapshot arrives', async () => {
    const onTravel = async (): Promise<TravelResult> => ({ action: 'failed', detail: 'unused' });
    const ui = render(<SnipeQueueApp alerts={[alert('one')]} onTravel={onTravel} />);
    await flush();
    ui.stdin.write('d');
    await flush();
    ui.rerender(<SnipeQueueApp alerts={[alert('one'), alert('two')]} onTravel={onTravel} />);
    await flush();
    expect(ui.lastFrame()).not.toContain('Item one');
    expect(ui.lastFrame()).toContain('Item two');
  });

  test('a dismissed listing is not re-added by a non-consecutive duplicate event', async () => {
    const onTravel = async (): Promise<TravelResult> => ({ action: 'failed', detail: 'unused' });
    const ui = render(<SnipeQueueApp alerts={[alert('one')]} onTravel={onTravel} />);
    await flush();
    ui.stdin.write('d');
    await flush();
    ui.rerender(<SnipeQueueApp alerts={[alert('two')]} onTravel={onTravel} />);
    await flush();
    ui.rerender(<SnipeQueueApp alerts={[alert('one')]} onTravel={onTravel} />);
    await flush();
    expect(ui.lastFrame()).not.toContain('Item one');
    expect(ui.lastFrame()).toContain('Item two');
  });

  test('an entry evicted by the queue bound is not resurrected by the next snapshot', async () => {
    const initial = [
      alert('selected'),
      alert('evicted'),
      ...Array.from({ length: 199 }, (_, index) => alert(`row-${index}`)),
    ];
    const onTravel = async (): Promise<TravelResult> => ({ action: 'failed', detail: 'unused' });
    const ui = render(<SnipeQueueApp alerts={initial} onTravel={onTravel} />);
    await flush();
    expect(ui.lastFrame()).not.toContain('Item evicted');
    ui.rerender(<SnipeQueueApp alerts={[...initial, alert('newest')]} onTravel={onTravel} />);
    await flush();
    expect(ui.lastFrame()).not.toContain('Item evicted');
    expect(ui.lastFrame()).toContain('Item newest');
  });

  test('Enter travels only the selected row and duplicate Enter is suppressed while traveling', async () => {
    const gate = deferred<TravelResult>();
    const travelIds: string[] = [];
    const ui = render(
      <SnipeQueueApp
        alerts={[alert('one')]}
        onTravel={async (item) => {
          travelIds.push(item.listingId);
          return gate.promise;
        }}
        now={() => Date.parse('2026-08-09T12:00:05Z')}
      />,
    );
    await flush();
    ui.stdin.write('\r');
    ui.stdin.write('\r');
    await flush();
    expect(travelIds).toEqual(['one']);
    expect(ui.lastFrame()).toContain('TRAVELING');
    expect(ui.lastFrame()).toContain('5s');
    gate.resolve({ action: 'traveled', detail: 'clicked Travel to Hideout for Item one' });
    await flush();
    expect(ui.lastFrame()).toContain('TRAVELED');
  });

  test('new alerts do not move selection and failed rows retry with r', async () => {
    let calls = 0;
    const onTravel = async (): Promise<TravelResult> => {
      calls += 1;
      return calls === 1
        ? { action: 'failed', detail: 'listing vanished' }
        : { action: 'traveled', detail: 'clicked Travel to Hideout for Item one' };
    };
    const ui = render(
      <SnipeQueueApp alerts={[alert('one'), alert('two')]} onTravel={onTravel} />,
    );
    await flush();
    expect(ui.lastFrame()).toContain(`${glyphs.select} NEW`);
    expect(ui.lastFrame()).toMatch(new RegExp(`${glyphs.select} NEW.*Item one`));
    ui.rerender(<SnipeQueueApp alerts={[alert('one'), alert('two'), alert('three')]} onTravel={onTravel} />);
    await flush();
    expect(ui.lastFrame()).toMatch(new RegExp(`${glyphs.select} NEW.*Item one`));
    ui.stdin.write('\r');
    await flush();
    expect(ui.lastFrame()).toContain('FAILED');
    expect(ui.lastFrame()).toContain('listing vanished');
    ui.stdin.write('r');
    await flush();
    expect(calls).toBe(2);
    expect(ui.lastFrame()).toContain('TRAVELED');
  });

  test('d dismisses the selected row and q exits', async () => {
    const exited = vi.fn();
    const ui = render(
      <SnipeQueueApp
        alerts={[alert('one')]}
        onTravel={async () => ({ action: 'failed', detail: 'unused' })}
        onExit={exited}
      />,
    );
    await flush();
    ui.stdin.write('d');
    await flush();
    expect(ui.lastFrame()).toContain('No snipe alerts yet');
    ui.stdin.write('q');
    await flush();
    expect(exited).toHaveBeenCalledTimes(1);
  });
});
