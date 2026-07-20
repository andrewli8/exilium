import { z } from 'zod';
import type { DetailedMover } from '../mcp/service.js';

/** Stash reading over the user's own session — the same client-side trust
 * model as live search (Exilence and Awakened established it): the cookie
 * lives in an env var and is sent to pathofexile.com only. Reading your own
 * stash needs your own session; no profile-public requirement applies to
 * yourself. The official OAuth path can replace this transport later without
 * touching valuation or diffing. */

export interface StashItem {
  readonly name: string;
  readonly count: number;
}

export function buildStashUrl(accountName: string, league: string, tabIndex: number): string {
  const params = new URLSearchParams({ accountName, league, tabIndex: String(tabIndex), tabs: '0' });
  return `https://www.pathofexile.com/character-window/get-stash-items?${params.toString()}`;
}

const stashResponseSchema = z.object({
  numTabs: z.number().int().nonnegative(),
  items: z
    .array(z.object({ typeLine: z.string(), stackSize: z.number().optional() }))
    .default([]),
});

export interface StashFetchDeps {
  readonly fetchFn: (url: string, init: { headers: Record<string, string> }) => Promise<Response>;
  /** Pause between tab requests — stash walking is many requests. */
  readonly delayMs: number;
}

const MAX_TABS = 60;

export async function fetchAllStashItems(
  accountName: string,
  league: string,
  sessionId: string,
  deps: StashFetchDeps,
): Promise<readonly StashItem[]> {
  const counts = new Map<string, number>();
  let numTabs = 1;
  for (let tabIndex = 0; tabIndex < Math.min(numTabs, MAX_TABS); tabIndex++) {
    const res = await deps.fetchFn(buildStashUrl(accountName, league, tabIndex), {
      headers: {
        Cookie: `POESESSID=${sessionId}`,
        'User-Agent': 'Exilium/0.1.0 (+https://github.com/andrewli8/exilium)',
      },
    });
    if (res.status === 401 || res.status === 403) {
      throw new Error(
        'pathofexile.com refused the stash request — your POESESSID is missing/expired, or the account name is wrong. Use the full name including the #tag (e.g. CoolExile#1234, shown on your pathofexile.com profile). Reading your own stash needs your own session cookie; check both.',
      );
    }
    if (res.status === 429) {
      throw new Error('pathofexile.com rate-limited the stash walk — wait a minute and rerun.');
    }
    if (!res.ok) throw new Error(`stash request failed (${res.status})`);
    const parsed = stashResponseSchema.safeParse(await res.json());
    if (!parsed.success) throw new Error('stash response did not match the expected shape');
    numTabs = parsed.data.numTabs;
    for (const item of parsed.data.items) {
      const count = item.stackSize ?? 1;
      counts.set(item.typeLine, (counts.get(item.typeLine) ?? 0) + count);
    }
    if (deps.delayMs > 0 && tabIndex + 1 < Math.min(numTabs, MAX_TABS)) {
      await new Promise((r) => setTimeout(r, deps.delayMs));
    }
  }
  return [...counts.entries()].map(([name, count]) => ({ name, count }));
}

export interface StashValuationLine {
  readonly name: string;
  readonly count: number;
  readonly each: number;
  readonly total: number;
}

export interface StashValuation {
  readonly lines: readonly StashValuationLine[];
  readonly unmatched: readonly StashItem[];
  readonly total: number;
}

export function valueStash(items: readonly StashItem[], market: readonly DetailedMover[]): StashValuation {
  const byName = new Map(market.map((m) => [m.name.toLowerCase(), m]));
  const lines: StashValuationLine[] = [];
  const unmatched: StashItem[] = [];
  for (const item of items) {
    const match = byName.get(item.name.toLowerCase());
    if (match === undefined) {
      unmatched.push(item);
      continue;
    }
    lines.push({ name: match.name, count: item.count, each: match.primaryValue, total: item.count * match.primaryValue });
  }
  lines.sort((a, b) => b.total - a.total);
  return { lines, unmatched, total: lines.reduce((a, l) => a + l.total, 0) };
}

export interface StashDiff {
  readonly gained: readonly StashItem[];
  readonly lost: readonly StashItem[];
  /** Net value change of matched items, in the primary currency. */
  readonly valueDelta: number;
}

/** What changed between two stash snapshots — the "did my trades actually
 * happen" check: sold items show as lost, payment shows as gained. */
export function diffStash(
  before: readonly StashItem[],
  after: readonly StashItem[],
  market: readonly DetailedMover[],
): StashDiff {
  const prev = new Map(before.map((i) => [i.name, i.count]));
  const next = new Map(after.map((i) => [i.name, i.count]));
  const names = new Set([...prev.keys(), ...next.keys()]);
  const priceOf = new Map(market.map((m) => [m.name.toLowerCase(), m.primaryValue]));
  const gained: StashItem[] = [];
  const lost: StashItem[] = [];
  let valueDelta = 0;
  for (const name of names) {
    const delta = (next.get(name) ?? 0) - (prev.get(name) ?? 0);
    if (delta === 0) continue;
    const entry = { name, count: Math.abs(delta) };
    if (delta > 0) gained.push(entry);
    else lost.push(entry);
    const price = priceOf.get(name.toLowerCase());
    if (price !== undefined) valueDelta += delta * price;
  }
  return { gained, lost, valueDelta };
}
