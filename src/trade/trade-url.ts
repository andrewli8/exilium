import type { Game } from '../domain/types.js';

/** Strip Exilium's display variant suffix — "(lvl 5, corrupt)", "(6L)",
 * "(5 Flasks)" — so the value matches what the trade site indexes. */
function baseName(displayName: string): string {
  return displayName.replace(/\s*\([^)]*\)\s*$/, '').trim();
}

/** Deep link to the official trade site prefilled for an item. The trade
 * site accepts a URL-encoded JSON query in ?q= — no session required to view.
 *
 * Field choice matters: uniques are matched by `name` (the unique's name),
 * everything else by `type` (the base/gem/currency name). Sending a display
 * name with a variant suffix into either field finds nothing, which is the
 * bug this fixes.
 *
 * Status defaults to "available" for both games — the trade site's "Instant
 * Buyout and In Person", i.e. priced listings ready to buy right now. */
export function buildTradeSearchUrl(game: Game, league: string, itemName: string, category?: string): string {
  const clean = baseName(itemName);
  const isUnique = category !== undefined && category.startsWith('Unique');
  const identity = isUnique ? { name: clean } : { type: clean };

  const query = {
    query: {
      ...identity,
      // "available" is the trade site's "Instant Buyout and In Person".
      status: { option: 'available' },
    },
  };
  const q = encodeURIComponent(JSON.stringify(query));
  const base =
    game === 'poe2'
      ? `https://www.pathofexile.com/trade2/search/poe2/${encodeURIComponent(league)}`
      : `https://www.pathofexile.com/trade/search/${encodeURIComponent(league)}`;
  return `${base}?q=${q}`;
}
