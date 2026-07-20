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
 * Defaults: PoE2 uses status "available" ("Instant Buyout and In Person");
 * PoE1 (no instant buyout) uses online sellers with priced listings. */
export function buildTradeSearchUrl(game: Game, league: string, itemName: string, category?: string): string {
  const clean = baseName(itemName);
  const isUnique = category !== undefined && category.startsWith('Unique');
  const identity = isUnique ? { name: clean } : { type: clean };

  const query =
    game === 'poe2'
      ? { query: { ...identity, status: { option: 'available' } } }
      : {
          query: {
            ...identity,
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
