import { describe, expect, test, vi } from 'vitest';
import {
  liveSearchPageUrl,
  openBrowserLiveSearch,
} from '../src/snipe/browser-live.js';
import type { CdpTravelPage, CreateCdpPageOptions } from '../src/snipe/cdp.js';
import type { LiveListing } from '../src/trade/live-search.js';

const FETCH_URL = 'https://www.pathofexile.com/api/trade/fetch/abc?query=xyz';

function fetchBody(id: string): string {
  return JSON.stringify({
    result: [{
      id,
      listing: {
        indexed: '2026-08-10T12:00:00Z',
        price: { amount: 10, currency: 'divine' },
        account: { lastCharacterName: 'Seller' },
        whisper: 'hi',
      },
      item: { name: 'Mageblood', typeLine: 'Heavy Belt' },
    }],
  });
}

function harness(nowValues: { value: number }) {
  let captured: ((url: string, body: string) => void) | undefined;
  const pageOptions: CreateCdpPageOptions[] = [];
  const goto = vi.fn(async () => undefined);
  const close = vi.fn(async () => undefined);
  const page: CdpTravelPage = {
    url: () => 'about:blank',
    goto,
    clickTravelButton: async () => 'clicked',
    close,
  };
  const createPage = async (options: CreateCdpPageOptions): Promise<CdpTravelPage> => {
    pageOptions.push(options);
    captured = options.onTradeFetchBody;
    return page;
  };
  const listings: Array<{ source: string; ids: readonly string[] }> = [];
  const logs: string[] = [];
  const open = openBrowserLiveSearch({
    cdpUrl: 'http://127.0.0.1:9222',
    search: { realm: 'trade', league: 'Allflame', searchId: 'xyz' },
    log: (message) => logs.push(message),
    onListings: (parsed: readonly LiveListing[], source) => listings.push({ source, ids: parsed.map((l) => l.id) }),
    seedWindowMs: 5_000,
    createPage,
    now: () => nowValues.value,
  });
  return { open, goto, close, listings, logs, emit: (url: string, body: string) => captured?.(url, body) };
}

describe('browser-live search', () => {
  test('builds the trade site live page URL for both realms', () => {
    expect(liveSearchPageUrl({ realm: 'trade', league: 'Allflame', searchId: 'BgzY9rR3t8' }))
      .toBe('https://www.pathofexile.com/trade/search/Allflame/BgzY9rR3t8/live');
    expect(liveSearchPageUrl({ realm: 'trade2', league: 'Standard', searchId: 'abc' }))
      .toBe('https://www.pathofexile.com/trade2/search/poe2/Standard/abc/live');
  });

  test('navigates to the live page and classifies early captures as seed, later as live', async () => {
    const clock = { value: 1_000 };
    const testHarness = harness(clock);
    await testHarness.open;
    expect(testHarness.goto).toHaveBeenCalledWith('https://www.pathofexile.com/trade/search/Allflame/xyz/live');

    clock.value = 3_000; // within the 5s seed window
    testHarness.emit(FETCH_URL, fetchBody('early'));
    clock.value = 9_000; // past the window
    testHarness.emit(FETCH_URL, fetchBody('late'));

    expect(testHarness.listings).toEqual([
      { source: 'seed', ids: ['early'] },
      { source: 'live', ids: ['late'] },
    ]);
  });

  test('logs and skips a payload that does not parse', async () => {
    const clock = { value: 0 };
    const testHarness = harness(clock);
    await testHarness.open;
    testHarness.emit(FETCH_URL, 'not json');
    testHarness.emit(FETCH_URL, '{"unexpected":true}');
    expect(testHarness.listings).toEqual([]);
    expect(testHarness.logs.filter((line) => /browser-live/.test(line))).toHaveLength(2);
  });

  test('close closes the owned page', async () => {
    const clock = { value: 0 };
    const testHarness = harness(clock);
    const handle = await testHarness.open;
    await handle.close();
    expect(testHarness.close).toHaveBeenCalledTimes(1);
  });
});
