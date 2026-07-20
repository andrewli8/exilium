import { describe, expect, test } from 'vitest';
import { buildTradeSearchUrl } from '../src/trade/trade-url.js';

describe('buildTradeSearchUrl', () => {
  test('builds a PoE1 trade search prefilled with the item type', () => {
    const url = buildTradeSearchUrl('poe1', 'Mirage', 'Divine Orb');
    expect(url).toContain('https://www.pathofexile.com/trade/search/Mirage?q=');
    const q = JSON.parse(decodeURIComponent(url.split('?q=')[1]!));
    expect(q).toEqual({ query: { type: 'Divine Orb' } });
  });

  test('uses the trade2 route for poe2 and encodes league names', () => {
    const url = buildTradeSearchUrl('poe2', 'Runes of Aldur', 'Exalted Orb');
    expect(url).toContain('/trade2/search/poe2/Runes%20of%20Aldur?q=');
  });
});
