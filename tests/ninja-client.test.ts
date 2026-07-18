import { describe, expect, test, vi } from 'vitest';
import { NinjaClient } from '../src/sources/ninja/client.js';

const LEAGUES = [{ id: 'Runes of Aldur', name: 'Runes of Aldur' }];

function okJson(body: unknown): Response {
  return new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } });
}

describe('NinjaClient', () => {
  test('fetches leagues with the configured User-Agent', async () => {
    const fetchFn = vi.fn().mockResolvedValue(okJson(LEAGUES));
    const client = new NinjaClient({ fetchFn, userAgent: 'Exilium/0.1 (test)' });
    const leagues = await client.getLeagues();
    expect(leagues).toEqual(LEAGUES);
    const [url, init] = fetchFn.mock.calls[0]!;
    expect(String(url)).toContain('/poe2/api/economy/leagues');
    expect(init.headers['User-Agent']).toBe('Exilium/0.1 (test)');
  });

  test('fetches an exchange overview with league and type query params', async () => {
    const fetchFn = vi.fn().mockResolvedValue(okJson({ core: {}, lines: [] }));
    const client = new NinjaClient({ fetchFn, userAgent: 'ua' });
    await client.getExchangeOverview('Runes of Aldur', 'Currency');
    const url = String(fetchFn.mock.calls[0]![0]);
    expect(url).toContain('exchange/current/overview');
    expect(url).toContain('league=Runes+of+Aldur');
    expect(url).toContain('type=Currency');
  });

  test('throws a descriptive error on non-2xx responses', async () => {
    const fetchFn = vi.fn().mockResolvedValue(new Response('nope', { status: 429 }));
    const client = new NinjaClient({ fetchFn, userAgent: 'ua' });
    await expect(client.getLeagues()).rejects.toThrow(/429/);
  });
});
