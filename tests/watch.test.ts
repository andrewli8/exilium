import { describe, expect, test, vi } from 'vitest';
import { watchTick, initialWatchState } from '../src/watch/watch.js';
import { createNotifier } from '../src/watch/notify.js';
import type { Opportunity } from '../src/domain/types.js';

function opp(overrides: Partial<Opportunity>): Opportunity {
  return {
    id: 'mean-reversion:poe1:Mirage:chaos',
    kind: 'mean-reversion',
    game: 'poe1',
    league: 'Mirage',
    itemId: 'chaos',
    itemName: 'Chaos Orb',
    category: 'Currency',
    edge: 0.5,
    confidence: 0.8,
    rationale: 'below trend',
    dataFreshness: '2026-07-18T18:00:00Z',
    experimental: false,
    ...overrides,
  };
}

describe('watchTick', () => {
  test('notifies for new opportunities above the edge floor and returns updated state', async () => {
    const notify = vi.fn().mockResolvedValue(undefined);
    const result = await watchTick(
      {
        ingest: vi.fn().mockResolvedValue({ saved: ['Currency'], errors: [] }),
        opportunities: () => [opp({}), opp({ id: 'x:2', itemName: 'Divine Orb', edge: 0.9 })],
        notifier: { notify },
      },
      initialWatchState(),
    );
    expect(notify).toHaveBeenCalledTimes(1);
    const [title, message] = notify.mock.calls[0]!;
    expect(title).toContain('2');
    expect(message).toContain('Divine Orb');
    expect(message).toContain('90.0%');
    expect(result.notified).toHaveLength(2);
    expect(result.state.seenIds.has('x:2')).toBe(true);
  });

  test('does not re-notify already-seen opportunity ids', async () => {
    const notify = vi.fn().mockResolvedValue(undefined);
    const deps = {
      ingest: vi.fn().mockResolvedValue({ saved: ['Currency'], errors: [] }),
      opportunities: () => [opp({})],
      notifier: { notify },
    };
    const first = await watchTick(deps, initialWatchState());
    const second = await watchTick(deps, first.state);
    expect(notify).toHaveBeenCalledTimes(1);
    expect(second.notified).toHaveLength(0);
  });

  test('reports ingest errors without throwing and still evaluates cached data', async () => {
    const notify = vi.fn().mockResolvedValue(undefined);
    const result = await watchTick(
      {
        ingest: vi.fn().mockResolvedValue({ saved: [], errors: [{ category: 'Currency', message: 'boom' }] }),
        opportunities: () => [opp({})],
        notifier: { notify },
      },
      initialWatchState(),
    );
    expect(result.ingestErrors).toHaveLength(1);
    expect(result.notified).toHaveLength(1);
  });
});

describe('createNotifier', () => {
  test('sends desktop notification via injected exec and posts to webhook when configured', async () => {
    const execFn = vi.fn().mockResolvedValue(undefined);
    const fetchFn = vi.fn().mockResolvedValue(new Response('ok', { status: 200 }));
    const notifier = createNotifier({
      platform: 'darwin',
      execFn,
      fetchFn,
      webhookUrl: 'https://discord.example/hook',
      log: () => {},
    });
    await notifier.notify('Exilium: 1 opportunity', 'Chaos Orb +50%');
    expect(execFn).toHaveBeenCalledWith('osascript', expect.arrayContaining(['-e', expect.stringContaining('Chaos Orb')]));
    expect(fetchFn).toHaveBeenCalledWith(
      'https://discord.example/hook',
      expect.objectContaining({ method: 'POST' }),
    );
  });

  test('escapes double quotes for osascript', async () => {
    const execFn = vi.fn().mockResolvedValue(undefined);
    const notifier = createNotifier({ platform: 'darwin', execFn, fetchFn: vi.fn(), log: () => {} });
    await notifier.notify('t', 'a "quoted" name');
    const script = execFn.mock.calls[0]![1].join(' ');
    expect(script).not.toContain('"quoted"');
  });

  test('never throws when channels fail — logs instead', async () => {
    const log = vi.fn();
    const notifier = createNotifier({
      platform: 'darwin',
      execFn: vi.fn().mockRejectedValue(new Error('no osascript')),
      fetchFn: vi.fn().mockRejectedValue(new Error('webhook down')),
      webhookUrl: 'https://x',
      log,
    });
    await expect(notifier.notify('t', 'm')).resolves.toBeUndefined();
    expect(log).toHaveBeenCalled();
  });

  test('skips desktop channel on unsupported platforms', async () => {
    const execFn = vi.fn();
    const notifier = createNotifier({ platform: 'win32', execFn, fetchFn: vi.fn(), log: () => {} });
    await notifier.notify('t', 'm');
    expect(execFn).not.toHaveBeenCalled();
  });
});
