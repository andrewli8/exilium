import { describe, expect, test, vi } from 'vitest';
import type { SnipeAlert } from '../src/snipe/engine.js';
import { dispatchTravel, resolveTravelMode, rowSelector, travelSelectedAlert, type TravelPage } from '../src/snipe/travel.js';

const ALERT: SnipeAlert = {
  targetLabel: 'MB',
  listingId: 'abc123',
  itemName: 'Mageblood',
  priceText: '150 divine',
  seller: 'Seller',
  whisper: '@Seller hi',
  searchUrl: 'https://www.pathofexile.com/trade/search/Allflame/AbC123',
  listedChaos: 30_000,
  marginChaos: 10_000,
  marginPct: 25,
  marginText: '+10,000c (+25.0%)',
  freshnessText: 'ref 4m ago',
  stale: false,
  unknownMargin: false,
};

describe('resolveTravelMode', () => {
  test('defaults to ping only', () => {
    expect(resolveTravelMode({ modeFlag: undefined, autoTravelFlag: false, configuredMode: undefined, acknowledged: false })).toEqual({ mode: 'ping' });
  });

  test('auto requires the CLI flag AND the config acknowledgment', () => {
    expect(() =>
      resolveTravelMode({ modeFlag: 'auto', autoTravelFlag: false, configuredMode: undefined, acknowledged: false }),
    ).toThrow(/autoTravelAcknowledged/);
    const resolved = resolveTravelMode({ modeFlag: undefined, autoTravelFlag: true, configuredMode: undefined, acknowledged: true });
    expect(resolved.mode).toBe('auto');
    expect(resolved.warning).toMatch(/GGG|automation/i);
  });

  test('config/env auto without a CLI flag downgrades to ping with a warning', () => {
    const resolved = resolveTravelMode({ modeFlag: undefined, autoTravelFlag: false, configuredMode: 'auto', acknowledged: true });
    expect(resolved.mode).toBe('ping');
    expect(resolved.warning).toMatch(/--auto-travel/);
  });

  test('config/env auto without acknowledgment also downgrades — never crashes the session', () => {
    const resolved = resolveTravelMode({ modeFlag: undefined, autoTravelFlag: false, configuredMode: 'auto', acknowledged: false });
    expect(resolved.mode).toBe('ping');
    expect(resolved.warning).toMatch(/--auto-travel/);
  });

  test('unknown mode values are rejected', () => {
    expect(() =>
      resolveTravelMode({ modeFlag: 'yolo', autoTravelFlag: false, configuredMode: undefined, acknowledged: false }),
    ).toThrow(/ping|auto/);
  });
});

describe('rowSelector', () => {
  test('targets the listing row by data-id, quoted', () => {
    expect(rowSelector('abc"123')).toBe('[data-id="abc\\"123"]');
  });
});

describe('dispatchTravel', () => {
  function fakePage(clickResult: boolean | Error): TravelPage & { gotos: string[]; clicks: string[] } {
    const state = { current: '' };
    const gotos: string[] = [];
    const clicks: string[] = [];
    return {
      gotos,
      clicks,
      url: () => state.current,
      goto: async (u: string) => {
        state.current = u;
        gotos.push(u);
      },
      clickTravelButton: async (listingId: string) => {
        clicks.push(listingId);
        if (clickResult instanceof Error) throw clickResult;
        return clickResult;
      },
    };
  }

  test('ping mode opens the search page only when asked', async () => {
    const open = vi.fn(async () => {});
    expect(await dispatchTravel(ALERT, { mode: 'ping', openSearchPage: false, openUrl: open })).toEqual({
      action: 'ping',
      detail: 'whisper copied — paste in game, or click Travel to Hideout on the trade site yourself',
    });
    expect(open).not.toHaveBeenCalled();
    const opened = await dispatchTravel(ALERT, { mode: 'ping', openSearchPage: true, openUrl: open });
    expect(opened.action).toBe('ping');
    expect(open).toHaveBeenCalledWith(ALERT.searchUrl);
  });

  test('auto mode navigates once and clicks the listing row button', async () => {
    const page = fakePage(true);
    const result = await dispatchTravel(ALERT, { mode: 'auto', openSearchPage: false, openUrl: async () => {}, page });
    expect(result.action).toBe('auto-traveled');
    expect(page.gotos).toEqual([ALERT.searchUrl]);
    expect(page.clicks).toEqual(['abc123']);
    const again = await dispatchTravel(ALERT, { mode: 'auto', openSearchPage: false, openUrl: async () => {}, page });
    expect(again.action).toBe('auto-traveled');
    expect(page.gotos).toHaveLength(1);
  });

  test('auto mode degrades to ping when the button is missing or the click throws', async () => {
    const missing = await dispatchTravel(ALERT, { mode: 'auto', openSearchPage: false, openUrl: async () => {}, page: fakePage(false) });
    expect(missing.action).toBe('auto-failed');
    expect(missing.detail).toMatch(/whisper/i);
    const threw = await dispatchTravel(ALERT, { mode: 'auto', openSearchPage: false, openUrl: async () => {}, page: fakePage(new Error('browser gone')) });
    expect(threw.action).toBe('auto-failed');
    expect(threw.detail).toContain('browser gone');
  });

  test('auto mode without a page reports the missing browser and still pings', async () => {
    const result = await dispatchTravel(ALERT, { mode: 'auto', openSearchPage: false, openUrl: async () => {} });
    expect(result.action).toBe('auto-failed');
    expect(result.detail).toMatch(/browser/i);
  });
});

describe('travelSelectedAlert', () => {
  function manualPage(clickResult: boolean | Error): TravelPage & { gotos: string[]; clicks: string[] } {
    const gotos: string[] = [];
    const clicks: string[] = [];
    let current = '';
    return {
      gotos,
      clicks,
      url: () => current,
      goto: async (url) => {
        current = url;
        gotos.push(url);
      },
      clickTravelButton: async (listingId) => {
        clicks.push(listingId);
        if (clickResult instanceof Error) throw clickResult;
        return clickResult;
      },
    };
  }

  test('one explicit manual action navigates and clicks without whisper fallback text', async () => {
    const page = manualPage(true);
    const result = await travelSelectedAlert(ALERT, page);
    expect(result).toEqual({
      action: 'traveled',
      detail: 'clicked Travel to Hideout for Mageblood',
    });
    expect(result.detail).not.toMatch(/whisper|paste/i);
    expect(page.gotos).toEqual([ALERT.searchUrl]);
    expect(page.clicks).toEqual([ALERT.listingId]);
  });

  test('a missing listing or browser error fails without claiming travel', async () => {
    const missing = await travelSelectedAlert(ALERT, manualPage(false));
    expect(missing.action).toBe('failed');
    expect(missing.detail).toMatch(/not found|listing/i);
    expect(missing.detail).not.toMatch(/whisper|paste/i);

    const errored = await travelSelectedAlert(ALERT, manualPage(new Error('browser disconnected')));
    expect(errored).toEqual({ action: 'failed', detail: 'browser disconnected' });
  });
});
