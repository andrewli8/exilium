import { appendFileSync, existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import type { CategorySpec, ExiliumConfig } from '../config.js';
import { ingestLeague } from '../ingest/ingest.js';
import { NinjaClient } from '../sources/ninja/client.js';
import type { SnapshotRepository } from '../storage/snapshot-repository.js';
import {
  buildLiveWsUrl,
  fetchCurrentResultIds as fetchTradeCurrentResultIds,
  fetchListings as fetchTradeListings,
  type LiveListing,
  type TradeSearch,
} from '../trade/live-search.js';
import { RateLimitError } from '../trade/rate-limit.js';
import {
  sharedTradeRequestScheduler,
  type TradeRequestScheduler,
  type TradeSchedulerHealth,
} from '../trade/request-scheduler.js';
import { createNotifier } from '../watch/notify.js';
import {
  resolveSnipeFolder,
  scaffoldSnipeFolder,
  type SnipeTarget,
} from './bettertrading.js';
import { createTravelController, type TravelController } from './browser.js';
import {
  liveTabTravelPage,
  openBrowserLiveSearch,
  reconcileExpression,
  recoverDetailsExpression,
  type BrowserLiveSearchHandle,
} from './browser-live.js';
import { parseFetchResponseBody } from '../trade/live-search.js';
import { travelSelectedAlert } from './travel.js';
import { loadSnipeCatalog } from './catalog.js';
import {
  promptSnipeTargets,
  renderSnipeConsole,
  type SnipeConsoleHandle,
  type SnipeConsoleOptions,
} from './console.js';
import { decideSnipe, formatAlert, type SnipeAlert } from './engine.js';
import { effectiveLeague, resolveSnipeLeague, type FetchLeaguesFn } from './league.js';
import { alertClearsFlatFloor } from './board.js';
import { assessListingOnly, assessMargin, assessMarginAgainstFloor, toChaos } from './margin.js';
import { RewardFloorService, type PageEvaluate, type RewardFloorPrice } from './reward-floor.js';
import { acquireSnipeLock, defaultIsAlive, releaseSnipeLock } from './instance-lock.js';
import { persistSnipeImport } from './import.js';
import { resolveRequestedTargets } from './selection.js';
import type { TravelResult } from './travel.js';
import { createSoundPlayer, type SoundChild, type SoundPlayer } from './sound-player.js';
import { SnipeStore } from './store.js';
import { buildSnipeWebhookPayload, postSnipeWebhook } from './webhook.js';

export interface SnipeFlags {
  readonly folder: string | undefined;
  readonly league: string | undefined;
  readonly keepLeague: boolean;
  readonly minMargin: string | undefined;
  readonly all: boolean;
  readonly searches: readonly string[];
  /** Ride the trade site's own /live pages in Chrome instead of Exilium
   * calling the trade API (no Exilium-side fetches or rate-limit budget).
   * Unset = auto: probe the Chrome CDP endpoint and use it when it answers. */
  readonly browserLive?: boolean | undefined;
}

export interface SnipeSocket {
  on(event: 'open', listener: () => void): this;
  on(event: 'message', listener: (data: Buffer) => void): this;
  on(event: 'close', listener: (code: number) => void): this;
  on(event: 'error', listener: (error: Error) => void): this;
  close(): void;
}

export type OpenSnipeSocket = (
  search: TradeSearch,
  headers: Readonly<Record<string, string>>,
) => SnipeSocket;

type FetchSnipeListings = (
  ids: readonly string[],
  search: TradeSearch,
  sessionId: string,
  signal?: AbortSignal,
) => Promise<readonly LiveListing[]>;

type FetchCurrentSnipeResultIds = (
  search: TradeSearch,
  sessionId: string,
  signal?: AbortSignal,
) => Promise<readonly string[]>;

export interface SnipeDeps {
  readonly config: ExiliumConfig;
  readonly repo: SnapshotRepository;
  readonly out: (message: string) => void;
  readonly log: (message: string) => void;
  readonly isTTY?: boolean;
  readonly promptTargets?: typeof promptSnipeTargets;
  readonly promptImport?: () => Promise<string | null>;
  readonly makeConsole?: (options: SnipeConsoleOptions) => SnipeConsoleHandle;
  readonly makeTravelController?: typeof createTravelController;
  readonly openSocket?: OpenSnipeSocket;
  readonly fetchListings?: FetchSnipeListings;
  readonly fetchCurrentResultIds?: FetchCurrentSnipeResultIds;
  readonly refreshPrices?: (signal: AbortSignal) => Promise<void>;
  readonly notify?: (title: string, body: string) => Promise<void>;
  readonly recordAlert?: (alert: SnipeAlert, action: string, detail: string) => void;
  readonly now?: () => number;
  readonly connectStaggerMs?: number;
  readonly fetchLeagues?: FetchLeaguesFn;
  readonly shutdownTimeoutMs?: number;
  readonly store?: SnipeStore;
  readonly scheduler?: TradeRequestScheduler;
  readonly openLiveSearch?: typeof openBrowserLiveSearch;
  /** Auto-mode Chrome detection; defaults to a short CDP /json/version probe. */
  readonly probeChrome?: (cdpUrl: string) => Promise<boolean>;
  /** Startup housekeeping; defaults to closing orphaned about:blank tabs. */
  readonly closeOrphanTabs?: (cdpUrl: string, log: (message: string) => void) => Promise<void>;
  /** Backoff ladder for reopening a dropped live tab; tests pass zeros. */
  readonly reopenDelaysMs?: readonly number[];
  /** Directory for the single-instance lock; defaults to ~/.exilium. */
  readonly lockDir?: string;
}

export const MAX_SNIPE_SOCKETS = 20;
const CONNECT_STAGGER_MS = 500;
/** Pause between browser-live tab opens. Each tab's plain-page load runs a
 * real search under the user's session, and the site budgets those tightly —
 * tabs must open one at a time with breathing room, never all at once. */
const BROWSER_LIVE_TAB_GAP_MS = 4_000;
/** Cadence of the tab-vs-CLI reconciliation sweep. */
const RECONCILE_INTERVAL_MS = 45_000;
/** Backoff between automatic reopen attempts for a live tab that dropped
 * (closed by hand, a Chrome restart, the page navigating away). */
const BROWSER_LIVE_REOPEN_DELAYS_MS: readonly number[] = [5_000, 15_000, 45_000];
/** A tab connected at least this long was healthy — its drop starts a fresh
 * backoff ladder instead of continuing the old one. */
const REOPEN_HEALTHY_MS = 60_000;
const NO_PRIOR_LISTINGS: ReadonlySet<string> = new Set();

export function snipeStartupMessages(
  searchCount: number,
  league: string,
  minMarginPct: number | null,
  browserLive = false,
): readonly string[] {
  return [
    `Exilium snipe — ${searchCount} enabled search${searchCount === 1 ? '' : 'es'} · league ${league} · min margin ${minMarginPct ?? 'off'}`,
    ...(browserLive ? [
      'Browser-live: Chrome opens each search\'s /live page and Exilium reads listings straight off those tabs — no trade API calls of its own.',
      'Run `exilium chrome` and log into pathofexile.com first. Tabs open one at a time (the site budgets searches), so the board fills as each search seeds. Enter clicks Travel to Hideout in the already-open tab.',
    ] : [
      'Monitoring is headless. Current results seed quietly; new live hits notify.',
      'Chrome is only needed after you press Enter to travel; no whisper is sent or copied.',
    ]),
  ];
}

/** The snipe refresh only needs what margin pricing can consult: the
 * exchange tables (small, and the chaos/divine rate lives there) plus the
 * unique-item families rewards resolve against. The heavy item categories
 * (SkillGem 5k+ rows, BaseType, Map, Beast, …) are never referenced by
 * snipe pricing — gem-style rewards fall back to the live floor service —
 * so refetching them at boot was pure startup cost. */
export function snipePricingCategories(categories: readonly CategorySpec[]): readonly CategorySpec[] {
  return categories.filter((spec) => spec.source === 'exchange' || /^(Unique|Forbidden|Valdo)/.test(spec.name));
}

function snipeLogPath(): string {
  return join(homedir(), '.exilium', 'snipes.jsonl');
}

/** Close leftover about:blank tabs in the Exilium Chrome. Every CDP page is
 * born as about:blank; a raced close or a force-killed session strands them,
 * and they accumulate across restarts. The Exilium profile is dedicated, so
 * blank tabs there are ours to reap. */
async function closeOrphanBlankTabs(cdpUrl: string, log: (message: string) => void): Promise<void> {
  try {
    const base = cdpUrl.endsWith('/') ? cdpUrl : `${cdpUrl}/`;
    const targets = await fetch(new URL('json', base), { signal: AbortSignal.timeout(2_000) })
      .then((res) => res.json()) as Array<{ id?: string; type?: string; url?: string }>;
    const orphans = targets.filter((t) => t.type === 'page' && t.url === 'about:blank' && typeof t.id === 'string');
    for (const orphan of orphans) {
      await fetch(new URL(`json/close/${orphan.id}`, base), { signal: AbortSignal.timeout(2_000) }).catch(() => undefined);
    }
    if (orphans.length > 0) log(`closed ${orphans.length} orphaned about:blank tab(s) from a previous session`);
  } catch {
    // Best-effort housekeeping — never block startup on it.
  }
}

async function probeChromeCdp(cdpUrl: string): Promise<boolean> {
  try {
    const base = cdpUrl.endsWith('/') ? cdpUrl : `${cdpUrl}/`;
    const response = await fetch(new URL('json/version', base), { signal: AbortSignal.timeout(1_000) });
    return response.ok;
  } catch {
    return false;
  }
}

function recordSnipe(alert: SnipeAlert, action: string, detail: string, log: (message: string) => void): void {
  try {
    appendFileSync(snipeLogPath(), `${JSON.stringify({
      ts: new Date().toISOString(),
      ...alert,
      action,
      detail,
    })}\n`);
  } catch (error) {
    log(`could not append to ${snipeLogPath()}: ${error instanceof Error ? error.message : String(error)}`);
  }
}

interface RunnableTarget {
  readonly target: SnipeTarget;
  readonly search: TradeSearch;
}

interface RuntimeTarget extends RunnableTarget {
  readonly seen: Set<string>;
  readonly inFlight: Set<string>;
  /** Per-search processing chain: batches are handled in arrival order (a
   * live hit never overtakes the seed batch emitted before it). */
  chain: Promise<void>;
  /** Chaos price of every listing seen on this search, keyed by listing id.
   * The minimum (excluding the listing being judged) is the search floor —
   * the reference for listings poe.ninja cannot index. */
  readonly knownPrices: Map<string, number>;
}

const MAX_KNOWN_PRICES = 200;
const MAX_SEEN_IDS = 5_000;

function searchFloorChaos(prices: ReadonlyMap<string, number>, excludingId: string): number | undefined {
  let floor: number | undefined;
  for (const [id, chaos] of prices) {
    if (id === excludingId) continue;
    if (floor === undefined || chaos < floor) floor = chaos;
  }
  return floor;
}

async function promptImportSource(): Promise<string | null> {
  const { createInterface } = await import('node:readline/promises');
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  try {
    const value = await rl.question('Paste a Better Trading folder export (blank to cancel):\n');
    return value.trim() === '' ? null : value;
  } finally {
    rl.close();
  }
}

export async function runSnipe(flags: SnipeFlags, deps: SnipeDeps): Promise<void> {
  const { config, repo, out, log } = deps;
  const folder = resolveSnipeFolder({
    flagValue: flags.folder ?? config.snipe.folder,
    cwd: process.cwd(),
    home: homedir(),
  });
  if (!existsSync(folder)) {
    const written = scaffoldSnipeFolder(folder);
    out(`No BetterTrading folder yet — created ${folder} with a starter:`);
    for (const path of written) out(`  ${path}`);
    out('Paste a Better Trading export now, or use `exilium snipe import` later.');
  }

  // Warn (never block) when another live snipe session already runs: two
  // sessions share one Chrome, double-process every listing, and the extra
  // DB connection blocks WAL checkpointing — a major source of slowdown.
  const lock = acquireSnipeLock(deps.lockDir ?? join(homedir(), '.exilium'), process.pid, defaultIsAlive);
  if (!lock.acquired) {
    out(`⚠ Another Exilium snipe session appears to be running (pid ${lock.holderPid}).`);
    out('  Two sessions double-process listings and fight over the same Chrome tabs — close the other one (or this one).');
    log(`another snipe session holds the lock (pid ${lock.holderPid})`);
  }

  const loadEnabledTargets = (): readonly SnipeTarget[] =>
    loadSnipeCatalog(folder, log).filter((entry) => entry.enabled);
  let allTargets = loadEnabledTargets();
  const interactive = deps.isTTY ?? process.stdin.isTTY === true;
  if (allTargets.length === 0 && interactive) {
    const askImport = deps.promptImport ?? promptImportSource;
    while (allTargets.length === 0) {
      const source = await askImport();
      if (source === null) break;
      try {
        const imported = persistSnipeImport({ folder, content: source, sourceName: 'startup paste' });
        out(`Imported ${imported.targets.length} Better Trading search${imported.targets.length === 1 ? '' : 'es'} to ${imported.path}.`);
        allTargets = loadEnabledTargets();
      } catch (error) {
        out(`Import failed: ${error instanceof Error ? error.message : String(error)}`);
      }
    }
  }
  if (allTargets.length === 0) {
    out(`${folder} holds no usable trade searches. Add trade URLs or run \`exilium snipe import\`.`);
    return;
  }

  const requested = resolveRequestedTargets(allTargets, {
    isTTY: interactive,
    all: flags.all,
    searches: flags.searches,
  });
  const selected = requested ?? await (deps.promptTargets ?? promptSnipeTargets)(allTargets);
  if (selected.length === 0) {
    out('No Better Trading searches enabled for this run.');
    return;
  }

  // Mode: explicit flag/config wins; otherwise auto — ride Chrome's own /live
  // pages whenever the Exilium Chrome endpoint responds, because that mode has
  // no trade API budget (no COOLDOWN) and shows current results immediately.
  const modePreference = flags.browserLive ?? config.snipe.browserLive;
  const browserLive = modePreference
    ?? await (deps.probeChrome ?? probeChromeCdp)(config.snipe.chromeCdpUrl);
  if (modePreference === null || modePreference === undefined) {
    if (browserLive) log('Chrome detected — browser-live mode: listings come off the live tabs, no trade API calls. Use --no-browser-live to force API mode.');
    else log('Chrome is not running — using trade API mode. Tip: start `exilium chrome` first to snipe through live tabs with no API cooldowns.');
  }
  const sessionId = config.poesessid ?? '';
  if (!browserLive && sessionId === '') {
    throw new Error(
      'No session cookie configured. Run `exilium setup`, or set EXILIUM_POESESSID for this run. The cookie stays on this machine and is sent only to pathofexile.com. (Browser-live mode with --browser-live needs no cookie — the Chrome tab is already logged in.)',
    );
  }

  const leagueRequest = flags.league ?? config.snipe.league;
  const wantsCurrentLeague = leagueRequest?.toLowerCase() === 'current';
  const leagueConfig = wantsCurrentLeague ? { ...config, league: null } : config;
  const league = await resolveSnipeLeague(
    leagueConfig,
    wantsCurrentLeague ? undefined : leagueRequest,
    log,
    deps.fetchLeagues,
  );
  const minMarginPct = flags.minMargin === undefined ? config.snipe.minMarginPct : Number(flags.minMargin);
  if (minMarginPct !== null && Number.isNaN(minMarginPct)) {
    throw new Error('--min-margin must be a number (percent)');
  }

  const runnableCandidates: RunnableTarget[] = [];
  for (const target of selected) {
    const targetLeague = effectiveLeague(target, league, flags.keepLeague);
    if (targetLeague === null) {
      log(`skipping "${target.label}": PoE2 search without a league in its source`);
      continue;
    }
    runnableCandidates.push({
      target,
      search: { realm: target.realm, league: targetLeague, searchId: target.searchId },
    });
  }
  const runnable = runnableCandidates.slice(0, MAX_SNIPE_SOCKETS);
  if (runnableCandidates.length > MAX_SNIPE_SOCKETS) {
    log(`Selected ${runnableCandidates.length} runnable searches; enabling the first ${MAX_SNIPE_SOCKETS} because the trade site caps live searches per account.`);
  }
  if (runnable.length === 0) {
    out('None of the selected searches can run in the resolved league.');
    return;
  }
  const sharedStore = deps.store ?? new SnipeStore(runnable.map(({ target }) => ({
    ...target,
    key: `${target.realm}:${target.searchId}`,
    enabled: true,
    source: 'Better Trading' as const,
  })), { minMarginPct: minMarginPct ?? 0 });
  const tradeScheduler = deps.scheduler ?? sharedTradeRequestScheduler;
  let lastSchedulerStatus: string | null | undefined;
  const publishSchedulerHealth = (health: TradeSchedulerHealth): void => {
    const status = health.state === 'ready'
      ? null
      : health.state === 'rate-limited'
        ? `RATE LIMITED ${health.cooldownRemainingSec}s`
        : `COOLDOWN ${health.cooldownRemainingSec}s`;
    if (status !== lastSchedulerStatus) {
      lastSchedulerStatus = status;
      sharedStore.setStatus(status);
    }
  };
  publishSchedulerHealth(tradeScheduler.health());
  const unsubscribeScheduler = tradeScheduler.subscribe(publishSchedulerHealth);

  const now = deps.now ?? Date.now;
  // Variant-lottery rewards (Sublime Vision, Forbidden jewels) have no
  // honest ninja aggregate; their reference is the live unid market floor,
  // fetched through an open browser-live tab and cached.
  let floorEvaluate: PageEvaluate | null = null;
  const rewardFloorService = new RewardFloorService({
    league,
    getEvaluate: () => floorEvaluate,
    log,
    now,
  });
  const record = deps.recordAlert ?? ((alert, action, detail) => recordSnipe(alert, action, detail, log));
  let notify = deps.notify;
  let sound = (): void => undefined;
  let soundPlayer: SoundPlayer | null = null;
  if (notify === undefined || config.snipe.sound) {
    const { execFile, spawn } = await import('node:child_process');
    const { promisify } = await import('node:util');
    const exec = promisify(execFile);
    // windowsHide keeps the PowerShell console window (sound, toast) from
    // flashing up and stealing the terminal's foreground on every hit.
    const execFn = async (command: string, args: readonly string[]): Promise<unknown> => exec(command, [...args], { windowsHide: true });
    notify ??= createNotifier({
      platform: process.platform,
      execFn,
      fetchFn: (url, init) => fetch(url, init),
      webhookUrl: config.webhookUrl,
      log,
    }).notify;
    if (config.snipe.sound) {
      // One long-lived player process: a per-ping spawn costs ~100ms (afplay)
      // to seconds (PowerShell cold start on Windows) — audible lag against
      // the trade tab's instant ding. A pipe write is free.
      soundPlayer = createSoundPlayer(
        process.platform,
        (cmd, args, opts) => spawn(cmd, [...args], opts) as unknown as SoundChild,
        log,
      );
      sound = () => {
        // Terminal bell first: zero spawn cost, rings the instant the hit is
        // judged. macOS follows with the persistent player; Windows uses the
        // proven per-invocation spawn (a persistent PowerShell loop is
        // unverified on real Windows and a broken loop means silent pings).
        try { process.stdout.write('\u0007'); } catch { /* stdout may be gone at shutdown */ }
        if (process.platform === 'darwin') soundPlayer?.play();
        else if (process.platform === 'win32') {
          void execFn('powershell', ['-NoProfile', '-NonInteractive', '-WindowStyle', 'Hidden', '-Command', '[System.Media.SystemSounds]::Asterisk.Play()']).catch(() => undefined);
        }
      };
    }
  }

  const makeController = deps.makeTravelController ?? createTravelController;
  let shutdownRequested = false;
  let controllerPromise: Promise<TravelController> | undefined;
  const ensureController = (): Promise<TravelController> => {
    if (controllerPromise === undefined) {
      controllerPromise = makeController({
        cdpUrl: config.snipe.chromeCdpUrl,
        profileDir: config.snipe.chromeProfile ?? join(homedir(), '.exilium', 'browser-profile'),
        log,
      }).then((controller) => {
        if (shutdownRequested) void controller.close().catch(() => undefined);
        return controller;
      }).catch((error: unknown) => {
        controllerPromise = undefined;
        throw error;
      });
    }
    return controllerPromise;
  };

  const recordWebhook = (alert: SnipeAlert, action: string, detail: string, recordDetail = detail): void => {
    record(alert, action, recordDetail);
    if (config.snipe.webhookUrl !== undefined) {
      const payload = buildSnipeWebhookPayload(alert, action, detail, new Date(now()).toISOString());
      void postSnipeWebhook(config.snipe.webhookUrl, payload, (url, init) => fetch(url, init), log);
    }
  };

  const liveTabs = new Map<string, BrowserLiveSearchHandle>();
  // The user closing the travel tab (or Chrome restarting) kills the cached
  // CDP page; every later Enter would fail with "connection is closed".
  // Detect that and rebuild once on the same keypress.
  const closedPagePattern = /connection is closed|connection closed|Target closed|Session closed|controller is closed/i;
  const staleTravel = (result: TravelResult): boolean =>
    result.action === 'failed' && closedPagePattern.test(result.technicalDetail ?? result.detail);
  const onTravel = async (alert: SnipeAlert): Promise<TravelResult> => {
    const liveTab = liveTabs.get(alert.targetId);
    if (liveTab !== undefined) {
      const result = await travelSelectedAlert(alert, liveTabTravelPage(liveTab.page, alert.searchUrl));
      if (!staleTravel(result)) {
        recordWebhook(alert, result.action, result.detail, result.technicalDetail ?? result.detail);
        return result;
      }
      liveTabs.delete(alert.targetId);
      log(`browser-live tab for ${alert.targetLabel} is gone — traveling via a fresh tab`);
    }
    try {
      let result = await (await ensureController()).travel(alert);
      if (staleTravel(result)) {
        const stale = controllerPromise;
        controllerPromise = undefined;
        if (stale !== undefined) void stale.then((controller) => controller.close()).catch(() => undefined);
        result = await (await ensureController()).travel(alert);
      }
      recordWebhook(alert, result.action, result.detail, result.technicalDetail ?? result.detail);
      return result;
    } catch (error) {
      const technicalDetail = error instanceof Error ? error.message : String(error);
      const result: TravelResult = {
        action: 'failed',
        detail: 'Chrome unavailable — run `exilium chrome`, log into pathofexile.com, then press Enter again',
        technicalDetail,
      };
      recordWebhook(alert, result.action, result.detail, technicalDetail);
      return result;
    }
  };

  let resolveStop!: () => void;
  let stopIntent = false;
  const stopRequested = new Promise<void>((resolve) => { resolveStop = resolve; });
  const requestStop = (): void => {
    stopIntent = true;
    shutdownRequested = true;
    resolveStop();
  };
  let consoleHandle: SnipeConsoleHandle | undefined;

  let stopped = false;
  const sockets = new Set<SnipeSocket>();
  const timers = new Set<ReturnType<typeof setTimeout>>();
  const pending = new Set<Promise<void>>();
  let refreshTimer: ReturnType<typeof setInterval> | undefined;
  let rateHealthTimer: ReturnType<typeof setInterval> | undefined;
  let reconcileTimer: ReturnType<typeof setInterval> | undefined;

  const refreshAbort = new AbortController();
  // Margins are only as honest as the reference data: the boot refresh always
  // refetches poe.ninja in full (no dedupe window), so a snipe session never
  // starts against prices left behind by an earlier process.
  let bootRefreshDone = false;
  const refresh = deps.refreshPrices ?? (async (signal: AbortSignal) => {
    try {
      const client = new NinjaClient({
        userAgent: config.userAgent,
        fetchFn: (url, init) => fetch(url, { ...init, signal }),
      });
      const result = await ingestLeague(client, repo, {
        game: config.game,
        league,
        categories: snipePricingCategories(config.categories),
        now: () => new Date(now()).toISOString(),
        ...(bootRefreshDone
          ? { itemsMinIntervalSec: Math.max(300, config.refreshSec) }
          : { minIntervalSec: 0, itemsMinIntervalSec: 0 }),
      });
      bootRefreshDone = true;
      if (result.saved.length > 0) {
        invalidateSnapshots();
        log(`refreshed ${result.saved.length} categories`);
      }
    } catch (error) {
      log(`price refresh failed: ${error instanceof Error ? error.message : String(error)}`);
    }
  });
  let refreshTask: Promise<void> | undefined;
  const startRefresh = (): void => {
    if (refreshTask !== undefined) return;
    const task = refresh(refreshAbort.signal).catch((error: unknown) => {
      if (!shutdownRequested) log(`price refresh failed: ${error instanceof Error ? error.message : String(error)}`);
    });
    refreshTask = task;
    void task.finally(() => {
      if (refreshTask === task) refreshTask = undefined;
      // Warm the snapshot cache in the refresh's own context: the ~35k-line
      // latestAll parse must never run lazily on the next arriving listing —
      // that lazy parse was a visible listing→CLI stall (and frozen input)
      // once per refresh cycle.
      if (!stopped && !stopIntent) {
        try { latestSnapshots(league); } catch { /* next listing falls back to the lazy path */ }
      }
    });
  };

  let openSocket = deps.openSocket;
  if (openSocket === undefined) {
    const { default: WebSocket } = await import('ws');
    openSocket = (search, headers) => new WebSocket(buildLiveWsUrl(search), { headers: { ...headers } }) as unknown as SnipeSocket;
  }
  const networkAbort = new AbortController();
  const fetchListings = deps.fetchListings ?? ((ids, search, sid, signal) =>
    fetchTradeListings(ids, search, sid, {
      fetchFn: (url, init) => fetch(url, { ...init, ...(signal === undefined ? {} : { signal }) }),
      scheduler: tradeScheduler,
    }));
  const fetchCurrentResultIds = deps.fetchCurrentResultIds ?? ((search, sid, signal) =>
    fetchTradeCurrentResultIds(search, sid, {
      fetchFn: (url, init) => fetch(url, init),
      scheduler: tradeScheduler,
      ...(signal === undefined ? {} : { signal }),
    }));
  const runtimeTargets: readonly RuntimeTarget[] = runnable.map((entry) => ({
    ...entry,
    seen: new Set<string>(),
    inFlight: new Set<string>(),
    knownPrices: new Map<string, number>(),
    chain: Promise.resolve(),
  }));
  sharedStore.setProgress(0, runtimeTargets.length);

  const headers = {
    Cookie: `POESESSID=${sessionId}`,
    'User-Agent': config.userAgent,
    Origin: 'https://www.pathofexile.com',
  };

  const startTask = (task: Promise<void>): void => {
    pending.add(task);
    void task.finally(() => pending.delete(task));
  };

  // repo.latestAll parses every tracked market line (~35k) from SQLite —
  // far too heavy to run per listing batch on the live hot path. Cache it;
  // a completed price refresh or the TTL invalidates.
  // Long TTL: completed refreshes invalidate explicitly, so this only guards
  // against a refresh loop that silently stopped.
  const SNAPSHOTS_CACHE_MS = 600_000;
  let snapshotsCache: { readonly league: string; readonly data: ReturnType<SnapshotRepository['latestAll']>; readonly at: number } | null = null;
  const latestSnapshots = (targetLeague: string): ReturnType<SnapshotRepository['latestAll']> => {
    if (snapshotsCache !== null && snapshotsCache.league === targetLeague && now() - snapshotsCache.at < SNAPSHOTS_CACHE_MS) {
      return snapshotsCache.data;
    }
    const data = repo.latestAll(config.game, targetLeague);
    snapshotsCache = { league: targetLeague, data, at: now() };
    return data;
  };
  const invalidateSnapshots = (): void => { snapshotsCache = null; };

  const EMPTY_FLOORS: ReadonlyMap<string, RewardFloorPrice> = new Map();
  const collectRewardFloors = async (
    listings: readonly LiveListing[],
  ): Promise<ReadonlyMap<string, RewardFloorPrice>> => {
    const bases = [...new Set(listings
      .map((listing) => listing.rewardBase)
      .filter((base): base is string => base !== undefined))];
    const floors = new Map<string, RewardFloorPrice>();
    for (const base of bases) {
      const price = await rewardFloorService.floorPrice(base);
      if (price !== null) floors.set(base.toLowerCase(), price);
    }
    return floors;
  };

  const cachedRewardFloors = (
    listings: readonly LiveListing[],
  ): ReadonlyMap<string, RewardFloorPrice> => {
    const floors = new Map<string, RewardFloorPrice>();
    for (const base of new Set(listings.map((listing) => listing.rewardBase).filter((b): b is string => b !== undefined))) {
      const hit = rewardFloorService.cached(base);
      if (hit !== undefined && hit !== null) floors.set(base.toLowerCase(), hit);
      void rewardFloorService.floorPrice(base).catch(() => undefined);
    }
    return floors;
  };

  const processListings = (
    entry: RuntimeTarget,
    listings: readonly LiveListing[],
    source: 'seed' | 'live',
    dedupe: boolean,
    rewardFloorPrices: ReadonlyMap<string, RewardFloorPrice> = EMPTY_FLOORS,
  ): number => {
    const fresh = dedupe ? listings.filter((listing) => !entry.seen.has(listing.id)) : listings;
    if (fresh.length === 0) return 0;
    if (dedupe) {
      for (const listing of fresh) entry.seen.add(listing.id);
      // Busy searches accrete ids forever; trim the oldest (Set iterates in
      // insertion order) so a long session cannot leak without bound.
      while (entry.seen.size > MAX_SEEN_IDS) {
        const oldest = entry.seen.values().next().value;
        if (oldest === undefined) break;
        entry.seen.delete(oldest);
      }
    }
    const snapshots = latestSnapshots(entry.search.league);
    sharedStore.setChaosPerDivine(toChaos({ amount: 1, currency: 'divine' }, snapshots));
    let queued = 0;
    const batch: Array<{ readonly alert: SnipeAlert; readonly pingQualifies: boolean }> = [];
    for (const listing of fresh) {
      if (stopped || stopIntent) return queued;
      const rewardFloor = listing.rewardBase === undefined
        ? undefined
        : rewardFloorPrices.get(listing.rewardBase.toLowerCase());
      const rewardFloorChaos = rewardFloor === undefined ? null : toChaos(rewardFloor, snapshots);
      let assessment = rewardFloorChaos !== null
        ? assessMarginAgainstFloor({
          price: listing.price,
          floorChaos: rewardFloorChaos,
          snapshots,
          nowMs: now(),
          referenceName: `${listing.rewardBase} (unid floor)`,
        })
        : listing.identified === false
          // An unid listing's name is just a base type — a ninja match on it
          // would price the wrong thing entirely. Fall through to the floors.
          ? assessListingOnly(listing.price, snapshots)
          : assessMargin({ itemName: listing.referenceName, price: listing.price, snapshots, nowMs: now() });
      if (assessment.referenceChaos === null) {
        // poe.ninja has no aggregate (unidentified unique, rare): fall back to
        // the cheapest other listing on this very search as the floor.
        const floor = searchFloorChaos(entry.knownPrices, listing.id);
        if (floor !== undefined) {
          assessment = assessMarginAgainstFloor({ price: listing.price, floorChaos: floor, snapshots, nowMs: now() });
        }
      }
      const listedChaos = assessment.listedChaos ?? (listing.price === null ? null : toChaos(listing.price, snapshots));
      if (listedChaos !== null) {
        entry.knownPrices.set(listing.id, listedChaos);
        while (entry.knownPrices.size > MAX_KNOWN_PRICES) {
          const oldest = entry.knownPrices.keys().next().value;
          if (oldest === undefined) break;
          entry.knownPrices.delete(oldest);
        }
      }
      const decision = decideSnipe({
        listing,
        target: entry.target,
        assessment,
        snapshots,
        globalMinMarginPct: minMarginPct,
        source: source === 'seed' ? 'current' : 'live',
        league: entry.search.league,
        seen: NO_PRIOR_LISTINGS,
      });
      if (decision.kind === 'suppressed') {
        log(`skip ${listing.itemName}: ${decision.reason}`);
        continue;
      }
      const alert = decision.alert;
      // The ping follows the threshold shown on the board: a flat session
      // threshold (e.g. "5d") replaces the percent gate. It fires BEFORE any
      // store/UI work — the user hears about the hit first, the board catches
      // up milliseconds later.
      const flatFloor = sharedStore.snapshot().flatFloor;
      const pingQualifies = flatFloor === null
        ? alert.qualifiesMargin
        : alertClearsFlatFloor(alert, flatFloor.chaos);
      if (source === 'live' && pingQualifies) {
        const rendered = formatAlert(alert);
        sound();
        void notify!(rendered.title, rendered.body).catch(() => undefined);
      }
      batch.push({ alert, pingQualifies });
      queued += 1;
    }
    // One store rebuild for the whole batch, then the per-alert bookkeeping.
    sharedStore.ingestMany(batch.map((entryAlert) => entryAlert.alert));
    // Auto-arm Enter: the newest qualifying live hit selects itself, so the
    // travel keypress is always pointed at the freshest opportunity.
    if (source === 'live') {
      const newestQualifying = batch.find((entryAlert) => entryAlert.pingQualifies);
      if (newestQualifying !== undefined) sharedStore.selectListing(newestQualifying.alert.listingId);
    }
    for (const { alert, pingQualifies } of batch) {
      consoleHandle?.addAlert(alert);
      if (source === 'live' && pingQualifies) {
        recordWebhook(alert, 'queued', 'waiting for Enter');
      } else if (source === 'seed') {
        record(alert, 'seeded', 'current result at startup');
      } else {
        record(alert, 'hidden', 'below the configured margin floor or reference price unknown');
      }
    }
    return queued;
  };

  const processIds = async (
    entry: RuntimeTarget,
    ids: readonly string[],
    source: 'seed' | 'live',
  ): Promise<number> => {
    const fresh = ids.filter((id) => !entry.seen.has(id) && !entry.inFlight.has(id));
    if (fresh.length === 0) return 0;
    for (const id of fresh) entry.inFlight.add(id);
    try {
      const listings = await fetchListings(fresh, entry.search, sessionId, networkAbort.signal);
      if (stopped || stopIntent) return 0;
      for (const id of fresh) entry.seen.add(id);
      return processListings(entry, listings, source, false);
    } finally {
      for (const id of fresh) entry.inFlight.delete(id);
    }
  };

  // A dropped live tab used to kill its stream until the whole snipe session
  // was restarted. Instead, reopen it on a backoff ladder. Reopens serialize
  // behind one chain with the same inter-open gap as the startup ramp: a
  // Chrome restart drops every tab at once, and each reopen's plain-page
  // load runs a search the site budgets.
  const reopenAttempts = new Map<string, number>();
  const liveTabOpenedAt = new Map<string, number>();
  let reopenChain: Promise<void> = Promise.resolve();
  const reopenDelays = deps.reopenDelaysMs ?? BROWSER_LIVE_REOPEN_DELAYS_MS;
  const scheduleReopen = (entry: RuntimeTarget): void => {
    const targetId = `${entry.target.realm}:${entry.target.searchId}`;
    const openedAt = liveTabOpenedAt.get(targetId);
    if (openedAt !== undefined && now() - openedAt >= REOPEN_HEALTHY_MS) reopenAttempts.set(targetId, 0);
    const attempt = reopenAttempts.get(targetId) ?? 0;
    const delayMs = reopenDelays[attempt];
    if (delayMs === undefined) {
      sharedStore.setSearchState(targetId, 'stopped', 'live tab lost — run exilium chrome, then restart snipe');
      log(`giving up on "${entry.target.label}" after ${attempt} reopen attempt${attempt === 1 ? '' : 's'}`);
      return;
    }
    reopenAttempts.set(targetId, attempt + 1);
    sharedStore.setSearchState(targetId, 'connecting', `live tab lost — reopening in ${Math.ceil(delayMs / 1_000)}s`);
    reopenChain = reopenChain.then(async () => {
      await waitForSeedRetry(delayMs / 1_000);
      if (stopped || stopIntent) return;
      await openLiveTab(entry);
      if (stopped || stopIntent) return;
      if (!liveTabs.has(targetId)) {
        // The attempt itself failed (Chrome still down) — climb the ladder.
        scheduleReopen(entry);
        return;
      }
      const gapMs = deps.connectStaggerMs ?? BROWSER_LIVE_TAB_GAP_MS;
      if (gapMs > 0) await waitForSeedRetry(gapMs / 1_000);
    }).catch((error: unknown) => {
      log(`browser-live reopen failed: ${error instanceof Error ? error.message : String(error)}`);
    });
    startTask(reopenChain);
  };

  let liveTabsOpened = 0;
  const openLiveTab = async (entry: RuntimeTarget, onSeeded?: () => void): Promise<void> => {
    if (stopped || stopIntent) return;
    const targetId = `${entry.target.realm}:${entry.target.searchId}`;
    sharedStore.setSearchState(targetId, 'connecting');
    try {
      const handle = await (deps.openLiveSearch ?? openBrowserLiveSearch)({
        cdpUrl: config.snipe.chromeCdpUrl,
        search: entry.search,
        log,
        onListings: (listings, source) => {
          if (stopped || stopIntent) return;
          const job = async (): Promise<void> => {
            if (stopped || stopIntent) return;
            // Seeds wait for the reward floors (warming the cache before live
            // traffic) — but only briefly: a slow lookup must never stall the
            // chain into delaying a live hit queued behind it. Live hits use
            // cached floors only; anything missing warms in the background.
            const floors = source === 'seed'
              ? await Promise.race([
                collectRewardFloors(listings),
                new Promise<ReadonlyMap<string, RewardFloorPrice>>((resolve) =>
                  setTimeout(() => resolve(cachedRewardFloors(listings)), 2_000)),
              ])
              : cachedRewardFloors(listings);
            if (stopped || stopIntent) return;
            processListings(entry, listings, source, true, floors);
          };
          entry.chain = entry.chain.then(job, job).catch((error: unknown) => {
            log(`browser-live listing processing failed: ${error instanceof Error ? error.message : String(error)}`);
          });
          startTask(entry.chain);
        },
        onDisconnect: () => {
          liveTabs.delete(targetId);
          if (stopped || stopIntent) return;
          log(`browser-live tab for "${entry.target.label}" disconnected`);
          scheduleReopen(entry);
        },
        onPage: (page) => {
          if (page.evaluate !== undefined) floorEvaluate = page.evaluate.bind(page);
        },
        ...(onSeeded === undefined ? {} : { onSeeded }),
        ...(config.snipe.framePing ? {
          onLiveFrame: (newCount: number) => {
            if (stopped || stopIntent) return;
            // The stream just announced listings — details are still in
            // flight, but the bell can ring NOW.
            try { process.stdout.write('\u0007'); } catch { /* stdout may be gone */ }
            log(`frame ping: ${newCount} incoming on "${entry.target.label}"`);
          },
        } : {}),
      });
      if (stopped || stopIntent) {
        void handle.close().catch(() => undefined);
        return;
      }
      liveTabs.set(targetId, handle);
      liveTabOpenedAt.set(targetId, now());
      if (handle.page.evaluate !== undefined) floorEvaluate = handle.page.evaluate.bind(handle.page);
      liveTabsOpened += 1;
      sharedStore.setProgress(liveTabsOpened, runtimeTargets.length);
      sharedStore.setSearchState(targetId, 'live');
    } catch (error) {
      sharedStore.setSearchState(targetId, 'stopped', 'Chrome unavailable — run exilium chrome');
      log(`could not open a browser-live tab for "${entry.target.label}": ${error instanceof Error ? error.message : String(error)}`);
    }
  };

  const connectTarget = (entry: RuntimeTarget): void => {
    const { target, search } = entry;
    if (stopped || stopIntent) return;
    let consecutiveFailures = 0;
    const connect = (): void => {
      if (stopped || stopIntent) return;
      const socket = openSocket!(search, headers);
      sockets.add(socket);
      socket.on('open', () => {
        consecutiveFailures = 0;
        sharedStore.setSearchState(`${target.realm}:${target.searchId}`, 'live');
      });
      socket.on('message', (data) => {
        const task = (async () => {
          try {
            const message = JSON.parse(data.toString()) as { new?: string[] };
            await processIds(entry, message.new ?? [], 'live');
          } catch (error) {
            log(error instanceof Error ? error.message : String(error));
          }
        })();
        startTask(task);
      });
      socket.on('close', (code) => {
        sockets.delete(socket);
        if (stopped || stopIntent) return;
        consecutiveFailures += 1;
        if (consecutiveFailures >= 5) {
          sharedStore.setSearchState(`${target.realm}:${target.searchId}`, 'stopped', `socket failed ${consecutiveFailures} times`);
          log(`socket for "${target.label}" failed ${consecutiveFailures} times — giving up on this search`);
          return;
        }
        const delay = Math.min(300_000, 30_000 * 2 ** (consecutiveFailures - 1));
        sharedStore.setSearchState(`${target.realm}:${target.searchId}`, 'reconnecting', `${Math.round(delay / 1_000)}s`);
        log(`socket for "${target.label}" closed (${code}) — reconnecting in ${Math.round(delay / 1_000)}s`);
        const timer = setTimeout(() => {
          timers.delete(timer);
          connect();
        }, delay);
        timers.add(timer);
      });
      socket.on('error', (error) => {
        log(`socket error for "${target.label}": ${error.message}${error.message.includes('401') ? ' — check EXILIUM_POESESSID' : ''}`);
      });
    };
    connect();
  };

  const waitForSeedRetry = (seconds: number): Promise<void> => new Promise((resolve) => {
    if (networkAbort.signal.aborted) {
      resolve();
      return;
    }
    const timer = setTimeout(done, seconds * 1_000);
    timers.add(timer);
    function done(): void {
      clearTimeout(timer);
      timers.delete(timer);
      networkAbort.signal.removeEventListener('abort', done);
      resolve();
    }
    networkAbort.signal.addEventListener('abort', done, { once: true });
  });

  const seedCurrentResults = async (): Promise<void> => {
    let seededTargets = 0;
    for (const entry of runtimeTargets) {
      if (stopped || stopIntent) return;
      const targetId = `${entry.target.realm}:${entry.target.searchId}`;
      sharedStore.setSearchState(targetId, 'seeding');
      for (;;) {
        try {
          const ids = await fetchCurrentResultIds(entry.search, sessionId, networkAbort.signal);
          const queued = await processIds(entry, ids.slice(0, 10), 'seed');
          if (!stopped && !stopIntent) log(`seeded ${queued} current listing${queued === 1 ? '' : 's'} for ${entry.target.label}`);
          seededTargets += 1;
          sharedStore.setProgress(seededTargets, runtimeTargets.length);
          sharedStore.setSearchState(targetId, 'live');
          break;
        } catch (error) {
          if (stopped || stopIntent || networkAbort.signal.aborted) return;
          if (error instanceof RateLimitError) {
            sharedStore.setSearchState(targetId, 'cooldown', `${error.retryAfterSec}s`);
            log(`trade search limit reached while seeding ${entry.target.label}; retrying in ${error.retryAfterSec}s`);
            await waitForSeedRetry(error.retryAfterSec);
            sharedStore.setSearchState(targetId, 'seeding');
            continue;
          }
          const message = error instanceof Error ? error.message : String(error);
          const authRequired = /401|403|POESESSID|session/i.test(message);
          sharedStore.setSearchState(
            targetId,
            authRequired ? 'auth-required' : 'live',
            authRequired ? 'run exilium setup' : 'startup seed failed; live monitoring remains active',
          );
          log(`could not seed current listings for ${entry.target.label} (${error instanceof Error ? error.message : String(error)}); live monitoring remains active`);
          break;
        }
      }
    }
  };

  const cleanup = async (): Promise<void> => {
    if (stopped) return;
    stopped = true;
    unsubscribeScheduler();
    shutdownRequested = true;
    networkAbort.abort();
    refreshAbort.abort();
    for (const timer of timers) clearTimeout(timer);
    timers.clear();
    if (refreshTimer !== undefined) clearInterval(refreshTimer);
    if (rateHealthTimer !== undefined) clearInterval(rateHealthTimer);
    if (reconcileTimer !== undefined) clearInterval(reconcileTimer);
    soundPlayer?.close();
    for (const socket of sockets) socket.close();
    sockets.clear();
    const settleWithin = async (
      promise: Promise<unknown>,
      milliseconds = deps.shutdownTimeoutMs ?? 2_000,
    ): Promise<void> => {
      await new Promise<void>((resolve) => {
        const timer = setTimeout(resolve, milliseconds);
        void promise.then(
          () => { clearTimeout(timer); resolve(); },
          () => { clearTimeout(timer); resolve(); },
        );
      });
    };
    await settleWithin(Promise.allSettled([...pending]));
    if (liveTabs.size > 0) {
      const tabs = [...liveTabs.values()];
      liveTabs.clear();
      await settleWithin(Promise.allSettled(tabs.map((tab) => tab.close())));
    }
    if (refreshTask !== undefined) await settleWithin(refreshTask);
    if (controllerPromise !== undefined) {
      let controller: TravelController | undefined;
      await settleWithin(controllerPromise.then((resolved) => { controller = resolved; }));
      if (controller !== undefined) await settleWithin(controller.close());
    }
    consoleHandle?.close();
  };

  const onSigint = (): void => requestStop();
  process.once('SIGINT', onSigint);
  try {
    for (const message of snipeStartupMessages(runnable.length, league, minMarginPct, browserLive)) out(message);
    for (const { target } of runnable) out(`  ${target.label} (${target.searchId})`);

    consoleHandle = (deps.makeConsole ?? ((options) => renderSnipeConsole(options)))({
      onTravel,
      onExit: requestStop,
      now,
      searchCount: runnable.length,
      store: sharedStore,
      ...(minMarginPct === null ? {} : { minMarginPct }),
    });
    rateHealthTimer = setInterval(() => publishSchedulerHealth(tradeScheduler.health()), 1_000);

    // Boot prewarm from whatever the DB already holds: the first seeds land
    // seconds after the first tab opens, usually before the boot refresh has
    // finished — they must find a warm cache, not pay the full parse.
    try { latestSnapshots(league); } catch { /* fresh DB — the refresh fills it */ }
    startRefresh();
    refreshTimer = setInterval(startRefresh, config.refreshSec * 1_000);
    if (browserLive) {
      const tabGapMs = deps.connectStaggerMs ?? BROWSER_LIVE_TAB_GAP_MS;
      startTask((async () => {
        await (deps.closeOrphanTabs ?? closeOrphanBlankTabs)(config.snipe.chromeCdpUrl, log);
        for (const [index, entry] of runtimeTargets.entries()) {
          if (stopped || stopIntent) return;
          // Pipeline the ramp: the budgeted search POST happens at the plain
          // page load, so once THIS tab has seeded, the next tab may start
          // while this one settles and switches to /live. With many searches
          // this cuts the ramp roughly in half.
          let signalSeeded: () => void = () => undefined;
          const seeded = new Promise<void>((resolve) => { signalSeeded = resolve; });
          const opened = openLiveTab(entry, signalSeeded);
          startTask(opened);
          await Promise.race([seeded, opened]);
          if (index < runtimeTargets.length - 1 && tabGapMs > 0) {
            await waitForSeedRetry(tabGapMs / 1_000);
          }
        }
      })());
      // Safety net: every sweep compares the rows each tab actually shows
      // against what the CLI processed, recovers anything the capture missed
      // (evicted bodies, CDP hiccups), and revives live searches the site
      // quietly deactivated. Fresh recoveries ping; stale ones queue quietly.
      let reconcileRunning = false;
      const reconcileTabs = async (): Promise<void> => {
        // Never overlap sweeps: with many tabs a slow evaluate could outlast
        // the interval and pile concurrent sweeps into a lag spiral.
        if (reconcileRunning) return;
        reconcileRunning = true;
        try {
          await reconcileTabsOnce();
        } finally {
          reconcileRunning = false;
        }
      };
      const reconcileTabsOnce = async (): Promise<void> => {
        for (const entry of runtimeTargets) {
          if (stopped || stopIntent) return;
          const targetId = `${entry.target.realm}:${entry.target.searchId}`;
          const tab = liveTabs.get(targetId);
          if (tab?.page.evaluate === undefined) continue;
          try {
            const result = await tab.page.evaluate(reconcileExpression()) as { ids?: unknown; deactivated?: unknown } | null;
            if (result === null || typeof result !== 'object') continue;
            if (result.deactivated === true) {
              log(`browser-live: live search for "${entry.target.label}" had deactivated — clicked it back on`);
            }
            const ids = Array.isArray(result.ids)
              ? result.ids.filter((id): id is string => typeof id === 'string')
              : [];
            const missed = ids.filter((id) => !entry.seen.has(id)).slice(0, 10);
            if (missed.length === 0) continue;
            log(`browser-live: recovering ${missed.length} listing(s) the capture missed for "${entry.target.label}"`);
            const body = await tab.page.evaluate(recoverDetailsExpression(entry.search.searchId, missed));
            if (typeof body !== 'string') continue;
            const listings = parseFetchResponseBody(JSON.parse(body), (message) => log(`browser-live: ${message}`));
            const freshCutoff = now() - 90_000;
            const freshOnes = listings.filter((listing) => listing.listedAt !== null && Date.parse(listing.listedAt) > freshCutoff);
            const staleOnes = listings.filter((listing) => !freshOnes.includes(listing));
            if (staleOnes.length > 0) processListings(entry, staleOnes, 'seed', true, cachedRewardFloors(staleOnes));
            if (freshOnes.length > 0) processListings(entry, freshOnes, 'live', true, cachedRewardFloors(freshOnes));
          } catch (error) {
            log(`browser-live: reconcile failed for "${entry.target.label}": ${error instanceof Error ? error.message : String(error)}`);
          }
        }
      };
      reconcileTimer = setInterval(() => startTask(reconcileTabs()), RECONCILE_INTERVAL_MS);
    } else {
      const stagger = deps.connectStaggerMs ?? CONNECT_STAGGER_MS;
      runtimeTargets.forEach((entry, index) => {
        const delay = index * stagger;
        if (delay === 0) connectTarget(entry);
        else {
          const timer = setTimeout(() => {
            timers.delete(timer);
            connectTarget(entry);
          }, delay);
          timers.add(timer);
        }
      });
      startTask(seedCurrentResults());
    }
    await Promise.race([consoleHandle.waitUntilExit().then(() => undefined), stopRequested]);
  } finally {
    process.removeListener('SIGINT', onSigint);
    if (lock.acquired) releaseSnipeLock(lock.path, process.pid);
    await cleanup();
  }
}
