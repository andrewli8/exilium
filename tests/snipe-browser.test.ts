import { describe, expect, test } from 'vitest';
import type { SnipeAlert } from '../src/snipe/engine.js';
import { createTravelController } from '../src/snipe/browser.js';

function alert(id: string): SnipeAlert {
  return {
    targetLabel: `Target ${id}`,
    listingId: id,
    itemName: `Item ${id}`,
    priceText: '10 divine',
    seller: `Seller ${id}`,
    whisper: `@Seller ${id} hi`,
    searchUrl: `https://www.pathofexile.com/trade/search/Allflame/${id}`,
    listedChaos: 2_000,
    marginChaos: 500,
    marginPct: 25,
    marginText: '+500c (+25.0%)',
    freshnessText: 'ref 1m ago',
    stale: false,
    unknownMargin: false,
  };
}

interface FakeOptions {
  readonly cdpError?: Error;
  readonly persistentExistingPage?: boolean;
  readonly waitFailures?: number;
}

function fakePlaywright(options: FakeOptions = {}) {
  let currentUrl = '';
  let remainingWaitFailures = options.waitFailures ?? 0;
  let releaseFirstGoto: (() => void) | undefined;
  let blockFirstGoto = false;
  const state = {
    newPageCalls: 0,
    browserCloseCalls: 0,
    contextCloseCalls: 0,
    pageCloseCalls: 0,
    reloadCalls: 0,
    gotoUrls: [] as string[],
    clickSelectors: [] as string[],
    chromeProcessAlive: true,
    blockNextGoto() {
      blockFirstGoto = true;
      return new Promise<void>((resolve) => { releaseFirstGoto = resolve; });
    },
    releaseGoto() {
      releaseFirstGoto?.();
    },
  };
  const page = {
    url: () => currentUrl,
    goto: async (url: string) => {
      state.gotoUrls.push(url);
      if (blockFirstGoto) {
        blockFirstGoto = false;
        await new Promise<void>((resolve) => { releaseFirstGoto = resolve; });
      }
      currentUrl = url;
    },
    reload: async () => { state.reloadCalls += 1; },
    waitForSelector: async () => {
      if (remainingWaitFailures > 0) {
        remainingWaitFailures -= 1;
        throw new Error('not indexed');
      }
    },
    locator: (selector: string) => ({
      count: async () => 1,
      first: () => ({
        click: async () => { state.clickSelectors.push(selector); },
      }),
    }),
    close: async () => { state.pageCloseCalls += 1; },
  };
  const context = {
    pages: () => options.persistentExistingPage ? [page] : [],
    newPage: async () => {
      state.newPageCalls += 1;
      return page;
    },
    close: async () => { state.contextCloseCalls += 1; },
  };
  const browser = {
    contexts: () => [context],
    close: async () => { state.browserCloseCalls += 1; },
  };
  const playwright = {
    chromium: {
      connectOverCDP: async () => {
        if (options.cdpError !== undefined) throw options.cdpError;
        return browser;
      },
      launchPersistentContext: async () => context,
    },
  };
  return { playwright, state };
}

describe('createTravelController', () => {
  test('CDP creates one owned page and reuses it for multiple manual actions', async () => {
    const fake = fakePlaywright();
    const controller = await createTravelController({
      cdpUrl: 'http://127.0.0.1:9222',
      profileDir: 'C:\\profile',
      log: () => undefined,
      loadPlaywright: async () => fake.playwright,
    });
    expect(await controller.travel(alert('one'))).toMatchObject({ action: 'traveled' });
    expect(await controller.travel(alert('two'))).toMatchObject({ action: 'traveled' });
    expect(fake.state.newPageCalls).toBe(1);
    expect(fake.state.gotoUrls).toEqual([alert('one').searchUrl, alert('two').searchUrl]);
    expect(fake.state.clickSelectors).toHaveLength(2);
  });

  test('serializes rapid travel requests so page navigation cannot race', async () => {
    const fake = fakePlaywright();
    const controller = await createTravelController({
      cdpUrl: 'http://127.0.0.1:9222',
      profileDir: 'C:\\profile',
      log: () => undefined,
      loadPlaywright: async () => fake.playwright,
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

  test('reloads once for indexing lag but clicks exactly once', async () => {
    const fake = fakePlaywright({ waitFailures: 1 });
    const controller = await createTravelController({
      cdpUrl: 'http://127.0.0.1:9222',
      profileDir: 'C:\\profile',
      log: () => undefined,
      loadPlaywright: async () => fake.playwright,
    });
    expect(await controller.travel(alert('one'))).toMatchObject({ action: 'traveled' });
    expect(fake.state.reloadCalls).toBe(1);
    expect(fake.state.clickSelectors).toHaveLength(1);
  });

  test('closing an attached controller closes its page and disconnects without terminating Chrome', async () => {
    const fake = fakePlaywright();
    const controller = await createTravelController({
      cdpUrl: 'http://127.0.0.1:9222',
      profileDir: 'C:\\profile',
      log: () => undefined,
      loadPlaywright: async () => fake.playwright,
    });
    await controller.close();
    expect(fake.state.pageCloseCalls).toBe(1);
    expect(fake.state.browserCloseCalls).toBe(1);
    expect(fake.state.contextCloseCalls).toBe(0);
    expect(fake.state.chromeProcessAlive).toBe(true);
  });

  test('persistent fallback reuses its first page and closes only its owned context', async () => {
    const fake = fakePlaywright({ cdpError: new Error('not listening'), persistentExistingPage: true });
    const logs: string[] = [];
    const controller = await createTravelController({
      cdpUrl: 'http://127.0.0.1:9222',
      profileDir: 'C:\\profile',
      log: (message) => logs.push(message),
      loadPlaywright: async () => fake.playwright,
    });
    await controller.travel(alert('one'));
    await controller.close();
    expect(fake.state.newPageCalls).toBe(0);
    expect(fake.state.contextCloseCalls).toBe(1);
    expect(fake.state.browserCloseCalls).toBe(0);
    expect(logs.join(' ')).toMatch(/falling back/i);
  });
});
