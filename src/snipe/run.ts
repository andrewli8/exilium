import { appendFileSync, existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import type { ExiliumConfig } from '../config.js';
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
  type BrowserLiveSearchHandle,
} from './browser-live.js';
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
import { assessMargin, assessMarginAgainstFloor, toChaos } from './margin.js';
import { persistSnipeImport } from './import.js';
import { resolveRequestedTargets } from './selection.js';
import type { TravelResult } from './travel.js';
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
}

export const MAX_SNIPE_SOCKETS = 20;
const CONNECT_STAGGER_MS = 500;
/** Pause between browser-live tab opens. Each tab's plain-page load runs a
 * real search under the user's session, and the site budgets those tightly —
 * tabs must open one at a time with breathing room, never all at once. */
const BROWSER_LIVE_TAB_GAP_MS = 4_000;
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

function snipeLogPath(): string {
  return join(homedir(), '.exilium', 'snipes.jsonl');
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
  /** Chaos price of every listing seen on this search, keyed by listing id.
   * The minimum (excluding the listing being judged) is the search floor —
   * the reference for listings poe.ninja cannot index. */
  readonly knownPrices: Map<string, number>;
}

const MAX_KNOWN_PRICES = 200;

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
  const record = deps.recordAlert ?? ((alert, action, detail) => recordSnipe(alert, action, detail, log));
  let notify = deps.notify;
  let sound = (): void => undefined;
  if (notify === undefined || config.snipe.sound) {
    const { execFile } = await import('node:child_process');
    const { promisify } = await import('node:util');
    const exec = promisify(execFile);
    const execFn = async (command: string, args: readonly string[]): Promise<unknown> => exec(command, [...args]);
    notify ??= createNotifier({
      platform: process.platform,
      execFn,
      fetchFn: (url, init) => fetch(url, init),
      webhookUrl: config.webhookUrl,
      log,
    }).notify;
    if (config.snipe.sound) {
      sound = () => {
        if (process.platform === 'darwin') void execFn('afplay', ['/System/Library/Sounds/Glass.aiff']).catch(() => undefined);
        else if (process.platform === 'win32') {
          void execFn('powershell', ['-NoProfile', '-Command', '[System.Media.SystemSounds]::Asterisk.Play()']).catch(() => undefined);
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
        if (shutdownRequested) void controller.close();
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
        categories: config.categories,
        now: () => new Date(now()).toISOString(),
        ...(bootRefreshDone
          ? { itemsMinIntervalSec: Math.max(300, config.refreshSec) }
          : { minIntervalSec: 0, itemsMinIntervalSec: 0 }),
      });
      bootRefreshDone = true;
      if (result.saved.length > 0) log(`refreshed ${result.saved.length} categories`);
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

  const processListings = (
    entry: RuntimeTarget,
    listings: readonly LiveListing[],
    source: 'seed' | 'live',
    dedupe: boolean,
  ): number => {
    const fresh = dedupe ? listings.filter((listing) => !entry.seen.has(listing.id)) : listings;
    if (fresh.length === 0) return 0;
    if (dedupe) for (const listing of fresh) entry.seen.add(listing.id);
    const snapshots = repo.latestAll(config.game, entry.search.league);
    let queued = 0;
    for (const listing of fresh) {
      if (stopped || stopIntent) return queued;
      let assessment = assessMargin({ itemName: listing.referenceName, price: listing.price, snapshots, nowMs: now() });
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
      consoleHandle?.addAlert(alert);
      sharedStore.ingest(alert);
      queued += 1;
      if (source === 'live' && alert.qualifiesMargin) {
        const rendered = formatAlert(alert);
        sound();
        void notify!(rendered.title, rendered.body);
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

  let liveTabsOpened = 0;
  const openLiveTab = async (entry: RuntimeTarget): Promise<void> => {
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
          processListings(entry, listings, source, true);
        },
        onDisconnect: () => {
          liveTabs.delete(targetId);
          if (stopped || stopIntent) return;
          sharedStore.setSearchState(targetId, 'stopped', 'live tab lost — run exilium chrome, then restart snipe');
          log(`browser-live tab for "${entry.target.label}" disconnected`);
        },
      });
      if (stopped || stopIntent) {
        void handle.close();
        return;
      }
      liveTabs.set(targetId, handle);
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

    startRefresh();
    refreshTimer = setInterval(startRefresh, config.refreshSec * 1_000);
    if (browserLive) {
      const tabGapMs = deps.connectStaggerMs ?? BROWSER_LIVE_TAB_GAP_MS;
      startTask((async () => {
        for (const [index, entry] of runtimeTargets.entries()) {
          if (stopped || stopIntent) return;
          await openLiveTab(entry);
          if (index < runtimeTargets.length - 1 && tabGapMs > 0) {
            await waitForSeedRetry(tabGapMs / 1_000);
          }
        }
      })());
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
    await cleanup();
  }
}
