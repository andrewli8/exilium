import type { Game } from '../domain/types.js';

/** Deep link to the official trade site prefilled for an item. The trade
 * site accepts a URL-encoded JSON query in ?q= — no session required to view. */
export function buildTradeSearchUrl(game: Game, league: string, itemName: string): string {
  const q = encodeURIComponent(JSON.stringify({ query: { type: itemName } }));
  const base =
    game === 'poe2'
      ? `https://www.pathofexile.com/trade2/search/poe2/${encodeURIComponent(league)}`
      : `https://www.pathofexile.com/trade/search/${encodeURIComponent(league)}`;
  return `${base}?q=${q}`;
}
