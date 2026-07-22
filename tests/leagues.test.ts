import { describe, expect, test, vi } from 'vitest';
import { fetchTradeLeagues } from '../src/trade/leagues.js';

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
  return { ok: true, status: 200, json: async () => body } as unknown as Response;
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
    const fetchFn = vi.fn(async () => ({ ok: false, status: 503, json: async () => ({}) } as unknown as Response));
    await expect(fetchTradeLeagues('poe1', fetchFn)).rejects.toThrow(/leagues/i);
  });

  test('throws when the response shape is unexpected', async () => {
    const fetchFn = vi.fn(async () => okJson({ nope: true }));
    await expect(fetchTradeLeagues('poe1', fetchFn)).rejects.toThrow(/shape/i);
  });
});
