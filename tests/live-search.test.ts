import { describe, expect, test, vi } from 'vitest';
import { buildFetchUrl, buildLiveWsUrl, fetchListings, handleNewListings, parseTradeUrl } from '../src/trade/live-search.js';
import { TradeRateLimiter } from '../src/trade/rate-limit.js';

describe('parseTradeUrl', () => {
  test('parses a PoE1 trade search link', () => {
    expect(parseTradeUrl('https://www.pathofexile.com/trade/search/Mirage/AbC123xyz')).toEqual({
      realm: 'trade',
      league: 'Mirage',
      searchId: 'AbC123xyz',
    });
  });

  test('parses a PoE2 trade2 link and URL-encoded league names', () => {
    expect(parseTradeUrl('https://www.pathofexile.com/trade2/search/poe2/Runes%20of%20Aldur/QqQ111')).toEqual({
      realm: 'trade2',
      league: 'Runes of Aldur',
      searchId: 'QqQ111',
    });
  });

  test('rejects URLs that are not trade searches, with guidance', () => {
    expect(() => parseTradeUrl('https://www.pathofexile.com/forum/view-thread/1')).toThrow(/trade search/i);
    expect(() => parseTradeUrl('not a url')).toThrow(/trade search/i);
  });
});

describe('URL builders', () => {
  test('live websocket URL follows the realm and search id', () => {
    expect(buildLiveWsUrl({ realm: 'trade', league: 'Mirage', searchId: 'abc' })).toBe(
      'wss://www.pathofexile.com/api/trade/live/Mirage/abc',
    );
  });

  test('fetch URL batches ids and carries the search id', () => {
    const url = buildFetchUrl(['a', 'b'], 'abc', 'trade');
    expect(url).toBe('https://www.pathofexile.com/api/trade/fetch/a,b?query=abc');
  });

  test('trade2 fetch URL hits the trade2 API', () => {
    expect(buildFetchUrl(['a'], 'abc', 'trade2')).toBe('https://www.pathofexile.com/api/trade2/fetch/a?query=abc');
  });
});

describe('fetchListings', () => {
  const search = { realm: 'trade' as const, league: 'Allflame', searchId: 'abc' };
  // Fresh limiter per call — a 429 in one test must not poison the shared
  // process-wide limiter that other tests rely on.
  const limiter = () => new TradeRateLimiter();

  test('fills every fallback: unnamed items, no price, unknown seller, empty whisper', async () => {
    const fetchFn = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ result: [{ id: 'bare1', listing: {} }] }), { status: 200 }),
    );
    const [l] = await fetchListings(['bare1'], search, 'S', { fetchFn, limiter: limiter() });
    expect(l).toEqual({ id: 'bare1', itemName: 'bare1', referenceName: 'bare1', priceText: 'no price', price: null, listedAt: null, seller: 'unknown', whisper: '' });
  });

  test('uniques keep the display join but reference the unique name alone', async () => {
    const fetchFn = vi.fn().mockResolvedValue(
      new Response(
        JSON.stringify({ result: [{ id: 'u1', listing: {}, item: { name: 'Mageblood', typeLine: 'Heavy Belt' } }] }),
        { status: 200 },
      ),
    );
    const [l] = await fetchListings(['u1'], search, 'S', { fetchFn, limiter: limiter() });
    expect(l!.itemName).toBe('Mageblood Heavy Belt');
    // poe.ninja indexes "Mageblood" — the joined form would never match.
    expect(l!.referenceName).toBe('Mageblood');
  });

  test('currency and bases fall back to the type line for the reference name', async () => {
    const fetchFn = vi.fn().mockResolvedValue(
      new Response(
        JSON.stringify({ result: [{ id: 'c1', listing: {}, item: { name: '', typeLine: 'Divine Orb' } }] }),
        { status: 200 },
      ),
    );
    const [l] = await fetchListings(['c1'], search, 'S', { fetchFn, limiter: limiter() });
    expect(l!.referenceName).toBe('Divine Orb');
  });

  test('carries the structured price through for margin math', async () => {
    const fetchFn = vi.fn().mockResolvedValue(
      new Response(
        JSON.stringify({ result: [{ id: 'p1', listing: { indexed: '2026-08-09T11:59:00Z', price: { amount: 150, currency: 'divine' } }, item: { name: 'Mageblood' } }] }),
        { status: 200 },
      ),
    );
    const [l] = await fetchListings(['p1'], search, 'S', { fetchFn, limiter: limiter() });
    expect(l!.price).toEqual({ amount: 150, currency: 'divine' });
    expect(l!.priceText).toBe('150 divine');
    expect(l!.itemName).toBe('Mageblood');
    expect(l!.listedAt).toBe('2026-08-09T11:59:00Z');
  });

  test('surfaces a rate limit as a retryable error', async () => {
    const fetchFn = vi.fn().mockResolvedValue(new Response('slow down', { status: 429 }));
    await expect(fetchListings(['x'], search, 'S', { fetchFn, limiter: limiter() })).rejects.toThrow(/limit/i);
  });

  test('other upstream failures and malformed payloads are descriptive errors', async () => {
    const boom = vi.fn().mockResolvedValue(new Response('oops', { status: 500 }));
    await expect(fetchListings(['x'], search, 'S', { fetchFn: boom, limiter: limiter() })).rejects.toThrow(/500/);
    const weird = vi.fn().mockResolvedValue(new Response(JSON.stringify({ nope: [] }), { status: 200 }));
    await expect(fetchListings(['x'], search, 'S', { fetchFn: weird, limiter: limiter() })).rejects.toThrow(/shape/i);
  });
});

