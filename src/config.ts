import type { Game } from './domain/types.js';

export interface ExiliumConfig {
  readonly game: Game;
  readonly dbPath: string;
  readonly userAgent: string;
  readonly league: string | null;
  readonly categories: readonly string[];
  readonly dashboardPort: number;
}

/** poe.ninja groups all PoE1 exchange markets under one Currency request;
 * PoE2 splits them across several category types. */
const CATEGORIES_BY_GAME: Readonly<Record<Game, readonly string[]>> = {
  poe1: ['Currency'],
  poe2: ['Currency', 'Runes', 'Essences', 'Delirium', 'Ritual', 'Expedition', 'Breach'],
};

function parseGame(raw: string | undefined): Game {
  if (raw === undefined || raw === 'poe1') return 'poe1';
  if (raw === 'poe2') return 'poe2';
  throw new Error(`EXILIUM_GAME must be "poe1" or "poe2", got "${raw}"`);
}

/** Read configuration from the environment with sane defaults (game: poe1).
 * EXILIUM_CONTACT should be set so poe.ninja can reach us (API etiquette). */
export function loadConfig(env: NodeJS.ProcessEnv): ExiliumConfig {
  const contact = env['EXILIUM_CONTACT'] ?? 'unset-contact';
  const game = parseGame(env['EXILIUM_GAME']);
  return {
    game,
    dbPath: env['EXILIUM_DB'] ?? 'exilium.db',
    userAgent: `Exilium/0.1.0 (contact: ${contact})`,
    league: env['EXILIUM_LEAGUE'] ?? null,
    categories: CATEGORIES_BY_GAME[game],
    dashboardPort: Number(env['EXILIUM_PORT'] ?? 4321),
  };
}
