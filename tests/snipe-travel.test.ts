import { describe, expect, test } from 'vitest';
import type { SnipeAlert } from '../src/snipe/engine.js';
import { rowSelector, travelSelectedAlert, type TravelPage } from '../src/snipe/travel.js';

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

describe('rowSelector', () => {
  test('targets the listing row by data-id, quoted', () => {
    expect(rowSelector('abc"123')).toBe('[data-id="abc\\"123"]');
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
