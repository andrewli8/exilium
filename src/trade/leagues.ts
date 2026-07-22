import { z } from 'zod';
import type { Game } from '../domain/types.js';

/** Fetch the leagues the pathofexile.com trade search currently accepts.
 *
 * This matters because the trade API 400s with "Invalid query" the moment it
 * sees a league it does not recognize. Challenge leagues (Mirage, Settlers,
 * ...) come and go, so a league that was valid last month is a hard error the
 * next. Reading the live list is the only reliable way to offer a searchable
 * league. Only the pc realm is kept; ids repeat across xbox/sony so we dedupe
 * while preserving GGG's ordering (permanent leagues first, then the current
 * challenge league). */

export type LeagueFetch = (url: string, init: { headers: Record<string, string> }) => Promise<Response>;

const schema = z.object({
  result: z.array(z.object({ id: z.string(), realm: z.string().optional() })),
});

export async function fetchTradeLeagues(game: Game, fetchFn: LeagueFetch): Promise<readonly string[]> {
  const api = game === 'poe2' ? 'trade2' : 'trade';
  const url = `https://www.pathofexile.com/api/${api}/data/leagues`;
  const res = await fetchFn(url, {
    headers: { 'User-Agent': 'Exilium/0.1.0 (+https://github.com/andrewli8/exilium)' },
  });
  if (!res.ok) throw new Error(`could not fetch trade leagues (${res.status})`);
  const parsed = schema.safeParse(await res.json());
  if (!parsed.success) throw new Error('trade leagues response did not match the expected shape');

  const seen = new Set<string>();
  const leagues: string[] = [];
  for (const l of parsed.data.result) {
    if (l.realm !== undefined && l.realm !== 'pc') continue;
    if (seen.has(l.id)) continue;
    seen.add(l.id);
    leagues.push(l.id);
  }
  return leagues;
}
