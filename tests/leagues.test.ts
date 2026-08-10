import { describe, expect, test, vi } from 'vitest';
import { fetchTradeLeagues } from '../src/trade/leagues.js';
import { TradeRateLimiter } from '../src/trade/rate-limit.js';
import { TradeRequestScheduler } from '../src/trade/request-scheduler.js';

const SAMPLE = {
  result: [
    { id: 'Standard', realm: 'pc', text: 'Standard' },
    { id: 'Hardcore', realm: 'pc', text: 'Hardcore' },
    { id: 'Ruthless', realm: 'pc', text: 'Ruthless' },
    { id: 'Hardcore Ruthless', realm: 'pc', text: 'Hardcore Ruthless' },
    { id: 'Standard', realm: 'xbox', text: 'Standard' },
    { id: 'Hardcore', realm: 'sony', text: 'Hardcore' },
  ],
};

function okJson(body: unknown): Response {
  return { ok: true, status: 200, headers: new Headers(), json: async () => body } as unknown as Response;
}

describe('fetchTradeLeagues', () => {
  test('returns pc-realm league ids, deduped, in order, for poe1', async () => {
    const fetchFn = vi.fn(async () => okJson(SAMPLE));
    const leagues = await fetchTradeLeagues('poe1', fetchFn);
    expect(leagues).toEqual(['Standard', 'Hardcore', 'Ruthless', 'Hardcore Ruthless']);
    expect(fetchFn).toHaveBeenCalledWith('https://www.pathofexile.com/api/trade/data/leagues', expect.anything());
  });

  test('uses the trade2 endpoint for poe2', async () => {
    const fetchFn = vi.fn(async () => okJson({ result: [{ id: 'Standard', realm: 'pc', text: 'Standard' }] }));
    await fetchTradeLeagues('poe2', fetchFn);
    expect(fetchFn).toHaveBeenCalledWith('https://www.pathofexile.com/api/trade2/data/leagues', expect.anything());
  });

  test('throws a clear error when the request fails', async () => {
    const fetchFn = vi.fn(async () => ({ ok: false, status: 503, headers: new Headers(), json: async () => ({}) } as unknown as Response));
    await expect(fetchTradeLeagues('poe1', fetchFn)).rejects.toThrow(/leagues/i);
  });

  test('throws when the response shape is unexpected', async () => {
    const fetchFn = vi.fn(async () => okJson({ nope: true }));
    await expect(fetchTradeLeagues('poe1', fetchFn)).rejects.toThrow(/shape/i);
  });

  test('uses the shared scheduler gate before fetching leagues', async () => {
    let now = 0;
    const waits: number[] = [];
    const limiter = new TradeRateLimiter(() => now);
    limiter.observe(new Response('{}', { headers: {
      'X-Rate-Limit-Rules': 'Ip',
      'X-Rate-Limit-Ip': '1:2:60',
      'X-Rate-Limit-Ip-State': '1:2:0',
    } }));
    const scheduler = new TradeRequestScheduler({ limiter, wait: async (ms) => { waits.push(ms); now += ms; } });

    await fetchTradeLeagues('poe1', async () => okJson(SAMPLE), { scheduler });

    expect(waits).toEqual([1_000, 1_000]);
  });
});
