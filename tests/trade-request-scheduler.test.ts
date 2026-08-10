import { describe, expect, test, vi } from 'vitest';
import { TradeRateLimiter } from '../src/trade/rate-limit.js';
import { TradeRequestScheduler } from '../src/trade/request-scheduler.js';

function deferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

function response(status = 200, headers: Record<string, string> = {}): Response {
  return new Response('{}', { status, headers });
}

describe('TradeRequestScheduler', () => {
  test('serializes request execution', async () => {
    const scheduler = new TradeRequestScheduler({ limiter: new TradeRateLimiter() });
    const firstGate = deferred<void>();
    let active = 0;
    let maxActive = 0;
    const first = scheduler.schedule('seed', async () => {
      active += 1;
      maxActive = Math.max(maxActive, active);
      await firstGate.promise;
      active -= 1;
      return response();
    });
    const second = scheduler.schedule('seed', async () => {
      active += 1;
      maxActive = Math.max(maxActive, active);
      active -= 1;
      return response();
    });

    await Promise.resolve();
    expect(maxActive).toBe(1);
    firstGate.resolve();
    await Promise.all([first, second]);
    expect(maxActive).toBe(1);
  });

  test('runs queued live work before queued seed work', async () => {
    const scheduler = new TradeRequestScheduler({ limiter: new TradeRateLimiter() });
    const firstGate = deferred<void>();
    const order: string[] = [];
    const first = scheduler.schedule('seed', async () => {
      await firstGate.promise;
      order.push('first');
      return response();
    });
    const seed = scheduler.schedule('seed', async () => {
      order.push('seed');
      return response();
    });
    const live = scheduler.schedule('live', async () => {
      order.push('live');
      return response();
    });

    firstGate.resolve();
    await Promise.all([first, seed, live]);
    expect(order).toEqual(['first', 'live', 'seed']);
  });

  test('rejects aborted queued work without invoking it', async () => {
    const scheduler = new TradeRequestScheduler({ limiter: new TradeRateLimiter() });
    const controller = new AbortController();
    const operation = vi.fn(async () => response());
    controller.abort();

    await expect(scheduler.schedule('seed', operation, controller.signal)).rejects.toMatchObject({ name: 'AbortError' });
    expect(operation).not.toHaveBeenCalled();
  });

  test('waits through a proactive cooldown and publishes scheduler health', async () => {
    let now = 0;
    const waits: number[] = [];
    const limiter = new TradeRateLimiter(() => now);
    limiter.observe(response(200, {
      'X-Rate-Limit-Rules': 'Ip',
      'X-Rate-Limit-Ip': '1:5:60',
      'X-Rate-Limit-Ip-State': '1:5:0',
    }));
    const scheduler = new TradeRequestScheduler({
      limiter,
      wait: async (milliseconds) => {
        waits.push(milliseconds);
        now += milliseconds;
      },
    });
    const observed: number[] = [];
    scheduler.subscribe((health) => {
      if (health.state === 'cooldown') observed.push(health.cooldownRemainingSec);
    });

    await scheduler.schedule('live', async () => response());

    expect(waits).toEqual([1_000, 1_000, 1_000, 1_000, 1_000]);
    expect(observed).toEqual(expect.arrayContaining([5, 4, 3, 2, 1]));
    expect(scheduler.health()).toMatchObject({ state: 'ready', queued: 0, cooldownRemainingSec: 0 });
  });
});
