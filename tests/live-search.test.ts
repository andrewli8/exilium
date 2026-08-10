import { describe, expect, test, vi } from 'vitest';
import { buildFetchUrl, buildLiveWsUrl, fetchCurrentResultIds, fetchListings, handleNewListings, parseFetchResponseBody, parseTradeUrl } from '../src/trade/live-search.js';
import { TradeRateLimiter } from '../src/trade/rate-limit.js';
import { TradeRequestScheduler } from '../src/trade/request-scheduler.js';

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

describe('fetchCurrentResultIds', () => {
  const poe1 = { realm: 'trade' as const, league: 'Allflame', searchId: 'saved123' };

  test('loads a saved query and submits it sorted by newest listing', async () => {
    const query = { status: { option: 'online' }, stats: [] };
    const fetchFn = vi
      .fn()
      .mockResolvedValueOnce(new Response(JSON.stringify({ id: 'saved123', query }), { status: 200 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ id: 'fresh', result: ['one', 'two'], total: 2 }), { status: 200 }));

    await expect(fetchCurrentResultIds(poe1, 'SECRET', { fetchFn, limiter: new TradeRateLimiter() }))
      .resolves.toEqual(['one', 'two']);

    expect(fetchFn).toHaveBeenNthCalledWith(1,
      'https://www.pathofexile.com/api/trade/search/Allflame/saved123',
      expect.objectContaining({ headers: expect.objectContaining({ Cookie: 'POESESSID=SECRET' }) }),
    );
    expect(fetchFn).toHaveBeenNthCalledWith(2,
      'https://www.pathofexile.com/api/trade/search/Allflame',
      expect.objectContaining({
        method: 'POST',
        body: JSON.stringify({ query, sort: { indexed: 'desc' } }),
      }),
    );
  });

  test('uses the trade2 saved-query and search endpoints', async () => {
    const fetchFn = vi
      .fn()
      .mockResolvedValueOnce(new Response(JSON.stringify({ query: { stats: [] } }), { status: 200 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ result: [] }), { status: 200 }));
    await fetchCurrentResultIds(
      { realm: 'trade2', league: 'Runes of Aldur', searchId: 'poe2saved' },
      'S',
      { fetchFn, limiter: new TradeRateLimiter() },
    );
    expect(String(fetchFn.mock.calls[0]![0])).toContain('/api/trade2/search/Runes%20of%20Aldur/poe2saved');
    expect(String(fetchFn.mock.calls[1]![0])).toContain('/api/trade2/search/Runes%20of%20Aldur');
  });

  test('explains authentication and malformed saved-search responses', async () => {
    const denied = vi.fn().mockResolvedValue(new Response('denied', { status: 403 }));
    await expect(fetchCurrentResultIds(poe1, 'BAD', { fetchFn: denied, limiter: new TradeRateLimiter() }))
      .rejects.toThrow(/POESESSID|session/i);

    const malformed = vi.fn().mockResolvedValue(new Response(JSON.stringify({ nope: true }), { status: 200 }));
    await expect(fetchCurrentResultIds(poe1, 'S', { fetchFn: malformed, limiter: new TradeRateLimiter() }))
      .rejects.toThrow(/saved search/i);
  });

  test('surfaces 429 responses with their rate-limit cooldown', async () => {
    const rateLimited = vi.fn().mockResolvedValue(new Response('slow down', {
      status: 429,
      headers: { 'Retry-After': '7' },
    }));
    await expect(fetchCurrentResultIds(poe1, 'S', { fetchFn: rateLimited, limiter: new TradeRateLimiter(() => 0) }))
      .rejects.toThrow(/limit/i);
  });

  test('waits for proactive scheduler cooldown before continuing a saved search', async () => {
    let now = 0;
    const limiter = new TradeRateLimiter(() => now);
    limiter.observe(new Response('{}', {
      headers: {
        'X-Rate-Limit-Rules': 'Account',
        'X-Rate-Limit-Account': '1:5:60',
        'X-Rate-Limit-Account-State': '1:5:0',
      },
    }));
    const waits: number[] = [];
    const scheduler = new TradeRequestScheduler({
      limiter,
      wait: async (milliseconds) => {
        waits.push(milliseconds);
        now += milliseconds;
      },
    });
    const fetchFn = vi
      .fn()
      .mockResolvedValueOnce(new Response(JSON.stringify({ query: { stats: [] } }), { status: 200 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ result: ['ready'] }), { status: 200 }));

    await expect(fetchCurrentResultIds(poe1, 'S', { fetchFn, limiter, scheduler }))
      .resolves.toEqual(['ready']);
    expect(waits).toEqual([1_000, 1_000, 1_000, 1_000, 1_000]);
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
    expect(l).toEqual({ id: 'bare1', itemName: 'bare1', referenceName: 'bare1', priceText: 'no price', price: null, listedAt: null, seller: 'unknown', whisper: '', identified: true });
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

describe('parseFetchResponseBody Valdo rewards', () => {
  const valdoResult = (extra: Record<string, unknown>) => ({
    result: [{
      id: 'valdo-1',
      listing: { price: { amount: 42, currency: 'divine' }, account: { name: 'Seller' } },
      item: { name: 'Squandered Highlands', typeLine: 'Valdo Map', ...extra },
    }],
  });

  test('prices a Valdo map by the reward item itself, de-foiled to its ninja line', () => {
    const [listing] = parseFetchResponseBody(valdoResult({
      explicitMods: ['Area is influenced by something', 'Reward: Foil Nimis'],
    }));
    expect(listing?.itemName).toBe('Foil Nimis');
    // The reward's own item price is the reference; poe.ninja has no foil
    // item lines, so "Foil Nimis" prices as "Nimis".
    expect(listing?.referenceName).toBe('Nimis');
  });

  test('reads a Reward property and strips a stack-count prefix for pricing', () => {
    const [listing] = parseFetchResponseBody(valdoResult({
      properties: [{ name: 'Reward', values: [['5x Divine Orb', 0]] }],
    }));
    expect(listing?.itemName).toBe('5x Divine Orb');
    expect(listing?.referenceName).toBe('Divine Orb');
  });

  test('parses the browser-live payload shape: structured mod objects and null result entries', () => {
    const listings = parseFetchResponseBody({
      result: [
        null,
        {
          id: 'live-1',
          listing: { price: { amount: 1, currency: 'chaos' }, account: { name: 'Seller' } },
          item: {
            name: 'Damnation Goad',
            typeLine: 'Omen Wand',
            implicitMods: [{ description: '28% increased Spell Damage', domain: 'implicit', mods: [] }],
            explicitMods: [{ description: 'Adds 9 to 16 Cold Damage', domain: 'explicit', mods: [] }],
          },
        },
      ],
    });
    expect(listings).toHaveLength(1);
    expect(listings[0]?.itemName).toBe('Damnation Goad Omen Wand');
  });

  test('extracts a reward from a structured mod object description', () => {
    const [listing] = parseFetchResponseBody(valdoResult({
      explicitMods: [{ description: 'Reward: Foil Mageblood', domain: 'explicit' }],
    }));
    expect(listing?.itemName).toBe('Foil Mageblood');
    expect(listing?.referenceName).toBe('Mageblood');
  });

  test('prices Forbidden jewels by their allocated passive variant', () => {
    const [listing] = parseFetchResponseBody({
      result: [{
        id: 'ff-1',
        listing: { price: { amount: 5, currency: 'chaos' } },
        item: {
          name: 'Forbidden Flesh',
          typeLine: 'Cobalt Jewel',
          identified: true,
          explicitMods: [{ description: "Allocates Tukohama, War's Herald if you have the matching modifier on Forbidden Flame", domain: 'explicit' }],
        },
      }],
    });
    expect(listing?.referenceName).toBe("Tukohama, War's Herald (Forbidden Flesh)");
    expect(listing?.itemName).toBe("Tukohama, War's Herald (Forbidden Flesh)");
  });

  test('foil Forbidden jewels keep the Foil prefix in the variant reference', () => {
    const [listing] = parseFetchResponseBody({
      result: [{
        id: 'ff-2',
        listing: { price: { amount: 7, currency: 'divine' } },
        item: {
          name: 'Foil Forbidden Flesh',
          identified: true,
          explicitMods: [{ description: 'Allocates Blazing Cradle if you have the matching modifier on Forbidden Flame', domain: 'explicit' }],
        },
      }],
    });
    expect(listing?.referenceName).toBe('Blazing Cradle (Foil Forbidden Flesh)');
  });

  test('labels unidentified uniques and marks them for floor pricing', () => {
    const [listing] = parseFetchResponseBody({
      result: [{
        id: 'unid-1',
        listing: { price: { amount: 9.5, currency: 'divine' } },
        item: { name: '', typeLine: 'Crimson Jewel', identified: false },
      }],
    });
    expect(listing?.itemName).toBe('Unidentified Crimson Jewel');
    expect(listing?.identified).toBe(false);
    expect(listing?.referenceName).toBe('Crimson Jewel');
  });

  test('keeps the joined item name when no reward is present', () => {
    const [listing] = parseFetchResponseBody(valdoResult({}));
    expect(listing?.itemName).toBe('Squandered Highlands Valdo Map');
    expect(listing?.referenceName).toBe('Squandered Highlands');
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
