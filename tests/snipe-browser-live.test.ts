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
  const goto = vi.fn(async (_url: string) => undefined);
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
    seedCaptureWaitMs: 0,
    seedSettleMs: 0,
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

  test('seeds from the plain search page, then goes live and classifies captures', async () => {
    const clock = { value: 1_000 };
    const testHarness = harness(clock);
    await testHarness.open;
    // Plain page first (its auto-run search delivers current results), then /live.
    expect(testHarness.goto.mock.calls.map((call) => call[0])).toEqual([
      'https://www.pathofexile.com/trade/search/Allflame/xyz',
      'https://www.pathofexile.com/trade/search/Allflame/xyz/live',
    ]);

    clock.value = 3_000; // within the 5s post-live seed window
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

  test('captures on the plain page are always seeds, even after a long load', async () => {
    const clock = { value: 1_000 };
    let captured: ((url: string, body: string) => void) | undefined;
    const listings: Array<{ source: string; ids: readonly string[] }> = [];
    let releaseLiveNav: () => void = () => undefined;
    const liveNavGate = new Promise<void>((resolve) => { releaseLiveNav = resolve; });
    const open = openBrowserLiveSearch({
      cdpUrl: 'http://127.0.0.1:9222',
      search: { realm: 'trade', league: 'Allflame', searchId: 'xyz' },
      log: () => undefined,
      onListings: (parsed, source) => listings.push({ source, ids: parsed.map((l) => l.id) }),
      seedWindowMs: 5_000,
      seedCaptureWaitMs: 60_000,
      seedSettleMs: 0,
      createPage: async (options) => {
        captured = options.onTradeFetchBody;
        return {
          url: () => 'about:blank',
          goto: async (url: string) => { if (url.endsWith('/live')) await liveNavGate; },
          clickTravelButton: async () => 'clicked',
          close: async () => undefined,
        };
      },
      now: () => clock.value,
    });
    await new Promise((resolve) => setTimeout(resolve, 0));
    clock.value = 45_000; // still on the plain page, long after any fixed window
    captured?.(FETCH_URL, fetchBody('current'));
    expect(listings).toEqual([{ source: 'seed', ids: ['current'] }]);
    releaseLiveNav();
    const handle = await open;
    clock.value = 70_000; // past the post-live seed window
    captured?.(FETCH_URL, fetchBody('fresh'));
    expect(listings.at(-1)).toEqual({ source: 'live', ids: ['fresh'] });
    await handle.close();
  });

  test('close closes the owned page', async () => {
    const clock = { value: 0 };
    const testHarness = harness(clock);
    const handle = await testHarness.open;
    await handle.close();
    expect(testHarness.close).toHaveBeenCalledTimes(1);
  });
});
