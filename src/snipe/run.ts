import { appendFileSync, existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import type { ExiliumConfig } from '../config.js';
import { ingestLeague } from '../ingest/ingest.js';
import { NinjaClient } from '../sources/ninja/client.js';
import type { SnapshotRepository } from '../storage/snapshot-repository.js';
import { buildLiveWsUrl, fetchListings, type TradeSearch } from '../trade/live-search.js';
import { effectiveLeague, resolveSnipeLeague } from './league.js';
import { createNotifier } from '../watch/notify.js';
import { copyToClipboard, openUrl } from '../platform.js';
import {
  loadSnipeFolder,
  readSnipeFolderFiles,
  resolveSnipeFolder,
  scaffoldSnipeFolder,
} from './bettertrading.js';
import { assessMargin } from './margin.js';
import { decideSnipe, formatAlert, type SnipeAlert } from './engine.js';
import { dispatchTravel, resolveTravelMode, type TravelPage } from './travel.js';

/** The `exilium snipe` session: every search in the BetterTrading folder on
 * a live websocket, margins from local poe.ninja snapshots kept fresh in the
 * background, instant notifications, ping-only or (double-gated) auto-travel.
 *
 * The decision core is pure and tested (engine/margin/travel); this file is
 * the plumbing: sockets, timers, notifier, and the browser handle. */

export interface SnipeFlags {
  readonly folder: string | undefined;
  readonly league: string | undefined;
  readonly keepLeague: boolean;
  readonly minMargin: string | undefined;
  readonly mode: string | undefined;
  readonly autoTravel: boolean;
  readonly open: boolean;
}

/** GGG allows a bounded number of live-search sockets per account. */
const MAX_SOCKETS = 20;
const CONNECT_STAGGER_MS = 500;

interface SnipeDeps {
  readonly config: ExiliumConfig;
  readonly repo: SnapshotRepository;
  readonly out: (message: string) => void;
  readonly log: (message: string) => void;
}

function snipeLogPath(): string {
  return join(homedir(), '.exilium', 'snipes.jsonl');
}

function recordSnipe(alert: SnipeAlert, action: string, detail: string, log: (m: string) => void): void {
  try {
    const entry = { ts: new Date().toISOString(), ...alert, action, detail };
    appendFileSync(snipeLogPath(), `${JSON.stringify(entry)}\n`);
  } catch (err) {
    log(`could not append to ${snipeLogPath()}: ${err instanceof Error ? err.message : err}`);
  }
}

function playSound(config: ExiliumConfig, execFn: (cmd: string, args: readonly string[]) => Promise<unknown>): void {
  if (!config.snipe.sound || process.platform !== 'darwin') return;
  execFn('afplay', ['/System/Library/Sounds/Glass.aiff']).catch(() => undefined);
}

export async function runSnipe(flags: SnipeFlags, deps: SnipeDeps): Promise<void> {
  const { config, repo, out, log } = deps;
  const sessionId = config.poesessid;
  if (sessionId === undefined || sessionId === '') {
    throw new Error(
      'No session cookie configured. Run `exilium setup` (stores it in ~/.exilium/config.json, chmod 600), or set EXILIUM_POESESSID for this run. The cookie stays on this machine and is sent only to pathofexile.com.',
    );
  }

  const folder = resolveSnipeFolder({
    flagValue: flags.folder ?? config.snipe.folder,
    env: process.env,
    cwd: process.cwd(),
    home: homedir(),
  });
  if (!existsSync(folder)) {
    const written = scaffoldSnipeFolder(folder);
    out(`No BetterTrading folder yet — created ${folder} with a starter:`);
    for (const p of written) out(`  ${p}`);
    out('Drop your trade links / Better Trading exports in there and rerun `exilium snipe`.');
    return;
  }
  const targets = loadSnipeFolder(readSnipeFolderFiles(folder), log);
  if (targets.length === 0) {
    out(`${folder} holds no usable trade searches yet. Add URLs (one per line in a .txt), Better Trading export strings, or a targets JSON — see its README.txt.`);
    return;
  }

  const league = await resolveSnipeLeague(config, flags.league, log);
  const minMarginPct = flags.minMargin !== undefined ? Number(flags.minMargin) : config.snipe.minMarginPct;
  if (minMarginPct !== null && Number.isNaN(minMarginPct)) throw new Error('--min-margin must be a number (percent)');

  const travel = resolveTravelMode({
    modeFlag: flags.mode,
    autoTravelFlag: flags.autoTravel,
    configuredMode: config.snipe.mode,
    acknowledged: config.snipe.autoTravelAcknowledged,
  });
  if (travel.warning !== undefined) log(travel.warning);

  let page: TravelPage | undefined;
  let closeBrowser: (() => Promise<void>) | undefined;
  if (travel.mode === 'auto') {
    const { createTravelBrowser } = await import('./browser.js');
    const browser = await createTravelBrowser(join(homedir(), '.exilium', 'browser-profile'), log);
    page = browser.page;
    closeBrowser = browser.close;
    process.once('SIGINT', () => {
      void browser.close().finally(() => process.exit(130));
    });
  }

  // Reference prices stay inside the 10-minute freshness window: refresh on
  // start and every refreshSec (floored at 300s; the DB-refereed min
  // interval dedupes across processes). A failed refresh never blocks
  // alerts — they just carry a STALE marker.
  const client = new NinjaClient({ userAgent: config.userAgent });
  const refresh = async (): Promise<void> => {
    try {
      const result = await ingestLeague(client, repo, {
        game: config.game,
        league,
        categories: config.categories,
        now: () => new Date().toISOString(),
      });
      if (result.saved.length > 0) log(`refreshed ${result.saved.length} categories`);
    } catch (err) {
      log(`price refresh failed: ${err instanceof Error ? err.message : err}`);
    }
  };
  await refresh();
  setInterval(() => void refresh(), config.refreshSec * 1000);

  const { execFile } = await import('node:child_process');
  const { promisify } = await import('node:util');
  const exec = promisify(execFile);
  const execFn = async (cmd: string, args: readonly string[]): Promise<unknown> => exec(cmd, [...args]);
  const notifier = createNotifier({
    platform: process.platform,
    execFn,
    fetchFn: (url, init) => fetch(url, init),
    webhookUrl: config.webhookUrl,
    log,
  });

  const runnable = targets.slice(0, MAX_SOCKETS);
  if (targets.length > MAX_SOCKETS) {
    log(`folder holds ${targets.length} searches; watching the first ${MAX_SOCKETS} (the trade site caps live searches per account). Trim the folder to choose.`);
  }

  out(`Exilium snipe — ${runnable.length} searches · league ${league} · min margin ${minMarginPct ?? 'off'} · mode ${travel.mode}`);
  out('Whispers are copied to your clipboard the moment a listing lands. Ctrl+C to stop.');
  for (const t of runnable) out(`  · ${t.label} (${t.searchId})`);

  const { default: WebSocket } = await import('ws');
  const wsHeaders = {
    Cookie: `POESESSID=${sessionId}`,
    'User-Agent': config.userAgent,
    Origin: 'https://www.pathofexile.com',
  };

  const handleAlert = async (alert: SnipeAlert): Promise<void> => {
    const rendered = formatAlert(alert);
    if (alert.whisper !== '') {
      try {
        await copyToClipboard(alert.whisper, { platform: process.platform });
      } catch (err) {
        log(`clipboard copy failed (${err instanceof Error ? err.message : err}) — whisper: ${alert.whisper}`);
      }
    }
    playSound(config, execFn);
    await notifier.notify(rendered.title, rendered.body);
    out(`[${new Date().toISOString()}] ${rendered.line}`);
    const result = await dispatchTravel(alert, {
      mode: travel.mode,
      openSearchPage: flags.open,
      openUrl: async (url) => {
        openUrl(url, { platform: process.platform });
      },
      ...(page === undefined ? {} : { page }),
    });
    out(`  ${result.action}: ${result.detail}`);
    recordSnipe(alert, result.action, result.detail, log);
  };

  runnable.forEach((target, index) => {
    const targetLeague = effectiveLeague(target, league, flags.keepLeague);
    if (targetLeague === null) {
      log(`skipping "${target.label}": PoE2 search without a league in its URL — snipe cannot guess one.`);
      return;
    }
    const search: TradeSearch = { realm: target.realm, league: targetLeague, searchId: target.searchId };
    const seen = new Set<string>();
    let consecutiveFailures = 0;
    const connect = (): void => {
      const ws = new WebSocket(buildLiveWsUrl(search), { headers: wsHeaders });
      ws.on('open', () => {
        consecutiveFailures = 0;
        out(`watching ${target.label} — ${search.league}/${search.searchId}`);
      });
      ws.on('message', (data: Buffer) => {
        void (async () => {
          try {
            const msg = JSON.parse(data.toString()) as { new?: string[] };
            const fresh = (msg.new ?? []).filter((id) => !seen.has(id));
            if (fresh.length === 0) return;
            const listings = await fetchListings(fresh, search, sessionId, { fetchFn: (url, init) => fetch(url, init) });
            // Reference prices must come from the league the search actually
            // runs under — a --keep-league target in Standard must never be
            // margined against Allflame prices. Off-league targets simply
            // have no local data, so their alerts say "no reference price".
            const snapshots = repo.latestAll(config.game, search.league);
            const nowMs = Date.now();
            for (const listing of listings) {
              const decision = decideSnipe({
                listing,
                target,
                assessment: assessMargin({ itemName: listing.itemName, price: listing.price, snapshots, nowMs }),
                snapshots,
                globalMinMarginPct: minMarginPct,
                league: search.league,
                seen,
              });
              if (decision.kind === 'suppressed') {
                log(`skip ${listing.itemName}: ${decision.reason}`);
              } else {
                await handleAlert(decision.alert);
              }
            }
            for (const id of fresh) seen.add(id);
          } catch (err) {
            log(err instanceof Error ? err.message : String(err));
          }
        })();
      });
      ws.on('close', (code: number) => {
        consecutiveFailures += 1;
        if (consecutiveFailures >= 5) {
          log(`socket for "${target.label}" failed ${consecutiveFailures} times in a row — giving up on this search. Check the URL and your POESESSID, then rerun.`);
          return;
        }
        const delay = Math.min(300_000, 30_000 * 2 ** (consecutiveFailures - 1));
        log(`socket for "${target.label}" closed (${code}) — reconnecting in ${Math.round(delay / 1000)}s`);
        setTimeout(connect, delay);
      });
      ws.on('error', (err: Error) => {
        log(`socket error for "${target.label}": ${err.message}${err.message.includes('401') ? ' — check EXILIUM_POESESSID' : ''}`);
      });
    };
    setTimeout(connect, index * CONNECT_STAGGER_MS);
  });

  // Session summary location so missed toasts are reviewable later.
  out(`Every alert is appended to ${snipeLogPath()}`);
  if (closeBrowser !== undefined) out('Auto-travel browser stays open for the session; Ctrl+C closes it.');
}
