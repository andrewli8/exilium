import { z } from 'zod';
import { RateLimitError, sharedTradeRateLimiter, TradeRateLimiter } from './rate-limit.js';
import {
  TradeRequestScheduler,
  type TradeRequestPriority,
  resolveTradeRequestScheduler,
} from './request-scheduler.js';

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

function tradeSearchApiBase(search: TradeSearch): string {
  const api = search.realm === 'trade2' ? 'trade2' : 'trade';
  return `https://www.pathofexile.com/api/${api}/search/${encodeURIComponent(search.league)}`;
}

const savedSearchSchema = z.object({
  query: z.record(z.string(), z.unknown()),
});

const searchResultSchema = z.object({
  result: z.array(z.string()),
});

export interface CurrentResultDeps {
  readonly fetchFn: (url: string, init: {
    readonly method?: string;
    readonly headers: Record<string, string>;
    readonly body?: string;
    readonly signal?: AbortSignal;
  }) => Promise<Response>;
  readonly limiter?: TradeRateLimiter;
  readonly scheduler?: TradeRequestScheduler;
  readonly signal?: AbortSignal;
}

function checkTradeResponse(res: Response, limiter: TradeRateLimiter): void {
  if (res.status === 401 || res.status === 403) {
    throw new Error('pathofexile.com rejected the session — your POESESSID is missing or expired. Log into the trade site and update it with `exilium setup`.');
  }
  if (res.status === 429) throw new RateLimitError(limiter.health().cooldownRemainingSec || 60);
  if (!res.ok) throw new Error(`trade search request failed (${res.status})`);
}

/** Resolve the current result ids for one saved trade search. This is a
 * startup seed, not a replacement for the live WebSocket: the first request
 * loads the saved query and the second executes it sorted newest-first. */
export async function fetchCurrentResultIds(
  search: TradeSearch,
  sessionId: string,
  deps: CurrentResultDeps,
): Promise<readonly string[]> {
  const limiter = deps.limiter ?? sharedTradeRateLimiter;
  const scheduler = resolveTradeRequestScheduler(deps.scheduler, deps.limiter);
  const headers = {
    Cookie: `POESESSID=${sessionId}`,
    'User-Agent': 'Exilium/0.2.1 (+https://github.com/andrewli8/exilium)',
  };
  const base = tradeSearchApiBase(search);

  const savedResponse = await scheduler.schedule('seed', () => deps.fetchFn(`${base}/${search.searchId}`, {
      headers,
      ...(deps.signal === undefined ? {} : { signal: deps.signal }),
    }), deps.signal);
  checkTradeResponse(savedResponse, limiter);
  let savedJson: unknown;
  try {
    savedJson = await savedResponse.json();
  } catch {
    throw new Error('saved search response was not valid JSON');
  }
  const saved = savedSearchSchema.safeParse(savedJson);
  if (!saved.success) throw new Error('saved search response did not contain a query');

  const searchResponse = await scheduler.schedule('seed', () => deps.fetchFn(base, {
      method: 'POST',
      headers: { ...headers, 'Content-Type': 'application/json' },
      body: JSON.stringify({ query: saved.data.query, sort: { indexed: 'desc' } }),
      ...(deps.signal === undefined ? {} : { signal: deps.signal }),
    }), deps.signal);
  checkTradeResponse(searchResponse, limiter);
  let resultJson: unknown;
  try {
    resultJson = await searchResponse.json();
  } catch {
    throw new Error('trade search result was not valid JSON');
  }
  const result = searchResultSchema.safeParse(resultJson);
  if (!result.success) throw new Error('trade search response did not contain result ids');
  return result.data.result;
}

// Mod lines come in two shapes: our own API fetches return plain strings,
// while the trade site's live page requests structured objects whose text
// lives in `description`. Both must parse — the browser-live capture reads
// the page's payloads verbatim.
const modLineSchema = z.union([
  z.string(),
  z.object({ description: z.string().optional() }),
]);
const modLinesSchema = z.array(modLineSchema).optional();

const fetchResultEntrySchema = z.object({
      id: z.string(),
      listing: z.object({
        whisper: z.string().optional(),
        indexed: z.string().optional(),
        price: z.object({ amount: z.number(), currency: z.string() }).nullish(),
        account: z.object({ name: z.string().optional(), lastCharacterName: z.string().optional() }).optional(),
      }),
      item: z.object({
        name: z.string().optional(),
        typeLine: z.string().optional(),
        identified: z.boolean().optional(),
        implicitMods: modLinesSchema,
        explicitMods: modLinesSchema,
        enchantMods: modLinesSchema,
        utilityMods: modLinesSchema,
        fracturedMods: modLinesSchema,
        properties: z.array(z.object({
          name: z.string().optional(),
          values: z.array(z.array(z.unknown())).optional(),
        })).optional(),
      }).optional(),
});