describe('handleNewListings', () => {
  const listing = (id: string, whisper: string) => ({
    id,
    listing: {
      whisper,
      price: { amount: 5, currency: 'divine' },
      account: { name: 'Seller', lastCharacterName: 'SellerChar' },
    },
    item: { name: '', typeLine: 'Mageblood' },
  });

  function deps() {
    return {
      fetchFn: vi.fn().mockImplementation(async () =>
        new Response(
          JSON.stringify({ result: [listing('id1', '@SellerChar Hi, I would like to buy your Mageblood listed for 5 divine')] }),
          { status: 200 },
        ),
      ),
      clipboard: vi.fn().mockResolvedValue(undefined),
      notify: vi.fn().mockResolvedValue(undefined),
      log: vi.fn(),
    };
  }

  test('fetches details, copies the whisper to the clipboard, and notifies', async () => {
    const d = deps();
    const results = await handleNewListings(
      ['id1'],
      { realm: 'trade', league: 'Mirage', searchId: 'abc' },
      'SESSID',
      d,
    );
    expect(results).toHaveLength(1);
    expect(results[0]!.whisper).toContain('Mageblood');
    const fetchUrl = String(d.fetchFn.mock.calls[0]![0]);
    expect(fetchUrl).toContain('/api/trade/fetch/id1?query=abc');
    const init = d.fetchFn.mock.calls[0]![1] as { headers: Record<string, string> };
    expect(init.headers['Cookie']).toContain('POESESSID=SESSID');
    expect(d.clipboard).toHaveBeenCalledWith(expect.stringContaining('Mageblood'));
    expect(d.notify).toHaveBeenCalled();
  });

  test('batches at most 10 ids per fetch call', async () => {
    const d = deps();
    const ids = Array.from({ length: 12 }, (_, i) => `id${i}`);
    await handleNewListings(ids, { realm: 'trade', league: 'Mirage', searchId: 'abc' }, 'S', d);
    expect(d.fetchFn).toHaveBeenCalledTimes(2);
    expect(String(d.fetchFn.mock.calls[0]![0])).toContain(ids.slice(0, 10).join(','));
  });

  test('explains an expired session instead of crashing', async () => {
    const d = deps();
    d.fetchFn.mockResolvedValue(new Response('unauthorized', { status: 401 }));
    await expect(
      handleNewListings(['x'], { realm: 'trade', league: 'Mirage', searchId: 'abc' }, 'BAD', d),
    ).rejects.toThrow(/POESESSID|session/i);
  });

  test('clipboard failure degrades to log, never throws', async () => {
    const d = deps();
    d.clipboard.mockRejectedValue(new Error('no pbcopy'));
    const results = await handleNewListings(['id1'], { realm: 'trade', league: 'Mirage', searchId: 'abc' }, 'S', d);
    expect(results).toHaveLength(1);
    expect(d.log).toHaveBeenCalledWith(expect.stringMatching(/clipboard/i));
  });
});
