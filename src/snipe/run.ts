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
import { createNotifier } from '../watch/notify.js';
import {
  resolveSnipeFolder,
  scaffoldSnipeFolder,
  type SnipeTarget,
} from './bettertrading.js';
import { createTravelController, type TravelController } from './browser.js';
import { loadSnipeCatalog } from './catalog.js';
import {
  promptSnipeTargets,
  renderSnipeConsole,
  type SnipeConsoleHandle,
  type SnipeConsoleOptions,
} from './console.js';
import { decideSnipe, formatAlert, type SnipeAlert } from './engine.js';
import { effectiveLeague, resolveSnipeLeague, type FetchLeaguesFn } from './league.js';
import { assessMargin } from './margin.js';
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
}

export const MAX_SNIPE_SOCKETS = 20;
const CONNECT_STAGGER_MS = 500;
const NO_PRIOR_LISTINGS: ReadonlySet<string> = new Set();

export function snipeStartupMessages(
  searchCount: number,
  league: string,
  minMarginPct: number | null,
): readonly string[] {
  return [
    `Exilium snipe — ${searchCount} enabled search${searchCount === 1 ? '' : 'es'} · league ${league} · min margin ${minMarginPct ?? 'off'}`,
    'Monitoring is headless. Current results seed quietly; new live hits notify.',
    'Chrome is only needed after you press Enter to travel; no whisper is sent or copied.',
  ];
}

function snipeLogPath(): string {
  return join(homedir(), '.exilium', 'snipes.jsonl');
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

  const sessionId = config.poesessid;
  if (sessionId === undefined || sessionId === '') {
    throw new Error(
      'No session cookie configured. Run `exilium setup`, or set EXILIUM_POESESSID for this run. The cookie stays on this machine and is sent only to pathofexile.com.',
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
  })), { minMarginPct: minMarginPct ?? 20 });

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

  const onTravel = async (alert: SnipeAlert): Promise<TravelResult> => {
    try {
      const result = await (await ensureController()).travel(alert);
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
  const consoleHandle = (deps.makeConsole ?? ((options) => renderSnipeConsole(options)))({
    onTravel,
    onExit: requestStop,
    now,
    searchCount: runnable.length,
    store: sharedStore,
    ...(minMarginPct === null ? {} : { minMarginPct }),
  });

  let stopped = false;
  const sockets = new Set<SnipeSocket>();
  const timers = new Set<ReturnType<typeof setTimeout>>();
  const pending = new Set<Promise<void>>();
  let refreshTimer: ReturnType<typeof setInterval> | undefined;

  const refreshAbort = new AbortController();
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
        itemsMinIntervalSec: Math.max(300, config.refreshSec),
      });
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
    }));
  const fetchCurrentResultIds = deps.fetchCurrentResultIds ?? ((search, sid, signal) =>
    fetchTradeCurrentResultIds(search, sid, {
      fetchFn: (url, init) => fetch(url, init),
      ...(signal === undefined ? {} : { signal }),
    }));
  const runtimeTargets: readonly RuntimeTarget[] = runnable.map((entry) => ({
    ...entry,
    seen: new Set<string>(),
    inFlight: new Set<string>(),
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
      const snapshots = repo.latestAll(config.game, entry.search.league);
      let queued = 0;
      for (const listing of listings) {
        if (stopped || stopIntent) return queued;
        const decision = decideSnipe({
          listing,
          target: entry.target,
          assessment: assessMargin({ itemName: listing.referenceName, price: listing.price, snapshots, nowMs: now() }),
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
        consoleHandle.addAlert(alert);
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
    } finally {
      for (const id of fresh) entry.inFlight.delete(id);
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
        out(`watching ${target.label} — ${search.league}/${search.searchId}`);
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
    shutdownRequested = true;
    networkAbort.abort();
    refreshAbort.abort();
    for (const timer of timers) clearTimeout(timer);
    timers.clear();
    if (refreshTimer !== undefined) clearInterval(refreshTimer);
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
    if (refreshTask !== undefined) await settleWithin(refreshTask);
    if (controllerPromise !== undefined) {
      let controller: TravelController | undefined;
      await settleWithin(controllerPromise.then((resolved) => { controller = resolved; }));
      if (controller !== undefined) await settleWithin(controller.close());
    }
    consoleHandle.close();
  };

  const onSigint = (): void => requestStop();
  process.once('SIGINT', onSigint);
  try {
    for (const message of snipeStartupMessages(runnable.length, league, minMarginPct)) out(message);
    for (const { target } of runnable) out(`  ${target.label} (${target.searchId})`);

    startRefresh();
    refreshTimer = setInterval(startRefresh, config.refreshSec * 1_000);
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
    await Promise.race([consoleHandle.waitUntilExit().then(() => undefined), stopRequested]);
  } finally {
    process.removeListener('SIGINT', onSigint);
    await cleanup();
  }
}
