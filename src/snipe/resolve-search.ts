/**
 * Better Trading stores some searches as the trade site's compressed query
 * slug (`H4sI…`: gzip + base64url of the query JSON) instead of a search id.
 * The gzip header's OS byte doubles as the site's query-format version, so an
 * old slug gets "migrated" on load — and the migration silently drops
 * filters (a Headhunter map-reward search comes back as "any item"). The
 * slug also cannot back /live, the API seed or fetch?query=.
 *
 * Fix: decode the query locally, POST it once to get a real search id, and
 * cache the id per league so later sessions spend nothing.
 */
import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { gunzipSync } from 'node:zlib';
import { z } from 'zod';
import { tradeSearchApiBase, type TradeSearch } from '../trade/live-search.js';

export function isCompressedQuerySlug(searchId: string): boolean {
  return searchId.startsWith('H4sI');
}

/** The trade query object a compressed slug encodes. Throws on garbage. */
export function decodeQuerySlug(slug: string): Record<string, unknown> {
  const json: unknown = JSON.parse(gunzipSync(Buffer.from(slug, 'base64url')).toString('utf8'));
  if (json === null || typeof json !== 'object' || Array.isArray(json)) {
    throw new Error('compressed search slug did not decode to a query object');
  }
  return json as Record<string, unknown>;
}

const searchIdResponse = z.object({ id: z.string().min(1) });
const cacheSchema = z.record(z.string(), z.string());

export type PostSearch = (url: string, body: string) => Promise<Response>;

export interface ResolveSearchDeps {
  readonly cachePath: string;
  readonly post: PostSearch;
  readonly log: (message: string) => void;
}

function readCache(path: string): Record<string, string> {
  try {
    const parsed = cacheSchema.safeParse(JSON.parse(readFileSync(path, 'utf8')));
    return parsed.success ? parsed.data : {};
  } catch {
    return {};
  }
}

function cacheKey(search: TradeSearch, query: Record<string, unknown>): string {
  const digest = createHash('sha256').update(JSON.stringify(query)).digest('hex').slice(0, 16);
  return `${search.realm}:${search.league}:${digest}`;
}

/** Swap every compressed slug for a real search id. A search whose slug
 * cannot be resolved keeps its slug (logged) so one failure never blocks the
 * rest of the session. Returns new objects; inputs are untouched. */
export async function resolveSearchIds(
  searches: readonly TradeSearch[],
  deps: ResolveSearchDeps,
): Promise<readonly TradeSearch[]> {
  if (!searches.some((search) => isCompressedQuerySlug(search.searchId))) return searches;
  const cache = readCache(deps.cachePath);
  let changed = false;
  // Once the site says 429, every further POST only digs the lockout deeper
  // (and the scheduler would park each one for the cooldown, stalling start).
  let rateLimited = false;
  const resolved: TradeSearch[] = [];
  for (const search of searches) {
    if (!isCompressedQuerySlug(search.searchId)) {
      resolved.push(search);
      continue;
    }
    try {
      const query = decodeQuerySlug(search.searchId);
      const key = cacheKey(search, query);
      let id = cache[key];
      if (id === undefined) {
        if (rateLimited) {
          resolved.push(search);
          continue;
        }
        const res = await deps.post(tradeSearchApiBase(search), JSON.stringify({ query, sort: { indexed: 'desc' } }));
        if (res.status === 429) {
          rateLimited = true;
          deps.log('trade site is rate limiting this account — compressed searches stay unresolved this session; wait a few minutes before restarting');
          resolved.push(search);
          continue;
        }
        if (!res.ok) throw new Error(`trade search returned ${res.status}`);
        id = searchIdResponse.parse(await res.json()).id;
        cache[key] = id;
        changed = true;
      }
      resolved.push({ ...search, searchId: id });
    } catch (error) {
      deps.log(`could not resolve compressed search to a trade id (${error instanceof Error ? error.message : String(error)}) — using it as-is`);
      resolved.push(search);
    }
  }
  if (changed) {
    try {
      mkdirSync(dirname(deps.cachePath), { recursive: true });
      writeFileSync(deps.cachePath, `${JSON.stringify(cache, null, 2)}\n`);
    } catch (error) {
      deps.log(`could not save resolved search ids: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
  return resolved;
}
