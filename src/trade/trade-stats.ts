import type { ItemMod, ModKind } from './parse-item.js';

/** GGG's trade stats dataset maps mod text (numbers shown as "#") to the stat
 * ids the trade API filters on. We index it, then match a parsed mod line by
 * normalizing its numbers to "#". */

export interface StatIndex {
  /** group label ("Explicit") -> normalized text -> stat id */
  readonly byGroup: ReadonlyMap<string, ReadonlyMap<string, string>>;
}

interface RawStats {
  readonly result: readonly { readonly label: string; readonly entries: readonly { readonly id: string; readonly text: string }[] }[];
}

const DIGITS = /\d+(?:\.\d+)?/g; // replace only the number, keep the sign
const SIGNED = /[+-]?\d+(?:\.\d+)?/; // extract the signed value

function normalize(text: string): string {
  return text.replace(DIGITS, '#').replace(/\s+/g, ' ').trim().toLowerCase();
}

const KIND_GROUP: Readonly<Record<ModKind, string>> = {
  explicit: 'Explicit',
  implicit: 'Implicit',
  crafted: 'Crafted',
  enchant: 'Enchant',
  fractured: 'Fractured',
  scourge: 'Scourge',
};

export function buildStatIndex(raw: unknown): StatIndex {
  const data = raw as RawStats;
  const byGroup = new Map<string, Map<string, string>>();
  for (const group of data.result ?? []) {
    const m = new Map<string, string>();
    for (const e of group.entries) {
      const key = normalize(e.text);
      if (!m.has(key)) m.set(key, e.id);
    }
    byGroup.set(group.label, m);
  }
  return { byGroup };
}

export interface StatFilter {
  readonly id: string;
  readonly value: { readonly min: number };
}

export function matchMod(mod: ItemMod, index: StatIndex): StatFilter | null {
  const group = index.byGroup.get(KIND_GROUP[mod.kind]);
  const id = group?.get(normalize(mod.text));
  if (id === undefined) return null;
  const firstNumber = SIGNED.exec(mod.text);
  const min = firstNumber === null ? 0 : Number(firstNumber[0]);
  return { id, value: { min } };
}

import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';

const STATS_TTL_MS = 7 * 24 * 3600_000;

/** Fetch GGG's trade stats once and cache to disk (they change per patch).
 * Returns an indexed StatIndex. Falls back to a stale cache on network error. */
export async function loadStatIndex(
  game: 'poe1' | 'poe2',
  cachePath: string,
  fetchFn: (url: string, init: { headers: Record<string, string> }) => Promise<Response>,
  nowMs: number,
): Promise<StatIndex> {
  let cached: { fetchedAt: number; raw: unknown } | null = null;
  try {
    cached = JSON.parse(readFileSync(cachePath, 'utf8')) as { fetchedAt: number; raw: unknown };
  } catch {
    cached = null;
  }
  if (cached !== null && nowMs - cached.fetchedAt < STATS_TTL_MS) {
    return buildStatIndex(cached.raw);
  }
  const api = game === 'poe2' ? 'trade2' : 'trade';
  try {
    const res = await fetchFn(`https://www.pathofexile.com/api/${api}/data/stats`, {
      headers: { 'User-Agent': 'Exilium/0.1.0 (+https://github.com/andrewli8/exilium)' },
    });
    if (!res.ok) throw new Error(String(res.status));
    const raw = await res.json();
    try {
      mkdirSync(dirname(cachePath), { recursive: true });
      writeFileSync(cachePath, JSON.stringify({ fetchedAt: nowMs, raw }));
    } catch {
      // cache write is best-effort
    }
    return buildStatIndex(raw);
  } catch (err) {
    if (cached !== null) return buildStatIndex(cached.raw); // stale is better than nothing
    throw new Error(`Could not load trade stat data: ${err instanceof Error ? err.message : String(err)}`);
  }
}
