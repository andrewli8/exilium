import { describe, expect, test, vi } from 'vitest';
import { buildFetchUrl, buildLiveWsUrl, handleNewListings, parseTradeUrl } from '../src/trade/live-search.js';

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
