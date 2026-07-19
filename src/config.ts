import { homedir } from 'node:os';
import { join } from 'node:path';
import type { Game } from './domain/types.js';

export interface ExiliumConfig {
  readonly game: Game;
  readonly dbPath: string;
  readonly userAgent: string;
  readonly league: string | null;
  readonly categories: readonly string[];
  readonly dashboardPort: number;
  /** Seconds between automatic upstream refreshes in TUI/dashboard
   * (floored at 300 for API politeness). */
  readonly refreshSec: number;
  /** Seconds between watch-mode cycles (floored at 300 for API politeness). */
  readonly watchIntervalSec: number;
  /** Minimum edge (percent) for watch-mode notifications. */
  readonly minEdgePct: number;
  /** Optional Discord-compatible webhook for watch notifications. */
  readonly webhookUrl: string | undefined;
  /** Include experimental signals (cross-rate divergence) in default views. */
  readonly experimental: boolean;
}

/** Exchange category type names per game, as poe.ninja's API expects them
 * (PoE1 uses singular names; PoE2 uses plural). */
const CATEGORIES_BY_GAME: Readonly<Record<Game, readonly string[]>> = {
  poe1: ['Currency', 'Fragment', 'Scarab', 'Essence', 'Oil', 'Fossil', 'Resonator', 'DeliriumOrb', 'Tattoo', 'Omen', 'DivinationCard', 'Artifact', 'AllflameEmber'],
  poe2: ['Currency', 'Runes', 'Essences', 'Delirium', 'Ritual', 'Expedition', 'Breach'],
};

/** The tool identifies itself to upstream APIs; the repo URL is the contact
 * point. EXILIUM_CONTACT optionally appends the operator's own contact. */
const BASE_USER_AGENT = 'Exilium/0.1.0 (+https://github.com/andrewli8/exilium)';

const MIN_WATCH_INTERVAL_SEC = 300;

function parseGame(raw: string | undefined): Game {
  if (raw === undefined || raw === 'poe1') return 'poe1';
  if (raw === 'poe2') return 'poe2';
  throw new Error(`EXILIUM_GAME must be "poe1" or "poe2", got "${raw}"`);
}

/** Read configuration from the environment with sane defaults (game: poe1). */
export function loadConfig(env: NodeJS.ProcessEnv): ExiliumConfig {
  const contact = env['EXILIUM_CONTACT'];
  const game = parseGame(env['EXILIUM_GAME']);
  return {
    game,
    dbPath: env['EXILIUM_DB'] ?? join(homedir(), '.exilium', 'exilium.db'),
    userAgent: contact === undefined ? BASE_USER_AGENT : `${BASE_USER_AGENT} (contact: ${contact})`,
    league: env['EXILIUM_LEAGUE'] ?? null,
    categories: CATEGORIES_BY_GAME[game],
    dashboardPort: Number(env['EXILIUM_PORT'] ?? 4321),
    refreshSec: Math.max(MIN_WATCH_INTERVAL_SEC, Number(env['EXILIUM_REFRESH'] ?? 300)),
    watchIntervalSec: Math.max(MIN_WATCH_INTERVAL_SEC, Number(env['EXILIUM_WATCH_INTERVAL'] ?? 600)),
    minEdgePct: Number(env['EXILIUM_MIN_EDGE'] ?? 25),
    webhookUrl: env['EXILIUM_WEBHOOK'],
    experimental: env['EXILIUM_EXPERIMENTAL'] === '1',
  };
}
