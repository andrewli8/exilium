import { z } from 'zod';

/** Live trade-search monitoring against pathofexile.com, using the user's own
 * session, on the user's own machine. The session cookie goes to
 * pathofexile.com and nowhere else. Whispers are copied to the clipboard for
 * the human to paste in game — never sent automatically (GGG's automation
 * line, and ours). */

export interface TradeSearch {
  /** 'trade' (PoE1) or 'trade2' (PoE2). */
  readonly realm: 'trade' | 'trade2';
  readonly league: string;
  readonly searchId: string;
}

const URL_PATTERN = /pathofexile\.com\/(trade2?)\/search\/(?:poe2\/)?([^/]+)\/([A-Za-z0-9]+)/;

export function parseTradeUrl(url: string): TradeSearch {
  const match = URL_PATTERN.exec(url);
  if (match === null) {
    throw new Error(
      `Not a trade search URL: "${url}". Expected something like https://www.pathofexile.com/trade/search/<league>/<id> — copy it from your browser's address bar.`,
    );
  }
  return {
    realm: match[1] as 'trade' | 'trade2',
    league: decodeURIComponent(match[2]!),
    searchId: match[3]!,
  };
}

export function buildLiveWsUrl(search: TradeSearch): string {
  const base = search.realm === 'trade2' ? 'api/trade2/live/poe2' : 'api/trade/live';
  return `wss://www.pathofexile.com/${base}/${encodeURIComponent(search.league)}/${search.searchId}`;
}

export function buildFetchUrl(ids: readonly string[], searchId: string, realm: TradeSearch['realm']): string {
  const api = realm === 'trade2' ? 'trade2' : 'trade';
  return `https://www.pathofexile.com/api/${api}/fetch/${ids.join(',')}?query=${searchId}`;
}

const fetchResponseSchema = z.object({
  result: z.array(
    z.object({
      id: z.string(),
      listing: z.object({
        whisper: z.string().optional(),
        price: z.object({ amount: z.number(), currency: z.string() }).nullish(),
        account: z.object({ name: z.string().optional(), lastCharacterName: z.string().optional() }).optional(),
      }),
      item: z.object({ name: z.string().optional(), typeLine: z.string().optional() }).optional(),
    }),
  ),
});

export interface LiveListing {
  readonly id: string;
  readonly itemName: string;
  readonly priceText: string;
  readonly seller: string;
  readonly whisper: string;
}

export interface LiveDeps {
  readonly fetchFn: (url: string, init: { headers: Record<string, string> }) => Promise<Response>;
  /** Copies text for the user to paste in game. */
  readonly clipboard: (text: string) => Promise<void>;
  readonly notify: (title: string, message: string) => Promise<void>;
  readonly log: (message: string) => void;
}

const FETCH_BATCH = 10;

/** Resolve new listing ids from a live search into whisper-ready listings.
 * Copies the newest whisper to the clipboard and sends one notification. */
export async function handleNewListings(
  ids: readonly string[],
  search: TradeSearch,
  sessionId: string,
  deps: LiveDeps,
): Promise<readonly LiveListing[]> {
  const listings: LiveListing[] = [];
  for (let i = 0; i < ids.length; i += FETCH_BATCH) {
    const batch = ids.slice(i, i + FETCH_BATCH);
    const res = await deps.fetchFn(buildFetchUrl(batch, search.searchId, search.realm), {
      headers: {
        Cookie: `POESESSID=${sessionId}`,
        'User-Agent': 'Exilium/0.1.0 (+https://github.com/andrewli8/exilium)',
      },
    });
    if (res.status === 401 || res.status === 403) {
      throw new Error('pathofexile.com rejected the session — your POESESSID is missing or expired. Log into the trade site in a browser and copy the fresh cookie into EXILIUM_POESESSID.');
    }
    if (!res.ok) throw new Error(`trade fetch failed (${res.status})`);
    const parsed = fetchResponseSchema.safeParse(await res.json());
    if (!parsed.success) throw new Error('trade fetch response did not match the expected shape');
    for (const r of parsed.data.result) {
      const name = [r.item?.name, r.item?.typeLine].filter((s) => s !== undefined && s !== '').join(' ') || r.id;
      const price = r.listing.price == null ? 'no price' : `${r.listing.price.amount} ${r.listing.price.currency}`;
      listings.push({
        id: r.id,
        itemName: name,
        priceText: price,
        seller: r.listing.account?.lastCharacterName ?? r.listing.account?.name ?? 'unknown',
        whisper: r.listing.whisper ?? '',
      });
    }
  }

  const newest = listings.find((l) => l.whisper !== '');
  if (newest !== undefined) {
    try {
      await deps.clipboard(newest.whisper);
    } catch (err) {
      deps.log(`clipboard copy failed (${err instanceof Error ? err.message : err}) — whisper printed below instead.`);
    }
    await deps.notify(
      `Exilium live: ${newest.itemName} · ${newest.priceText}`,
      'Whisper copied — paste it in game.',
    );
  }
  return listings;
}