// The fetch endpoint pads its result array with nulls for ids it no longer
// knows (already sold, evicted) — a null entry must never sink the batch.
const fetchResponseSchema = z.object({
  result: z.array(z.union([fetchResultEntrySchema, z.null()])),
});

type FetchedItem = NonNullable<z.infer<typeof fetchResultEntrySchema>['item']>;

const REWARD_LINE = /^Reward:\s*(.+?)\s*$/;
const REWARD_STACK_PREFIX = /^\d+x\s+/i;
const REWARD_FOIL_PREFIX = /^Foil\s+/i;
/** Rewards whose reference must pin to one specific ninja line (and skip the
 * unid-floor lookup). Mageblood rewards count as 4-flask — the volume-based
 * variant pick could drift onto the far pricier 5-flask line. */
const REWARD_REFERENCE_OVERRIDES: ReadonlyMap<string, string> = new Map([
  ['mageblood', 'Mageblood (4 Flasks)'],
]);
/** Forbidden Flame/Flesh jewels: the allocated ascendancy passive IS the
 * item's value, and poe.ninja names each variant "<Passive> (<jewel name>)"
 * ("Blazing Cradle (Foil Forbidden Flesh)"). The strict "if you have" suffix
 * keeps this from matching any other Allocates-style mod. */
const ALLOCATES_LINE = /^Allocates (.+?) if you have/;

function extractAllocatedPassive(item: FetchedItem): string | null {
  for (const line of [...item.explicitMods ?? [], ...item.implicitMods ?? []]) {
    const text = modText(line);
    if (text === null) continue;
    const match = ALLOCATES_LINE.exec(text);
    if (match !== null) return match[1]!;
  }
  return null;
}

/** Valdo's Puzzle Box maps carry their actual prize as a "Reward: …" line;
 * that reward — not the map name — is what the listing is worth and what
 * poe.ninja prices (foil uniques get a "(Foil)" variant suffix). */
function modText(line: z.infer<typeof modLineSchema>): string | null {
  if (typeof line === 'string') return line;
  return typeof line.description === 'string' ? line.description : null;
}

function extractReward(item: FetchedItem): string | null {
  const modLines = [
    ...item.implicitMods ?? [],
    ...item.explicitMods ?? [],
    ...item.enchantMods ?? [],
    ...item.utilityMods ?? [],
    ...item.fracturedMods ?? [],
  ];
  for (const line of modLines) {
    const text = modText(line);
    if (text === null) continue;
    const match = REWARD_LINE.exec(text);
    if (match !== null) return match[1]!;
  }
  for (const property of item.properties ?? []) {
    if (property.name?.trim() !== 'Reward') continue;
    const value = property.values?.[0]?.[0];
    if (typeof value === 'string' && value !== '') return value;
  }
  return null;
}

export interface LiveListing {
  readonly id: string;
  /** Display name: unique name + base ("Mageblood Heavy Belt"). */
  readonly itemName: string;
  /** Name to price against reference data: the unique/gem/currency name
   * alone ("Mageblood") — poe.ninja indexes that, never the joined form. */
  readonly referenceName: string;
  readonly priceText: string;
  /** Structured listing price when the seller set one (for margin math). */
  readonly price: { readonly amount: number; readonly currency: string } | null;
  /** Trade API listing timestamp, when supplied. */
  readonly listedAt: string | null;
  readonly seller: string;
  readonly whisper: string;
  /** False for unidentified items (e.g. Forbidden Flame/Flesh gambles, which
   * list as a bare base type); absent means identified. */
  readonly identified?: boolean;
  /** For Valdo map listings: the reward item's base name (foil/stack
   * prefixes stripped) — the snipe engine prices it against the live unid
   * market floor when one exists. */
  readonly rewardBase?: string;
}

export interface LiveDeps {
  readonly fetchFn: (url: string, init: { headers: Record<string, string>; signal?: AbortSignal }) => Promise<Response>;
  /** Copies text for the user to paste in game. */
  readonly clipboard: (text: string) => Promise<void>;
  readonly notify: (title: string, message: string) => Promise<void>;
  readonly log: (message: string) => void;
  /** Shared trade-API rate limiter; defaults to the process-wide instance. */
  readonly limiter?: TradeRateLimiter;
  readonly scheduler?: TradeRequestScheduler;
  readonly signal?: AbortSignal;
}

