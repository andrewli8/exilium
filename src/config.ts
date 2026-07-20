import { homedir } from 'node:os';
import { join } from 'node:path';
import type { Game } from './domain/types.js';

/** Values readable from ~/.exilium/config.json — written by `exilium setup`.
 * Environment variables always win over the file. */
export interface FileConfig {
  readonly game?: string;
  readonly league?: string;
  readonly refreshSec?: number;
  readonly minEdgePct?: number;
  readonly webhookUrl?: string;
  readonly experimental?: boolean;
  readonly account?: string;
  readonly poesessid?: string;
}

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
  /** PoE account name for stash reading (env EXILIUM_ACCOUNT or config file). */
  readonly account: string | undefined;
  /** Session cookie for live/stash (env EXILIUM_POESESSID or config file,
   * which `exilium setup` writes with 0600 permissions). */
  readonly poesessid: string | undefined;
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

/** Read configuration: defaults ← config file ← environment (env wins). */
export function loadConfig(env: NodeJS.ProcessEnv, file: FileConfig = {}): ExiliumConfig {
  const contact = env['EXILIUM_CONTACT'];
  const game = parseGame(env['EXILIUM_GAME'] ?? file.game);
  return {
    game,
    dbPath: env['EXILIUM_DB'] ?? join(homedir(), '.exilium', 'exilium.db'),
    userAgent: contact === undefined ? BASE_USER_AGENT : `${BASE_USER_AGENT} (contact: ${contact})`,
    league: env['EXILIUM_LEAGUE'] ?? file.league ?? null,
    categories: CATEGORIES_BY_GAME[game],
    dashboardPort: Number(env['EXILIUM_PORT'] ?? 4321),
    refreshSec: Math.max(MIN_WATCH_INTERVAL_SEC, Number(env['EXILIUM_REFRESH'] ?? file.refreshSec ?? 300)),
    watchIntervalSec: Math.max(MIN_WATCH_INTERVAL_SEC, Number(env['EXILIUM_WATCH_INTERVAL'] ?? 600)),
    minEdgePct: Number(env['EXILIUM_MIN_EDGE'] ?? file.minEdgePct ?? 25),
    webhookUrl: env['EXILIUM_WEBHOOK'] ?? file.webhookUrl,
    experimental: env['EXILIUM_EXPERIMENTAL'] === '1' || (env['EXILIUM_EXPERIMENTAL'] === undefined && file.experimental === true),
    account: env['EXILIUM_ACCOUNT'] ?? file.account,
    poesessid: env['EXILIUM_POESESSID'] ?? file.poesessid,
  };
}

/** Where `exilium setup` writes its file. */
export function configFilePath(env: NodeJS.ProcessEnv): string {
  return env['EXILIUM_CONFIG'] ?? join(homedir(), '.exilium', 'config.json');
}

/** True when a file mode grants no group/other access — required for the
 * config file once it holds a session cookie. */
export function isPermissionSafe(mode: number): boolean {
  return (mode & 0o077) === 0;
}

export function readFileConfig(path: string, readFile: (p: string) => string): FileConfig {
  try {
    const parsed: unknown = JSON.parse(readFile(path));
    return typeof parsed === 'object' && parsed !== null ? (parsed as FileConfig) : {};
  } catch {
    return {};
  }
}
