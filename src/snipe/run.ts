import { appendFileSync, existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import type { ExiliumConfig } from '../config.js';
import { ingestLeague } from '../ingest/ingest.js';
import { NinjaClient } from '../sources/ninja/client.js';
import type { SnapshotRepository } from '../storage/snapshot-repository.js';
import {
  buildLiveWsUrl,
  fetchListings as fetchTradeListings,
  type LiveListing,
  type TradeSearch,
} from '../trade/live-search.js';
import { createNotifier } from '../watch/notify.js';
import {
  loadSnipeFolder,
  readSnipeFolderFiles,
  resolveSnipeFolder,
  scaffoldSnipeFolder,
  type SnipeTarget,
} from './bettertrading.js';
import { createTravelController, type TravelController } from './browser.js';
import {
  promptSnipeTargets,
  renderSnipeConsole,
  type SnipeConsoleHandle,
  type SnipeConsoleOptions,
} from './console.js';
import { buildSearchPageUrl, decideSnipe, formatAlert, type SnipeAlert } from './engine.js';
import { effectiveLeague, resolveSnipeLeague } from './league.js';
import { assessMargin } from './margin.js';
import { resolveRequestedTargets } from './selection.js';
import type { TravelResult } from './travel.js';
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
) => Promise<readonly LiveListing[]>;

export interface SnipeDeps {
  readonly config: ExiliumConfig;
  readonly repo: SnapshotRepository;
  readonly out: (message: string) => void;
  readonly log: (message: string) => void;
  readonly isTTY?: boolean;
  readonly promptTargets?: typeof promptSnipeTargets;
  readonly makeConsole?: (options: SnipeConsoleOptions) => SnipeConsoleHandle;
  readonly makeTravelController?: typeof createTravelController;
  readonly openSocket?: OpenSnipeSocket;
  readonly fetchListings?: FetchSnipeListings;
  readonly refreshPrices?: () => Promise<void>;
  readonly notify?: (title: string, body: string) => Promise<void>;
  readonly recordAlert?: (alert: SnipeAlert, action: string, detail: string) => void;
  readonly now?: () => number;
  readonly connectStaggerMs?: number;
}

export const MAX_SNIPE_SOCKETS = 20;
const CONNECT_STAGGER_MS = 500;
const NO_PRIOR_LISTINGS: ReadonlySet<string> = new Set();

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

