import type { Game } from '../domain/types.js';

/** Deep link to the official trade site prefilled for an item. The trade
 * site accepts a URL-encoded JSON query in ?q= — no session required to view.
 *
 * Defaults encode what a trader actually wants to see:
 * - PoE2: status "available" — the site's "Instant Buyout and In Person"
 *   mode, covering both purchase routes (verified against Exiled Exchange
 *   2's mapping: available = both, securable = instant only, online =
 *   in-person only).
 * - PoE1 (no instant buyout exists): online sellers with priced listings,
 *   skipping unpriced clutter. */
export function buildTradeSearchUrl(game: Game, league: string, itemName: string): string {
  const query =
    game === 'poe2'
      ? { query: { type: itemName, status: { option: 'available' } } }
      : {
          query: {
            type: itemName,
            status: { option: 'online' },
            filters: { trade_filters: { filters: { sale_type: { option: 'priced' } } } },
          },
        };
  const q = encodeURIComponent(JSON.stringify(query));
  const base =
    game === 'poe2'
      ? `https://www.pathofexile.com/trade2/search/poe2/${encodeURIComponent(league)}`
      : `https://www.pathofexile.com/trade/search/${encodeURIComponent(league)}`;
  return `${base}?q=${q}`;
}
