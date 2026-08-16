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

function alert(id: string, overrides: Partial<SnipeAlert> = {}): SnipeAlert {
  return {
    targetId: `trade:${id}`,
    targetLabel: `Target ${id}`,
    source: 'live',
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
    minMarginPct: 20,
    qualifiesMargin: true,
    ...overrides,
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

  test('j moves the picker cursor without arrow keys', async () => {
    const submitted: string[][] = [];
    const ui = render(
      <SnipeTargetPicker
        targets={TARGETS}
        onSubmit={(targets) => submitted.push(targets.map((target) => target.searchId))}
        onCancel={() => undefined}
      />,
    );
    ui.stdin.write('j');
    await flush();
    ui.stdin.write(' ');
    await flush();
    ui.stdin.write('\r');
    await flush();
    expect(submitted).toEqual([['bbb']]);
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
    expect(ui.lastFrame()).toContain('0 candidates');
    alerts.push(alert('one'));
    ui.rerender(<SnipeQueueApp alerts={alerts} onTravel={onTravel} />);
    await flush();
    expect(ui.lastFrame()).toContain('Target one');
  });

  test('a dismissed alert is not replayed when a later cumulative snapshot arrives', async () => {
    const onTravel = async (): Promise<TravelResult> => ({ action: 'failed', detail: 'unused' });
    const ui = render(<SnipeQueueApp alerts={[alert('one')]} onTravel={onTravel} />);
    await flush();
    ui.stdin.write('d');
    await flush();
    ui.rerender(<SnipeQueueApp alerts={[alert('one'), alert('two')]} onTravel={onTravel} />);
    await flush();
    expect(ui.lastFrame()).not.toContain('Target one');
    expect(ui.lastFrame()).toContain('Target two');
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
    expect(ui.lastFrame()).not.toContain('Target one');
    expect(ui.lastFrame()).toContain('Target two');
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
    expect(ui.lastFrame()).not.toContain('Target evicted');
    ui.rerender(<SnipeQueueApp alerts={[...initial, alert('newest')]} onTravel={onTravel} />);
    await flush();
    expect(ui.lastFrame()).not.toContain('Target evicted');
    expect(ui.lastFrame()).toContain('Target newest');
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
    expect(ui.lastFrame()).not.toContain('Target one');
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
    expect(ui.lastFrame()).toContain(`${glyphs.select}`);
    expect(ui.lastFrame()).toMatch(new RegExp(`${glyphs.select}.*Target one`));
    ui.rerender(<SnipeQueueApp alerts={[alert('one'), alert('two'), alert('three')]} onTravel={onTravel} />);
    await flush();
    expect(ui.lastFrame()).toMatch(new RegExp(`${glyphs.select}.*Target one`));
    ui.stdin.write('\r');
    await flush();
    expect(ui.lastFrame()).toContain('FAILED');
    expect(ui.lastFrame()).toContain('listing vanished');
    ui.stdin.write('r');
    await flush();
    expect(calls).toBe(2);
    expect(ui.lastFrame()).not.toContain('Target one');
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
    expect(ui.lastFrame()).toContain('0 candidates');
    ui.stdin.write('q');
    await flush();
    expect(exited).toHaveBeenCalledTimes(1);
  });

  test('renders a compact grouped board with hidden counts and no NEW seed label', async () => {
    const ui = render(
      <SnipeQueueApp
        alerts={[
          alert('best', { targetId: 'trade:mb', targetLabel: 'Mageblood', source: 'current', marginPct: 30, marginText: '+3,000c (+30.0%)' }),
          alert('more', { targetId: 'trade:mb', targetLabel: 'Mageblood', source: 'current', marginPct: 25 }),
          alert('below', { targetId: 'trade:nimis', targetLabel: 'Nimis', marginPct: 10, qualifiesMargin: false }),
          alert('unknown', { targetId: 'trade:sublime', targetLabel: 'Sublime Vision', marginPct: null, marginChaos: null, unknownMargin: true, qualifiesMargin: false }),
        ]}
        onTravel={async () => ({ action: 'failed', detail: 'unused' })}
        searchCount={6}
        minMarginPct={20}
      />,
    );
    await flush();
    const frame = ui.lastFrame() ?? '';
    expect(frame).toContain('EXILIUM SNIPES');
    expect(frame).toContain('6 LIVE');
    expect(frame).toContain('Floor +20%');
    expect(frame).toContain('Mageblood');
    expect(frame).toContain('+30.0%');
    expect(frame).toContain('+1');
    expect(frame).toContain('1 shown · 1 below floor · 1 unknown');
    expect(frame).not.toContain('Nimis');
    expect(frame).not.toContain('NEW');
  });

  test('keeps an empty board when no candidate clears the floor and u reveals hidden rows', async () => {
    const ui = render(
      <SnipeQueueApp
        alerts={[alert('near', { marginPct: 19, qualifiesMargin: false })]}
        onTravel={async () => ({ action: 'failed', detail: 'unused' })}
        minMarginPct={20}
      />,
    );
    await flush();
    expect(ui.lastFrame()).toContain('0 candidates');
    expect(ui.lastFrame()).not.toContain('Target near');
    ui.stdin.write('u');
    await flush();
    expect(ui.lastFrame()).toContain('Target near');
  });

  test('Enter travels the group best and gone removes it without auto-traveling its replacement', async () => {
    const calls: string[] = [];
    const ui = render(
      <SnipeQueueApp
        alerts={[
          alert('backup', { targetId: 'trade:mb', targetLabel: 'Mageblood', marginPct: 25 }),
          alert('best', { targetId: 'trade:mb', targetLabel: 'Mageblood', marginPct: 35 }),
        ]}
        onTravel={async (item) => {
          calls.push(item.listingId);
          return { action: 'gone', detail: 'listing sold or removed' };
        }}
      />,
    );
    await flush();
    ui.stdin.write('\r');
    await flush();
    expect(calls).toEqual(['best']);
    expect(ui.lastFrame()).toContain('listing sold or removed — queue updated');
    expect(ui.lastFrame()).toContain('+25.0%');
  });

  test('Shift+Enter opens Valdo detail and Shift+Tab returns to the board', async () => {
    const ui = render(
      <SnipeQueueApp
        alerts={[
          alert('one', { targetId: 'trade:mb', targetLabel: 'Mageblood', itemName: 'Ancestral Gallery' }),
          alert('two', { targetId: 'trade:mb', targetLabel: 'Mageblood', itemName: 'Twisted Refuge', marginPct: 24 }),
        ]}
        onTravel={async () => ({ action: 'failed', detail: 'unused' })}
      />,
    );
    await flush();
    ui.stdin.write('\u001b[13;2u');
    await flush();
    expect(ui.lastFrame()).toContain('/ MAGEBLOOD');
    expect(ui.lastFrame()).toContain('Ancestral Gallery');
    expect(ui.lastFrame()).toContain('Twisted Refuge');
    ui.stdin.write('\u001b[Z');
    await flush();
    expect(ui.lastFrame()).not.toContain('/ MAGEBLOOD');
    expect(ui.lastFrame()).toContain('BEST PRICE');
  });

  test('f changes the session floor and immediately recomputes the board', async () => {
    const ui = render(
      <SnipeQueueApp
        alerts={[alert('candidate', { marginPct: 25, marginText: '+500c (+25.0%)' })]}
        onTravel={async () => ({ action: 'failed', detail: 'unused' })}
        minMarginPct={20}
      />,
    );
    await flush();
    expect(ui.lastFrame()).toContain('Target candidate');
    ui.stdin.write('f');
    await flush();
    expect(ui.lastFrame()).toContain('Set threshold');
    ui.stdin.write('3');
    await flush();
    ui.stdin.write('0');
    await flush();
    ui.stdin.write('\r');
    await flush();
    expect(ui.lastFrame()).toContain('Floor +30%');
    expect(ui.lastFrame()).not.toContain('Target candidate');
    expect(ui.lastFrame()).toContain('1 below floor');
  });

  test('changing the floor repairs selection to the first remaining candidate', async () => {
    const calls: string[] = [];
    const ui = render(
      <SnipeQueueApp
        alerts={[
          alert('low', { marginPct: 25 }),
          alert('high', { marginPct: 35 }),
        ]}
        onTravel={async (item) => {
          calls.push(item.listingId);
          return { action: 'failed', detail: 'unused' };
        }}
      />,
    );
    await flush();
    ui.stdin.write('f');
    await flush();
    ui.stdin.write('3');
    await flush();
    ui.stdin.write('0');
    await flush();
    ui.stdin.write('\r');
    await flush();
    ui.stdin.write('\r');
    await flush();
    expect(calls).toEqual(['high']);
  });

  test('keeps raw Chrome traces out of the board and reveals them only with question mark', async () => {
    const technical = 'browserType.connectOverCDP: Protocol error (Browser.setDownloadBehavior): Browser context management is not supported';
    const ui = render(
      <SnipeQueueApp
        alerts={[alert('one')]}
        onTravel={async () => ({
          action: 'failed',
          detail: 'Chrome unavailable — run exilium chrome, then press Enter again',
          technicalDetail: technical,
        })}
      />,
    );
    await flush();
    ui.stdin.write('\r');
    await flush();
    expect(ui.lastFrame()).toContain('Chrome unavailable');
    expect(ui.lastFrame()).not.toContain('Browser.setDownloadBehavior');
    ui.stdin.write('?');
    await flush();
    expect(ui.lastFrame()).toContain('Browser.setDownloadBehavior');
  });
});
