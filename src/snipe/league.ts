import type { ExiliumConfig } from '../config.js';
import { fetchTradeLeagues } from '../trade/leagues.js';
import type { SnipeTarget } from './bettertrading.js';

/** League resolution for snipe sessions. Searches default to the current
 * challenge league — Allflame — because that is where sniping happens;
 * bookmarks routinely carry stale league names and slugs are league-portable. */

/** Fallback when the trade API is unreachable: the current challenge league. */
export const DEFAULT_SNIPE_LEAGUE = 'Allflame';

export type FetchLeaguesFn = typeof fetchTradeLeagues;

export async function resolveSnipeLeague(
  config: Pick<ExiliumConfig, 'game' | 'league'>,
  flagLeague: string | undefined,
  log: (message: string) => void,
  fetchLeagues: FetchLeaguesFn = fetchTradeLeagues,
): Promise<string> {
  if (flagLeague !== undefined) return flagLeague;
  if (config.league !== null) return config.league;
  try {
    const leagues = await fetchLeagues(config.game, (url, init) => fetch(url, init));
    const challenge = leagues.find((l) => !/standard|hardcore|ruthless/i.test(l));
    if (challenge !== undefined) return challenge;
  } catch (err) {
    log(`could not fetch trade leagues (${err instanceof Error ? err.message : err}) — defaulting to ${DEFAULT_SNIPE_LEAGUE}`);
  }
  return DEFAULT_SNIPE_LEAGUE;
}

/** The league a target actually runs under. PoE1 searches are rewritten to
 * the resolved league (slugs are league-portable); PoE2 searches keep their
 * own league because a PoE1 league name would 400. Null means the target
 * cannot run (PoE2 slug with no league to run it in). */
export function effectiveLeague(target: SnipeTarget, resolved: string, keepLeague: boolean): string | null {
  if (target.realm === 'trade2') return target.league;
  if (keepLeague && target.league !== null) return target.league;
  return resolved;
}
