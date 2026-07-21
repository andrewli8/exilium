import { z } from 'zod';
import type { Game } from '../domain/types.js';
import type { ParsedItem } from './parse-item.js';
import { matchMod, type StatIndex } from './trade-stats.js';

/** Build a trade.pathofexile.com query from a parsed item. Uniques search by
 * name; rares/magic/normal by base type plus item level, links, corruption,
 * and every mod we could map to a stat filter. The same payload drives both
 * the API search (for prices) and the ?q= deep link (for the human to open). */

export interface TradePayload {
  readonly query: Record<string, unknown> & { readonly stats: { type: string; filters: unknown[] }[] };
  readonly sort: { readonly price: 'asc' };
}

const NAME_ONLY: ReadonlySet<string> = new Set(['Currency', 'Gem', 'Divination Card']);

export function buildTradeQuery(item: ParsedItem, index: StatIndex, game: Game): TradePayload {
  const status = { option: game === 'poe2' ? 'available' : 'online' };
  const statFilters =
    item.rarity === 'Rare' || item.rarity === 'Magic' || item.rarity === 'Normal'
      ? item.mods.map((m) => matchMod(m, index)).filter((f): f is NonNullable<typeof f> => f !== null)
      : [];

  const query: TradePayload['query'] = {
    status,
    stats: [{ type: 'and', filters: statFilters }],
    filters: {
      trade_filters: { filters: { sale_type: { option: 'priced' } } },
    },
  };

  if (item.rarity === 'Unique') {
    query['name'] = item.name;
    if (item.baseType !== undefined) query['type'] = item.baseType;
  } else if (NAME_ONLY.has(item.rarity)) {
    query['type'] = item.name;
  } else {
    // Rare / Magic / Normal: search the base with the item's characteristics.
    if (item.baseType !== undefined) query['type'] = item.baseType;
    const misc: Record<string, unknown> = {};
    if (item.itemLevel !== undefined) misc['ilvl'] = { min: item.itemLevel };
    if (item.corrupted) misc['corrupted'] = { option: 'true' };
    (query['filters'] as Record<string, unknown>)['misc_filters'] = { filters: misc };
    if (item.links !== undefined && item.links >= 5) {
      (query['filters'] as Record<string, unknown>)['socket_filters'] = { filters: { links: { min: item.links } } };
    }
  }

  return { query, sort: { price: 'asc' } };
}

export function tradeUrlFor(payload: TradePayload, game: Game, league: string): string {
  const base =
    game === 'poe2'
      ? `https://www.pathofexile.com/trade2/search/poe2/${encodeURIComponent(league)}`
      : `https://www.pathofexile.com/trade/search/${encodeURIComponent(league)}`;
  return `${base}?q=${encodeURIComponent(JSON.stringify(payload))}`;
}

// ---------------------------------------------------------------------------
// Live search: POST the query, fetch the first listings, extract prices.
// ---------------------------------------------------------------------------

const searchSchema = z.object({ id: z.string(), result: z.array(z.string()) });
const fetchSchema = z.object({
  result: z.array(
    z.object({
      listing: z.object({
        price: z.object({ amount: z.number(), currency: z.string() }).nullish(),
        account: z.object({ name: z.string().optional(), lastCharacterName: z.string().optional() }).optional(),
        whisper: z.string().optional(),
      }),
      item: z.object({ name: z.string().optional(), typeLine: z.string().optional() }).optional(),
    }),
  ),
});

export interface PricedListing {
  readonly amount: number;
  readonly currency: string;
  readonly seller: string;
  readonly whisper: string;
}

export interface PriceCheckDeps {
  readonly fetchFn: (url: string, init: { method?: string; headers: Record<string, string>; body?: string }) => Promise<Response>;
  readonly sessionId: string;
}

/** Run the search and return up to `limit` cheapest priced listings. */
export async function searchListings(
  payload: TradePayload,
  game: Game,
  league: string,
  limit: number,
  deps: PriceCheckDeps,
): Promise<readonly PricedListing[]> {
  const api = game === 'poe2' ? 'trade2' : 'trade';
  const headers = {
    Cookie: `POESESSID=${deps.sessionId}`,
    'User-Agent': 'Exilium/0.1.0 (+https://github.com/andrewli8/exilium)',
    'Content-Type': 'application/json',
  };
  const searchRes = await deps.fetchFn(`https://www.pathofexile.com/api/${api}/search/${encodeURIComponent(league)}`, {
    method: 'POST',
    headers,
    body: JSON.stringify(payload),
  });
  if (searchRes.status === 401 || searchRes.status === 403) {
    throw new Error('pathofexile.com rejected the search — your POESESSID is missing or expired. Refresh it and retry.');
  }
  if (searchRes.status === 429) throw new Error('pathofexile.com rate-limited the search — wait a minute and retry.');
  if (!searchRes.ok) throw new Error(`trade search failed (${searchRes.status})`);
  const search = searchSchema.safeParse(await searchRes.json());
  if (!search.success) throw new Error('trade search response did not match the expected shape');
  const ids = search.data.result.slice(0, limit);
  if (ids.length === 0) return [];

  const fetchRes = await deps.fetchFn(
    `https://www.pathofexile.com/api/${api}/fetch/${ids.join(',')}?query=${search.data.id}`,
    { headers },
  );
  if (!fetchRes.ok) throw new Error(`trade fetch failed (${fetchRes.status})`);
  const parsed = fetchSchema.safeParse(await fetchRes.json());
  if (!parsed.success) throw new Error('trade fetch response did not match the expected shape');
  return parsed.data.result
    .filter((r) => r.listing.price != null)
    .map((r) => ({
      amount: r.listing.price!.amount,
      currency: r.listing.price!.currency,
      seller: r.listing.account?.lastCharacterName ?? r.listing.account?.name ?? 'unknown',
      whisper: r.listing.whisper ?? '',
    }));
}
