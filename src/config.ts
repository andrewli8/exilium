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
  readonly snipe?: SnipeFileConfig;
}

/** `snipe` block of the config file — every field optional. */
export interface SnipeFileConfig {
  readonly folder?: string;
  readonly minMarginPct?: number;
  readonly sound?: boolean;
  /** Machine-readable JSON webhook fired per snipe alert. */
  readonly webhookUrl?: string;
  /** Optional snipe-specific league; "Current" uses challenge detection. */
  readonly league?: string;
  /** CDP endpoint of a user-launched Chrome for manual travel to attach to. */
  readonly chromeCdpUrl?: string;
  /** Watch searches through the trade site's own /live pages in Chrome
   * instead of Exilium's trade API calls (no Exilium-side rate budget). */
  readonly browserLive?: boolean;
  /** Ring the terminal bell the instant the live stream announces a new
   * listing, before its price is even fetched. */
  readonly framePing?: boolean;
  /** Saved Chrome/Chromium executable path. EXILIUM_CHROME still wins. */
  readonly chromePath?: string;
  /** Saved dedicated browser profile path. */
  readonly chromeProfile?: string;
}

/** Resolved snipe settings (defaults ← file ← env). */
export interface SnipeSettings {
  readonly folder: string | undefined;
  /** Minimum profit margin (%) to surface; defaults to 0 (every profitable
   * listing qualifies until the user raises the threshold). */
  readonly minMarginPct: number | null;
  readonly sound: boolean;
  /** JSON webhook per snipe alert (structured payload, not Discord format). */
  readonly webhookUrl: string | undefined;
  readonly league: string | undefined;
  /** Chrome CDP endpoint for manual travel; defaults to the local debug port. */
  readonly chromeCdpUrl: string;
  /** Browser-live mode: listings come off Chrome's own /live pages.
   * null = auto: use it whenever the Exilium Chrome CDP endpoint responds. */
  readonly browserLive: boolean | null;
  /** Instant bell at websocket-frame time, before prices are known. */
  readonly framePing: boolean;
  readonly chromePath: string | undefined;
  readonly chromeProfile: string | undefined;
}

export interface CategorySpec {
  readonly name: string;
  /** exchange = Currency Exchange ratios (fast-moving, 5-min cadence);
   * items = stash listing prices (slow-moving, hourly cadence). */
  readonly source: 'exchange' | 'items';
}

export interface ExiliumConfig {
  readonly game: Game;
  readonly dbPath: string;
  readonly userAgent: string;
  readonly league: string | null;
  readonly categories: readonly CategorySpec[];
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
  /** `exilium snipe` settings. */
  readonly snipe: SnipeSettings;
}

const ex = (name: string): CategorySpec => ({ name, source: 'exchange' });
const it = (name: string): CategorySpec => ({ name, source: 'items' });

/** Full poe.ninja category map per game, discovered from the site's own
 * sidebar and verified against both APIs (PoE1 exchange uses singular names;
 * PoE2 uses plural; PoE2 has no public item-overview endpoint yet). */
export const CATEGORIES_BY_GAME: Readonly<Record<Game, readonly CategorySpec[]>> = {
  poe1: [
    ...['Currency', 'Fragment', 'Scarab', 'Essence', 'Oil', 'Fossil', 'Resonator', 'DeliriumOrb', 'Tattoo', 'Omen', 'DivinationCard', 'Artifact', 'AllflameEmber', 'Runegraft', 'DjinnCoin', 'Astrolabe'].map(ex),
    ...['UniqueWeapon', 'UniqueArmour', 'UniqueAccessory', 'UniqueFlask', 'UniqueJewel', 'UniqueTincture', 'UniqueMap', 'UniqueRelic', 'Map', 'BlightedMap', 'BlightRavagedMap', 'ValdoMap', 'SkillGem', 'ImbuedGem', 'ClusterJewel', 'ForbiddenJewel', 'BaseType', 'Beast', 'Incubator', 'Invitation', 'ShrineBelt', 'Vial', 'Wombgift'].map(it),
  ],
  poe2: ['Currency', 'Runes', 'Essences', 'Delirium', 'Ritual', 'Expedition', 'Breach', 'Fragments', 'SoulCores', 'Abyss', 'Idols', 'UncutGems'].map(ex),
};

/** The tool identifies itself to upstream APIs; the repo URL is the contact
 * point. EXILIUM_CONTACT optionally appends the operator's own contact. */
const BASE_USER_AGENT = 'Exilium/0.2.10 (+https://github.com/andrewli8/exilium)';

const MIN_WATCH_INTERVAL_SEC = 300;

function parseSnipeMinMargin(envRaw: string | undefined, fileValue: number | undefined): number | null {
  if (envRaw !== undefined && envRaw !== '') {
    const parsed = Number(envRaw);
    if (Number.isNaN(parsed)) throw new Error(`EXILIUM_SNIPE_MIN_MARGIN must be a number (percent), got "${envRaw}"`);
    return parsed;
  }
  return fileValue ?? 0;
}

function loadSnipeSettings(env: NodeJS.ProcessEnv, file: SnipeFileConfig): SnipeSettings {
  const envFolder = env['EXILIUM_BETTERTRADING'];
  return {
    // An empty env var means "unset", never "the empty path".
    folder: envFolder !== undefined && envFolder !== '' ? envFolder : file.folder,
    minMarginPct: parseSnipeMinMargin(env['EXILIUM_SNIPE_MIN_MARGIN'], file.minMarginPct),
    // Sound is on by default: a qualifying live hit should ping. Disable with
    // EXILIUM_SNIPE_SOUND=0 or "sound": false in the config file.
    sound: env['EXILIUM_SNIPE_SOUND'] === '1'
      || (env['EXILIUM_SNIPE_SOUND'] === undefined && file.sound !== false),
    webhookUrl: env['EXILIUM_SNIPE_WEBHOOK'] ?? file.webhookUrl,
    league: file.league,
    chromeCdpUrl: env['EXILIUM_CHROME_CDP'] ?? file.chromeCdpUrl ?? 'http://127.0.0.1:9222',
    browserLive: env['EXILIUM_SNIPE_BROWSER_LIVE'] === '1'
      ? true
      : env['EXILIUM_SNIPE_BROWSER_LIVE'] === '0'
        ? false
        : file.browserLive ?? null,
    // On by default: the trade tab dings at frame time, and the CLI bell
    // should match it. Disable with framePing:false / EXILIUM_SNIPE_FRAME_PING=0.
    framePing: env['EXILIUM_SNIPE_FRAME_PING'] === '1'
      || (env['EXILIUM_SNIPE_FRAME_PING'] === undefined && file.framePing !== false),
    chromePath: env['EXILIUM_CHROME'] ?? file.chromePath,
    chromeProfile: file.chromeProfile,
  };
}

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
    snipe: loadSnipeSettings(env, file.snipe ?? {}),
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
