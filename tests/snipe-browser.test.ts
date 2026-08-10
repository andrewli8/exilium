import { describe, expect, test } from 'vitest';
import type { CdpTravelPage } from '../src/snipe/cdp.js';
import type { SnipeAlert } from '../src/snipe/engine.js';
import { createTravelController } from '../src/snipe/browser.js';

function alert(id: string): SnipeAlert {
  return {
    targetId: `trade:${id}`,
    targetLabel: `Target ${id}`,
    source: 'live',
    listingId: id,
    itemName: `Item ${id}`,
    priceText: '10 divine',
    seller: `Seller ${id}`,
    listedAt: null,
    searchUrl: `https://www.pathofexile.com/trade/search/Allflame/${id}`,
    listedChaos: 2_000,
    marginChaos: 500,
    marginPct: 25,
    marginText: '+500c (+25.0%)',
    freshnessText: 'ref 1m ago',
    stale: false,
    unknownMargin: false,
    minMarginPct: 20,
    targetMinMarginPct: null,
    qualifiesMargin: true,
  };
}

function fakePage() {
  let currentUrl = '';
  let blocked = false;
  let release: (() => void) | undefined;
  const state = {
    gotoUrls: [] as string[],
    clickedIds: [] as string[],
    closeCalls: 0,
    blockNextGoto() {
      blocked = true;
    },
    releaseGoto() {
      release?.();
    },
  };
  const page: CdpTravelPage = {
    url: () => currentUrl,
    goto: async (url) => {
      state.gotoUrls.push(url);
      if (blocked) {
        blocked = false;
        await new Promise<void>((resolve) => { release = resolve; });
      }
      currentUrl = url;
    },
    clickTravelButton: async (listingId) => {
      state.clickedIds.push(listingId);
      return 'clicked';
    },
    close: async () => {
      state.closeCalls += 1;
      release?.();
    },
  };
  return { page, state };
}

describe('createTravelController', () => {
  test('creates one direct-CDP page and reuses it for native search actions', async () => {
    const fake = fakePage();
    let createCalls = 0;
    const controller = await createTravelController({
      cdpUrl: 'http://127.0.0.1:9222',
      profileDir: 'unused',
      log: () => undefined,
      createPage: async () => {
        createCalls += 1;
        return fake.page;
      },
    });
    await controller.openSearch('https://www.pathofexile.com/trade/search/Allflame/selected');
    expect(await controller.travel(alert('one'))).toMatchObject({ action: 'traveled' });
    expect(await controller.travel(alert('two'))).toMatchObject({ action: 'traveled' });
    expect(createCalls).toBe(1);
    expect(fake.state.gotoUrls).toEqual([
      'https://www.pathofexile.com/trade/search/Allflame/selected',
      alert('one').searchUrl,
      alert('two').searchUrl,
    ]);
    expect(fake.state.clickedIds).toEqual(['one', 'two']);
  });

  test('serializes rapid travel requests so native page navigation cannot race', async () => {
    const fake = fakePage();
    const controller = await createTravelController({
      cdpUrl: 'http://127.0.0.1:9222',
      profileDir: 'unused',
      log: () => undefined,
      createPage: async () => fake.page,
    });
    fake.state.blockNextGoto();
    const first = controller.travel(alert('one'));
    const second = controller.travel(alert('two'));
    await Promise.resolve();
    await Promise.resolve();
    expect(fake.state.gotoUrls).toEqual([alert('one').searchUrl]);
    fake.state.releaseGoto();
    await Promise.all([first, second]);
    expect(fake.state.gotoUrls).toEqual([alert('one').searchUrl, alert('two').searchUrl]);
  });

  test('close bypasses a stalled navigation and closes only the owned page', async () => {
    const fake = fakePage();
    const controller = await createTravelController({
      cdpUrl: 'http://127.0.0.1:9222',
      profileDir: 'unused',
      log: () => undefined,
      createPage: async () => fake.page,
    });
    fake.state.blockNextGoto();
    const traveling = controller.travel(alert('one'));
    await Promise.resolve();
    await Promise.resolve();
    await controller.close();
    expect(fake.state.closeCalls).toBe(1);
    await traveling;
  });

  test('direct CDP creation failure does not launch another browser profile', async () => {
    let attempts = 0;
    await expect(createTravelController({
      cdpUrl: 'http://127.0.0.1:9222',
      profileDir: 'unused',
      log: () => undefined,
      createPage: async () => {
        attempts += 1;
        throw new Error('not listening');
      },
    })).rejects.toThrow(/not listening/i);
    expect(attempts).toBe(1);
  });
});