const FETCH_BATCH = 10;

/** Resolve new listing ids from a live search into structured listings.
 * Fetch-only — callers decide how to notify (the `live` command copies and
 * pings; the snipe engine adds margin math first). */
export async function fetchListings(
  ids: readonly string[],
  search: TradeSearch,
  sessionId: string,
  deps: Pick<LiveDeps, 'fetchFn' | 'limiter' | 'scheduler' | 'signal'>,
): Promise<readonly LiveListing[]> {
  const listings: LiveListing[] = [];
  const limiter = deps.limiter ?? sharedTradeRateLimiter;
  const scheduler = resolveTradeRequestScheduler(deps.scheduler, deps.limiter);
  for (let i = 0; i < ids.length; i += FETCH_BATCH) {
    const batch = ids.slice(i, i + FETCH_BATCH);
    const priority: TradeRequestPriority = 'live';
    const res = await scheduler.schedule(priority, () => deps.fetchFn(buildFetchUrl(batch, search.searchId, search.realm), {
        headers: {
          Cookie: `POESESSID=${sessionId}`,
          'User-Agent': 'Exilium/0.2.1 (+https://github.com/andrewli8/exilium)',
        },
        ...(deps.signal === undefined ? {} : { signal: deps.signal }),
      }), deps.signal);
    if (res.status === 401 || res.status === 403) {
      throw new Error('pathofexile.com rejected the session — your POESESSID is missing or expired. Log into the trade site in a browser and copy the fresh cookie into EXILIUM_POESESSID.');
    }
    if (res.status === 429) throw new RateLimitError(limiter.health().cooldownRemainingSec || 60);
    if (!res.ok) throw new Error(`trade fetch failed (${res.status})`);
    listings.push(...parseFetchResponseBody(await res.json()));
  }
  return listings;
}

/** Normalize one trade fetch response payload (`{result: [...]}`) into
 * structured listings. Shared by our own API fetches and the browser-live
 * capture, which reads the same payload off the trade page's own XHRs. */
export function parseFetchResponseBody(payload: unknown): readonly LiveListing[] {
  const parsed = fetchResponseSchema.safeParse(payload);
  if (!parsed.success) throw new Error('trade fetch response did not match the expected shape');
  return parsed.data.result.filter((r) => r !== null).map((r) => {
    const reward = r.item === undefined ? null : extractReward(r.item);
    const rewardBase = reward === null
      ? null
      : reward.replace(REWARD_STACK_PREFIX, '').replace(REWARD_FOIL_PREFIX, '');
    const identified = r.item?.identified !== false;
    const baseReference = r.item?.name || r.item?.typeLine || r.id;
    const passive = r.item === undefined || !identified ? null : extractAllocatedPassive(r.item);
    const variant = passive === null ? null : `${passive} (${baseReference})`;
    const joined = [r.item?.name, r.item?.typeLine].filter((s) => s !== undefined && s !== '').join(' ') || r.id;
    const name = reward ?? variant ?? (identified ? joined : `Unidentified ${joined}`);
    const price = r.listing.price == null ? 'no price' : `${r.listing.price.amount} ${r.listing.price.currency}`;
    return {
      id: r.id,
      itemName: name,
      identified,
      // The reference for a Valdo map is the reward ITEM's own price — that
      // is what the map is worth chasing. poe.ninja carries no foil item
      // lines, so "Foil Nimis" prices as "Nimis"; stack prefixes ("5x")
      // strip the same way. priceItem prefers the item's own variant lines,
      // so this never substring-matches back into a Valdo map line.
      referenceName: (rewardBase === null ? undefined : REWARD_REFERENCE_OVERRIDES.get(rewardBase.toLowerCase()))
        ?? rewardBase ?? variant ?? baseReference,
      ...(rewardBase === null || REWARD_REFERENCE_OVERRIDES.has(rewardBase.toLowerCase()) ? {} : { rewardBase }),
      priceText: price,
      price: r.listing.price ?? null,
      listedAt: r.listing.indexed ?? null,
      seller: r.listing.account?.lastCharacterName ?? r.listing.account?.name ?? 'unknown',
      whisper: r.listing.whisper ?? '',
    };
  });
}

/** The `live` command's flow: fetch new listings, copy the newest whisper to
 * the clipboard, and send one notification. */
export async function handleNewListings(
  ids: readonly string[],
  search: TradeSearch,
  sessionId: string,
  deps: LiveDeps,
): Promise<readonly LiveListing[]> {
  const listings = await fetchListings(ids, search, sessionId, deps);

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
