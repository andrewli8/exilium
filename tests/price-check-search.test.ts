import { describe, expect, test, vi } from 'vitest';
import { searchListings, tradeUrlFor } from '../src/trade/price-check.js';
import type { TradePayload } from '../src/trade/price-check.js';

const payload: TradePayload = { query: { type: 'Saintly Chainmail', stats: [{ type: 'and', filters: [] }] }, sort: { price: 'asc' } };

describe('searchListings', () => {
  test('POSTs the query, fetches the results, and returns priced listings', async () => {
    const fetchFn = vi.fn()
      .mockResolvedValueOnce(new Response(JSON.stringify({ id: 'srch1', result: ['a', 'b', 'c'] }), { status: 200 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ result: [
        { listing: { price: { amount: 5, currency: 'divine' }, account: { lastCharacterName: 'Sell1' }, whisper: '@Sell1 hi' }, item: { name: '', typeLine: 'Saintly Chainmail' } },
        { listing: { price: { amount: 8, currency: 'divine' }, account: { lastCharacterName: 'Sell2' } }, item: {} },
      ] }), { status: 200 }));
    const listings = await searchListings(payload, 'poe1', 'Mirage', 10, { fetchFn, sessionId: 'S' });
    expect(listings).toHaveLength(2);
    expect(listings[0]).toMatchObject({ amount: 5, currency: 'divine', seller: 'Sell1' });
    const [searchUrl, init] = fetchFn.mock.calls[0]!;
    expect(String(searchUrl)).toContain('/api/trade/search/Mirage');
    expect(init.method).toBe('POST');
    expect(init.headers['Cookie']).toContain('POESESSID=S');
    expect(String(fetchFn.mock.calls[1]![0])).toContain('/api/trade/fetch/a,b,c?query=srch1');
  });

  test('returns empty when nothing matches, without a fetch call', async () => {
    const fetchFn = vi.fn().mockResolvedValue(new Response(JSON.stringify({ id: 'x', result: [] }), { status: 200 }));
    expect(await searchListings(payload, 'poe1', 'Mirage', 10, { fetchFn, sessionId: 'S' })).toEqual([]);
    expect(fetchFn).toHaveBeenCalledTimes(1);
  });

  test('explains an expired session', async () => {
    const fetchFn = vi.fn().mockResolvedValue(new Response('no', { status: 401 }));
    await expect(searchListings(payload, 'poe1', 'Mirage', 10, { fetchFn, sessionId: 'BAD' })).rejects.toThrow(/POESESSID|session/i);
  });
});

describe('tradeUrlFor', () => {
  test('builds a poe1 deep link with the encoded payload', () => {
    const url = tradeUrlFor(payload, 'poe1', 'Mirage');
    expect(url).toContain('https://www.pathofexile.com/trade/search/Mirage?q=');
    expect(JSON.parse(decodeURIComponent(url.split('?q=')[1]!)).query.type).toBe('Saintly Chainmail');
  });
});
