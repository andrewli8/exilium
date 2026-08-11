import { describe, expect, test, vi } from 'vitest';
import { RewardFloorService, unidFloorExpression } from '../src/snipe/reward-floor.js';

describe('RewardFloorService', () => {
  test('fetches the unid floor through the page and caches it', async () => {
    const evaluate = vi.fn(async () => ({ amount: 93, currency: 'divine' }));
    const service = new RewardFloorService({
      league: 'Allflame',
      getEvaluate: () => evaluate,
      log: () => undefined,
      now: () => 1_000,
    });
    expect(await service.floorPrice('Sublime Vision')).toEqual({ amount: 93, currency: 'divine' });
    expect(await service.floorPrice('Sublime Vision')).toEqual({ amount: 93, currency: 'divine' });
    expect(evaluate).toHaveBeenCalledTimes(1);
    expect(evaluate.mock.calls[0]?.[0]).toContain('Sublime Vision');
    expect(evaluate.mock.calls[0]?.[0]).toContain('identified');
  });

  test('cached() answers synchronously, stale-while-revalidate style', async () => {
    let clock = 1_000;
    const evaluate = vi.fn(async () => ({ amount: 93, currency: 'divine' }));
    const service = new RewardFloorService({
      league: 'Allflame',
      getEvaluate: () => evaluate,
      log: () => undefined,
      now: () => clock,
      ttlMs: 5_000,
    });
    expect(service.cached('Sublime Vision')).toBeUndefined(); // never fetched
    await service.floorPrice('Sublime Vision');
    expect(service.cached('Sublime Vision')).toEqual({ amount: 93, currency: 'divine' });
    clock = 100_000; // stale — cached still answers, refresh happens elsewhere
    expect(service.cached('Sublime Vision')).toEqual({ amount: 93, currency: 'divine' });
  });

  test('caches a missing floor briefly and refetches after the failure TTL', async () => {
    let clock = 1_000;
    const evaluate = vi.fn(async () => null);
    const service = new RewardFloorService({
      league: 'Allflame',
      getEvaluate: () => evaluate,
      log: () => undefined,
      now: () => clock,
      failureTtlMs: 5_000,
    });
    expect(await service.floorPrice('Nimis')).toBeNull();
    expect(await service.floorPrice('Nimis')).toBeNull();
    expect(evaluate).toHaveBeenCalledTimes(1);
    clock = 7_000;
    await service.floorPrice('Nimis');
    expect(evaluate).toHaveBeenCalledTimes(2);
  });

  test('retries once when the tab navigates mid-evaluate', async () => {
    const evaluate = vi.fn()
      .mockRejectedValueOnce(new Error('Inspected target navigated or closed'))
      .mockResolvedValueOnce({ amount: 92, currency: 'divine' });
    const service = new RewardFloorService({
      league: 'Allflame',
      getEvaluate: () => evaluate,
      log: () => undefined,
      now: () => 1_000,
      retryDelayMs: 0,
    });
    expect(await service.floorPrice('Sublime Vision')).toEqual({ amount: 92, currency: 'divine' });
    expect(evaluate).toHaveBeenCalledTimes(2);
  });

  test('returns null without a page to evaluate on and rejects junk shapes', async () => {
    const service = new RewardFloorService({
      league: 'Allflame',
      getEvaluate: () => null,
      log: () => undefined,
      now: () => 1_000,
    });
    expect(await service.floorPrice('Sublime Vision')).toBeNull();

    const junk = new RewardFloorService({
      league: 'Allflame',
      getEvaluate: () => async () => ({ amount: 'many', currency: 42 }),
      log: () => undefined,
      now: () => 1_000,
    });
    expect(await junk.floorPrice('Sublime Vision')).toBeNull();
  });

  test('the in-page expression searches the exact name, unidentified, price ascending', () => {
    const expression = unidFloorExpression('Allflame', 'Sublime Vision');
    expect(expression).toContain('/api/trade/search/Allflame');
    expect(expression).toContain('\\"name\\":\\"Sublime Vision\\"');
    expect(expression).toContain('\\"identified\\":{\\"option\\":\\"false\\"}');
    expect(expression).toContain('\\"sort\\":{\\"price\\":\\"asc\\"}');
  });
});