function selectedLeagueFlag(config: ExiliumConfig, flag: string | undefined): string | undefined {
  const requested = flag ?? config.snipe.league;
  return requested?.toLowerCase() === 'current' ? undefined : requested;
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
    out('Import a Better Trading folder export with `exilium snipe import`, then rerun.');
    return;
  }

  const allTargets = loadSnipeFolder(readSnipeFolderFiles(folder), log);
  if (allTargets.length === 0) {
    out(`${folder} holds no usable trade searches. Add trade URLs or run \`exilium snipe import\`.`);
    return;
  }

  const requested = resolveRequestedTargets(allTargets, {
    isTTY: deps.isTTY ?? process.stdin.isTTY === true,
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

  const league = await resolveSnipeLeague(config, selectedLeagueFlag(config, flags.league), log);
  const minMarginPct = flags.minMargin === undefined ? config.snipe.minMarginPct : Number(flags.minMargin);
  if (minMarginPct !== null && Number.isNaN(minMarginPct)) {
    throw new Error('--min-margin must be a number (percent)');
  }

  const runnable: RunnableTarget[] = [];
  for (const target of selected.slice(0, MAX_SNIPE_SOCKETS)) {
    const targetLeague = effectiveLeague(target, league, flags.keepLeague);
    if (targetLeague === null) {
      log(`skipping "${target.label}": PoE2 search without a league in its source`);
      continue;
    }
    runnable.push({
      target,
      search: { realm: target.realm, league: targetLeague, searchId: target.searchId },
    });
  }
  if (selected.length > MAX_SNIPE_SOCKETS) {
    log(`Selected ${selected.length} searches; enabling the first ${MAX_SNIPE_SOCKETS} because the trade site caps live searches per account.`);
  }
  if (runnable.length === 0) {
    out('None of the selected searches can run in the resolved league.');
    return;
  }

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
  let controllerPromise: Promise<TravelController> | undefined;
  const ensureController = (): Promise<TravelController> => {
    if (controllerPromise === undefined) {
      controllerPromise = makeController({
        cdpUrl: config.snipe.chromeCdpUrl,
        profileDir: config.snipe.chromeProfile ?? join(homedir(), '.exilium', 'browser-profile'),
        log,
      }).catch((error: unknown) => {
        controllerPromise = undefined;
        throw error;
      });
    }
    return controllerPromise;
  };

  const recordWebhook = (alert: SnipeAlert, action: string, detail: string): void => {
    record(alert, action, detail);
    if (config.snipe.webhookUrl !== undefined) {
      const payload = buildSnipeWebhookPayload(alert, action, detail, new Date(now()).toISOString());
      void postSnipeWebhook(config.snipe.webhookUrl, payload, (url, init) => fetch(url, init), log);
    }
  };

  const onTravel = async (alert: SnipeAlert): Promise<TravelResult> => {
    try {
      const result = await (await ensureController()).travel(alert);
      recordWebhook(alert, result.action, result.detail);
      return result;
    } catch (error) {
      const detail = `${error instanceof Error ? error.message : String(error)}. Run \`exilium chrome\`, log into pathofexile.com, then press r to retry.`;
      const result: TravelResult = { action: 'failed', detail };
      recordWebhook(alert, result.action, result.detail);
      return result;
    }
  };

  let requestStop!: () => void;
  const stopRequested = new Promise<void>((resolve) => { requestStop = resolve; });
  const consoleHandle = (deps.makeConsole ?? ((options) => renderSnipeConsole(options)))({
    onTravel,
    onExit: requestStop,
    now,
  });

  let stopped = false;
  const sockets = new Set<SnipeSocket>();
  const timers = new Set<ReturnType<typeof setTimeout>>();
  const pending = new Set<Promise<void>>();
  let refreshTimer: ReturnType<typeof setInterval> | undefined;

  const refresh = deps.refreshPrices ?? (async () => {
    try {
      const result = await ingestLeague(new NinjaClient({ userAgent: config.userAgent }), repo, {
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

  let openSocket = deps.openSocket;
  if (openSocket === undefined) {
    const { default: WebSocket } = await import('ws');
    openSocket = (search, headers) => new WebSocket(buildLiveWsUrl(search), { headers: { ...headers } }) as unknown as SnipeSocket;
  }
  const fetchListings = deps.fetchListings ?? ((ids, search, sid) =>
    fetchTradeListings(ids, search, sid, { fetchFn: (url, init) => fetch(url, init) }));

  const headers = {
    Cookie: `POESESSID=${sessionId}`,
    'User-Agent': config.userAgent,
    Origin: 'https://www.pathofexile.com',
  };

  const startTask = (task: Promise<void>): void => {
    pending.add(task);
    void task.finally(() => pending.delete(task));
  };

  const connectTarget = ({ target, search }: RunnableTarget): void => {
    if (stopped) return;
    const seen = new Set<string>();
    let consecutiveFailures = 0;
    const connect = (): void => {
      if (stopped) return;
      const socket = openSocket!(search, headers);
      sockets.add(socket);
      socket.on('open', () => {
        consecutiveFailures = 0;
        out(`watching ${target.label} — ${search.league}/${search.searchId}`);
      });
      socket.on('message', (data) => {
        const task = (async () => {
          try {
            const message = JSON.parse(data.toString()) as { new?: string[] };
            const fresh = (message.new ?? []).filter((id) => !seen.has(id));
            if (fresh.length === 0) return;
            for (const id of fresh) seen.add(id);
            const listings = await fetchListings(fresh, search, sessionId);
            const snapshots = repo.latestAll(config.game, search.league);
            for (const listing of listings) {
              const decision = decideSnipe({
                listing,
                target,
                assessment: assessMargin({ itemName: listing.referenceName, price: listing.price, snapshots, nowMs: now() }),
                snapshots,
                globalMinMarginPct: minMarginPct,
                league: search.league,
                seen: NO_PRIOR_LISTINGS,
              });
              if (decision.kind === 'suppressed') {
                log(`skip ${listing.itemName}: ${decision.reason}`);
                continue;
              }
              const alert = decision.alert;
              const rendered = formatAlert(alert);
              consoleHandle.addAlert(alert);
              sound();
              void notify!(rendered.title, rendered.body);
              recordWebhook(alert, 'queued', 'waiting for Enter');
            }
          } catch (error) {
            log(error instanceof Error ? error.message : String(error));
          }
        })();
        startTask(task);
      });
      socket.on('close', (code) => {
        sockets.delete(socket);
        if (stopped) return;
        consecutiveFailures += 1;
        if (consecutiveFailures >= 5) {
          log(`socket for "${target.label}" failed ${consecutiveFailures} times — giving up on this search`);
          return;
        }
        const delay = Math.min(300_000, 30_000 * 2 ** (consecutiveFailures - 1));
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

  const cleanup = async (): Promise<void> => {
    if (stopped) return;
    stopped = true;
    for (const timer of timers) clearTimeout(timer);
    timers.clear();
    if (refreshTimer !== undefined) clearInterval(refreshTimer);
    for (const socket of sockets) socket.close();
    sockets.clear();
    await Promise.allSettled([...pending]);
    if (controllerPromise !== undefined) {
      const controller = await controllerPromise.catch(() => undefined);
      await controller?.close();
    }
    consoleHandle.close();
  };

  const onSigint = (): void => requestStop();
  process.once('SIGINT', onSigint);
  try {
    out(`Exilium snipe — ${runnable.length} enabled search${runnable.length === 1 ? '' : 'es'} · league ${league} · min margin ${minMarginPct ?? 'off'}`);
    out('Live hits enter the queue. Select one and press Enter to click Travel to Hideout; no whisper is sent or copied.');
    for (const { target } of runnable) out(`  ${target.label} (${target.searchId})`);

    // Visible confirmation of the enabled configuration: claim one page and
    // show the first selected search. Every later action reuses this page.
    try {
      const first = runnable[0]!;
      await (await ensureController()).openSearch(buildSearchPageUrl(first.target, first.search.league));
    } catch (error) {
      log(`Could not open the enabled search in Chrome (${error instanceof Error ? error.message : String(error)}). Run \`exilium chrome\`; alerts will keep queuing.`);
    }

    void refresh();
    refreshTimer = setInterval(() => void refresh(), config.refreshSec * 1_000);
    const stagger = deps.connectStaggerMs ?? CONNECT_STAGGER_MS;
    runnable.forEach((entry, index) => {
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
    await Promise.race([consoleHandle.waitUntilExit().then(() => undefined), stopRequested]);
  } finally {
    process.removeListener('SIGINT', onSigint);
    await cleanup();
  }
}
