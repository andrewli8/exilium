import { describe, expect, test } from 'vitest';
import { buildTradeSearchUrl } from '../src/trade/trade-url.js';

describe('buildTradeSearchUrl', () => {
  test('PoE1 searches default to online sellers with priced (buyout) listings', () => {
    const url = buildTradeSearchUrl('poe1', 'Mirage', 'Divine Orb');
    expect(url).toContain('https://www.pathofexile.com/trade/search/Mirage?q=');
    const q = JSON.parse(decodeURIComponent(url.split('?q=')[1]!));
    expect(q).toEqual({
      query: {
        type: 'Divine Orb',
        status: { option: 'online' },
        filters: { trade_filters: { filters: { sale_type: { option: 'priced' } } } },
      },
    });
  });

  test('PoE2 searches default to "Instant Buyout and In Person" (status: available)', () => {
    const url = buildTradeSearchUrl('poe2', 'Runes of Aldur', 'Exalted Orb');
    expect(url).toContain('/trade2/search/poe2/Runes%20of%20Aldur?q=');
    const q = JSON.parse(decodeURIComponent(url.split('?q=')[1]!));
    expect(q).toEqual({
      query: {
        type: 'Exalted Orb',
        status: { option: 'available' },
      },
    });
  });
});
