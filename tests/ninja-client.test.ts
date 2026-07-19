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
    const leagues = await client.getLeagues('poe1');
    expect(leagues).toEqual(LEAGUES);
    const [url, init] = fetchFn.mock.calls[0]!;
    expect(String(url)).toContain('/poe1/api/economy/leagues');
    expect(init.headers['User-Agent']).toBe('Exilium/0.1 (test)');
  });

  test('fetches an exchange overview with league and type query params', async () => {
    const fetchFn = vi.fn().mockResolvedValue(okJson({ core: {}, lines: [] }));
    const client = new NinjaClient({ fetchFn, userAgent: 'ua' });
    await client.getExchangeOverview('poe2', 'Runes of Aldur', 'Currency');
    const url = String(fetchFn.mock.calls[0]![0]);
    expect(url).toContain('/poe2/api/economy/exchange/current/overview');
    expect(url).toContain('league=Runes+of+Aldur');
    expect(url).toContain('type=Currency');
  });

  test('throws a descriptive error on non-2xx responses', async () => {
    const fetchFn = vi.fn().mockResolvedValue(new Response('nope', { status: 500 }));
    const client = new NinjaClient({ fetchFn, userAgent: 'ua' });
    await expect(client.getLeagues('poe1')).rejects.toThrow(/500/);
  });

  test('enters cooldown on 429 honoring Retry-After and fails fast without network', async () => {
    let now = 1_000_000;
    const fetchFn = vi
      .fn()
      .mockResolvedValueOnce(new Response('slow down', { status: 429, headers: { 'Retry-After': '120' } }))
      .mockResolvedValue(new Response('[]', { status: 200 }));
    const client = new NinjaClient({ fetchFn, userAgent: 'ua', nowMs: () => now });

    await expect(client.getLeagues('poe1')).rejects.toThrow(/rate limit/i);
    expect(client.upstreamHealth().cooldownRemainingSec).toBe(120);

    // during cooldown: fail fast, no network call
    await expect(client.getLeagues('poe1')).rejects.toThrow(/cooldown/i);
    expect(fetchFn).toHaveBeenCalledTimes(1);

    // after cooldown passes: requests flow again and health clears
    now += 121_000;
    await expect(client.getLeagues('poe1')).resolves.toEqual([]);
    expect(client.upstreamHealth().cooldownRemainingSec).toBe(0);
    expect(client.upstreamHealth().total429s).toBe(1);
  });

  test('defaults to a 60s cooldown when Retry-After is missing', async () => {
    let now = 0;
    const fetchFn = vi.fn().mockResolvedValue(new Response('x', { status: 429 }));
    const client = new NinjaClient({ fetchFn, userAgent: 'ua', nowMs: () => now });
    await expect(client.getLeagues('poe1')).rejects.toThrow(/rate limit/i);
    expect(client.upstreamHealth().cooldownRemainingSec).toBe(60);
  });
});
