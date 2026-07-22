import { execFile } from 'node:child_process';
import { createServer } from 'node:http';
import { promisify } from 'node:util';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { CATEGORIES_BY_GAME, configFilePath, loadConfig, readFileConfig } from './config.js';
import { formatNumber } from './domain/format-price.js';
import { renderDashboard } from './dashboard/render.js';
import { ingestLeague } from './ingest/ingest.js';
import { buildMcpServer } from './mcp/server.js';
import { ExiliumService } from './mcp/service.js';
import { formatArbTable, formatCategoryTable, formatItemTable, formatJournal, formatOpportunityTable, formatPriceQuote, formatSnapshotTable, formatWatchEvents, formatWatchTable } from './cli/format.js';
import { NinjaClient } from './sources/ninja/client.js';
import { createDb } from './storage/db.js';
import { SnapshotRepository } from './storage/snapshot-repository.js';
import { WatchRepository } from './storage/watch-repository.js';
import { JournalRepository } from './storage/journal-repository.js';
import { OpportunityLogRepository } from './storage/opportunity-log-repository.js';
import { OUTCOMES } from './storage/journal-repository.js';
import type { Outcome } from './storage/journal-repository.js';
import { readFileSync } from 'node:fs';
import { runBacktest } from './backtest/backtest.js';
import { buildSellSheet, parseCounts } from './trade/sellsheet.js';
import { buildLiveWsUrl, handleNewListings, parseTradeUrl } from './trade/live-search.js';
import { diffStash, fetchAllStashItems, valueStash } from './trade/stash.js';
import { makeFakeListingFetch, parseMoves, randomMoves, rng, runWatchSimulation } from './simulate/simulate.js';
import { parseItem } from './trade/parse-item.js';
import { loadStatIndex } from './trade/trade-stats.js';
import { buildTradeQuery, searchListings, tradeUrlFor } from './trade/price-check.js';
import { formatPriceCheck } from './cli/format.js';
import { copyToClipboard, openUrl, readClipboard } from './platform.js';
import { homedir as homedirForStats } from 'node:os';
import { join as joinPath } from 'node:path';
import { StashRepository } from './storage/stash-repository.js';
import { createNotifier } from './watch/notify.js';
import { initialWatchState, watchTick } from './watch/watch.js';

import { readFileSync as readFileSyncForConfig, writeFileSync, chmodSync, statSync } from 'node:fs';
import { isPermissionSafe } from './config.js';
const configPath = configFilePath(process.env);
const fileConfig = readFileConfig(configPath, (p) => readFileSyncForConfig(p, 'utf8'));
// A config file holding a session cookie must never be group/other readable.
// If it drifted (copied, restored from backup), fix it and say so.
if (fileConfig.poesessid !== undefined && process.platform !== 'win32') {
  // Unix file permissions don't apply on Windows (NTFS ACLs are separate),
  // so this guard is a no-op there.
  try {
    const mode = statSync(configPath).mode & 0o777;
    if (!isPermissionSafe(mode)) {
      chmodSync(configPath, 0o600);
      console.error(`Warning: ${configPath} was readable by other users (mode ${mode.toString(8)}) and holds your session cookie — permissions tightened to 600.`);
    }
  } catch {
    // stat failures fall through; the file was readable enough to parse
  }
}
const config = loadConfig(process.env, fileConfig);
const db = createDb(config.dbPath);
const repo = new SnapshotRepository(db);
const watchRepo = new WatchRepository(db);
const journalRepo = new JournalRepository(db);
const oppLogRepo = new OpportunityLogRepository(db);

function makeService(): ExiliumService {
  return new ExiliumService(repo, undefined, watchRepo, journalRepo, oppLogRepo);
}

/** Evaluate agent watches after a data refresh; deliver webhook payloads.
 * Failures log — they never break the refresh loop. */
async function dispatchWatchEvents(service: ExiliumService): Promise<void> {
  try {
    const league = config.league ?? repo.leaguesSeen().find((l) => l.game === config.game)?.league;
    if (league !== undefined) service.logOpportunities(config.game, league);
    const fired = service.runWatchEvaluation();
    for (const e of fired) {
      if (e.webhookUrl === null) continue;
      try {
        const res = await fetch(e.webhookUrl, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ content: `**Exilium watch ${e.watchId}**\n${JSON.stringify(e.payload)}` }),
        });
        if (!res.ok) console.error(`watch webhook ${e.watchId} returned ${res.status}`);
      } catch (err) {
        console.error(`watch webhook ${e.watchId} failed: ${err instanceof Error ? err.message : err}`);
      }
    }
    if (fired.length > 0) console.error(`watches fired: ${fired.length}`);
  } catch (err) {
    console.error(`watch evaluation failed: ${err instanceof Error ? err.message : err}`);
  }
}

async function resolveLeague(client: NinjaClient): Promise<string> {
  if (config.league !== null) return config.league;
  const leagues = await client.getLeagues(config.game);
  const challenge = leagues.find((l) => !/standard|hardcore|^hc /i.test(l.id));
  if (challenge === undefined) throw new Error('Could not auto-detect the current challenge league; set EXILIUM_LEAGUE.');
  return challenge.id;
}

async function cmdIngest(): Promise<void> {
  const client = new NinjaClient({ userAgent: config.userAgent });
  const league = await resolveLeague(client);
  console.log(`Ingesting ${config.game}/${league}: ${config.categories.map((c) => c.name).join(', ')}`);
  const result = await ingestLeague(client, repo, {
    game: config.game,
    league,
    categories: config.categories,
    now: () => new Date().toISOString(),
    minIntervalSec: 0, // explicit user command always fetches
  });
  console.log(`Saved: ${result.saved.join(', ') || '(none)'}`);
  for (const e of result.errors) console.error(`FAILED ${e.category}: ${e.message}`);
  if (result.saved.length === 0) process.exitCode = 1;
}

async function cmdMcp(): Promise<void> {
  const server = buildMcpServer(makeService(), config.game);
  await server.connect(new StdioServerTransport());
  console.error('Exilium MCP server running on stdio (cached data only — run `npm run ingest` to refresh).');
}

async function cmdDashboard(): Promise<void> {
  const service = makeService();
  const client = new NinjaClient({ userAgent: config.userAgent });
  const league = await resolveLeague(client).catch(
    () => repo.leaguesSeen().find((l) => l.game === config.game)?.league ?? 'Standard',
  );
  const refresh = async (): Promise<void> => {
    const result = await ingestLeague(client, repo, {
      game: config.game,
      league,
      categories: config.categories,
      now: () => new Date().toISOString(),
    });
    for (const e of result.errors) console.error(`refresh ${e.category} failed: ${e.message}`);
    await dispatchWatchEvents(service);
  };
  await refresh().catch((err) => console.error('initial refresh failed:', err instanceof Error ? err.message : err));
  setInterval(() => {
    refresh().catch((err) => console.error('refresh failed:', err instanceof Error ? err.message : err));
  }, config.refreshSec * 1000);

  const httpServer = createServer((_req, res) => {
    try {
      const summary = service.marketSnapshot(config.game, league);
      const charts = summary.topVolume.slice(0, 6).map((m) => ({
        itemId: m.itemId,
        name: m.name,
        points: service.pairHistory(config.game, league, m.itemId, 200).points,
      }));
      let recentEvents: ReturnType<typeof service.recentWatchEvents> = [];
      try {
        recentEvents = service.recentWatchEvents(10);
      } catch {
        // watches not enabled — section simply doesn't render
      }
      const html = renderDashboard(
        summary,
        service.opportunities(config.game, league, config.experimental, config.minEdgePct / 100),
        { nowMs: Date.now(), reloadSec: 30 },
        charts,
        recentEvents,
      );
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' }).end(html);
    } catch (err) {
      console.error('dashboard render failed:', err);
      res.writeHead(500).end('Internal error — check server logs.');
    }
  });
  httpServer.listen(config.dashboardPort, () => {
    console.log(
      `Exilium dashboard: http://localhost:${config.dashboardPort} (${config.game}, league: ${league}) — refetching every ${config.refreshSec}s, page reloads every 30s`,
    );
  });
}

async function cmdWatch(): Promise<void> {
  const client = new NinjaClient({ userAgent: config.userAgent });
  const league = await resolveLeague(client);
  const service = makeService();
  const notifier = createNotifier({
    platform: process.platform,
    execFn: async (cmd, args) => promisify(execFile)(cmd, [...args]),
    fetchFn: (url, init) => fetch(url, init),
    webhookUrl: config.webhookUrl,
    log: (m) => console.error(m),
  });
  const deps = {
    ingest: async () => {
      const result = await ingestLeague(client, repo, {
        game: config.game,
        league,
        categories: config.categories,
        now: () => new Date().toISOString(),
      });
      await dispatchWatchEvents(service);
      return result;
    },
    opportunities: () =>
      service.opportunities(config.game, league, false, config.minEdgePct / 100).opportunities,
    notifier,
  };
  console.log(
    `Watching ${config.game}/${league} every ${config.watchIntervalSec}s for edges ≥ ${config.minEdgePct}%` +
      `${config.webhookUrl === undefined ? '' : ' (webhook on)'} — Ctrl+C to stop.`,
  );
  let state = initialWatchState();
  const cycle = async (): Promise<void> => {
    try {
      const result = await watchTick(deps, state);
      state = result.state;
      const stamp = new Date().toISOString();
      for (const e of result.ingestErrors) console.error(`[${stamp}] ingest ${e.category} failed: ${e.message}`);
      if (result.notified.length > 0) {
        for (const o of result.notified) {
          console.log(`[${stamp}] 🔔 ${o.itemName}: ${(o.edge * 100).toFixed(1)}% edge — ${o.rationale}`);
        }
      } else {
        console.log(`[${stamp}] no new opportunities ≥ ${config.minEdgePct}% (tracking ${state.seenIds.size})`);
      }
    } catch (err) {
      console.error(`watch cycle failed: ${err instanceof Error ? err.message : err}`);
    }
  };
  await cycle();
  setInterval(cycle, config.watchIntervalSec * 1000);
}

function storedLeague(): string {
  const league = config.league ?? repo.leaguesSeen().find((l) => l.game === config.game)?.league;
  if (league === undefined) {
    throw new Error(`No ${config.game} data ingested yet — run \`exilium ingest\` first (or set EXILIUM_LEAGUE).`);
  }
  return league;
}

function flagValue(name: string): string | undefined {
  const i = process.argv.indexOf(name);
  return i === -1 ? undefined : process.argv[i + 1];
}

async function cmdPrice(): Promise<void> {
  const query = process.argv.slice(3).filter((a) => !a.startsWith('--')).join(' ');
  if (query === '') throw new Error('Usage: exilium price <item name>');
  const quote = makeService().price(query, config.game, storedLeague());
  console.log(quote === null ? `No match for "${query}" (currency/stackables only).` : formatPriceQuote(quote));
}

async function cmdCategories(): Promise<void> {
  const league = storedLeague();
  const service = makeService();
  console.log(`${config.game}/${league} · item categories\n`);
  console.log(formatCategoryTable(service.categoryList(config.game, league), service.marketSnapshot(config.game, league).primaryCurrency));
}

async function cmdList(): Promise<void> {
  const category = process.argv[3];
  if (category === undefined || category.startsWith('--')) {
    throw new Error('Usage: exilium list <category> [--sort value|volume|change] — see `exilium categories`');
  }
  const sortRaw = flagValue('--sort') ?? 'value';
  if (sortRaw !== 'value' && sortRaw !== 'volume' && sortRaw !== 'change') {
    throw new Error(`--sort must be value, volume, or change (got "${sortRaw}")`);
  }
  const league = storedLeague();
  const service = makeService();
  const items = service.listItems(config.game, league, category, sortRaw);
  console.log(`${config.game}/${league} · ${items[0]?.category ?? category} · ${items.length} markets · sorted by ${sortRaw}\n`);
  console.log(formatItemTable(items, service.marketSnapshot(config.game, league).primaryCurrency));
}

async function cmdOpps(): Promise<void> {
  const minEdge = Number(flagValue('--min-edge') ?? config.minEdgePct) / 100;
  const experimental = process.argv.includes('--experimental');
  const league = storedLeague();
  const { opportunities } = makeService().opportunities(config.game, league, experimental, minEdge, flagValue('--category'));
  console.log(`${config.game}/${league} · edges ≥ ${(minEdge * 100).toFixed(0)}%${experimental ? ' · incl. experimental' : ''}\n`);
  console.log(formatOpportunityTable(opportunities));
}

async function cmdSnapshot(): Promise<void> {
  console.log(formatSnapshotTable(makeService().marketSnapshot(config.game, storedLeague())));
}

async function cmdArb(): Promise<void> {
  const minDiv = Number(flagValue('--min-gap') ?? 0);
  const limit = Number(flagValue('--limit') ?? 25);
  const league = storedLeague();
  const service = makeService();
  const rows = service.arbitrage(config.game, league, minDiv, flagValue('--category')).slice(0, limit);
  const primary = service.marketSnapshot(config.game, league).primaryCurrency;
  console.log(`${config.game}/${league} · cross-rate arbitrage (listed vs implied) · top ${limit}\n`);
  console.log(formatArbTable(rows, primary));
  console.log('\nGaps are usually <0.5% — the exchange is efficient. Wide gaps on low volume are stale-data suspects; re-verify in-game before acting.');
}

async function cmdTui(): Promise<void> {
  const [{ render }, React, { ExiliumTui }] = await Promise.all([
    import('ink'),
    import('react'),
    import('./tui/app.js'),
  ]);
  const client = new NinjaClient({ userAgent: config.userAgent });
  // Fresh install: no stored league yet — resolve live so the first boot
  // can ingest instead of telling the user to run another command.
  let league: string;
  try {
    league = storedLeague();
  } catch {
    league = await resolveLeague(client);
  }
  const tuiService = makeService();
  const onIngest = async (): Promise<void> => {
    await ingestLeague(client, repo, {
      game: config.game,
      league,
      categories: config.categories,
      now: () => new Date().toISOString(),
    });
    await dispatchWatchEvents(tuiService);
  };
  if (repo.latestAll(config.game, league).length === 0) {
    console.log('First run for this league — pulling market data before opening the UI…');
    await onIngest().catch((err) => console.error(err instanceof Error ? err.message : err));
  }
  render(
    React.default.createElement(ExiliumTui, {
      service: tuiService,
      game: config.game,
      league,
      refreshSec: 30,
      onIngest,
      autoIngestSec: config.refreshSec,
      onOpenLink: (url: string) => openUrl(url, { platform: process.platform }),
    }),
  );
}

async function cmdJournal(): Promise<void> {
  const sub = process.argv[3];
  if (sub === 'add') {
    const [oppId, outcome, ...noteParts] = process.argv.slice(4).filter((a) => !a.startsWith('--'));
    if (oppId === undefined || outcome === undefined || !(OUTCOMES as readonly string[]).includes(outcome)) {
      throw new Error('Usage: exilium journal add <opportunity_id> <filled|partial|no-fill|skipped> [note]');
    }
    const service = makeService();
    const opp = service.resolveOpportunity(config.game, storedLeague(), oppId);
    if (opp === null) {
      console.error(`Warning: "${oppId}" is not a known signal (live or logged) — recording with unverified edge 0. Prefer ids straight from opps/find_opportunities.`);
    }
    service.recordOutcome({
      opportunityId: oppId,
      outcome: outcome as Outcome,
      itemName: opp?.itemName ?? oppId.split(':').pop() ?? oppId,
      expectedEdgePct: opp === null ? 0 : opp.edge * 100,
      note: [opp === null ? '(edge unverified)' : null, noteParts.length === 0 ? null : noteParts.join(' ')].filter((s) => s !== null).join(' ') || null,
      recordedAt: new Date().toISOString(),
    });
    console.log(opp === null ? 'Recorded (edge unverified).' : `Recorded against ${opp.itemName} (expected edge ${(opp.edge * 100).toFixed(1)}%).`);
    return;
  }
  const { entries, summary } = makeService().journalEntries(Number(flagValue('--limit') ?? 50));
  console.log(formatJournal(entries, summary));
}

async function cmdWatches(): Promise<void> {
  const sub = process.argv[3];
  const service = makeService();
  if (sub === 'add') {
    const kind = flagValue('--kind');
    const validKinds = ['price_above', 'price_below', 'change_abs', 'opportunity'];
    if (kind === undefined || !validKinds.includes(kind)) {
      throw new Error(`Usage: exilium watches add --kind <${validKinds.join('|')}> [--item ID] [--cat CATEGORY] --threshold N [--mode once|repeat] [--id NAME] [--webhook URL]`);
    }
    const threshold = Number(flagValue('--threshold'));
    if (Number.isNaN(threshold)) throw new Error('--threshold must be a number');
    const itemId = flagValue('--item') ?? null;
    if ((kind === 'price_above' || kind === 'price_below') && itemId === null) {
      throw new Error(`${kind} watches need --item`);
    }
    const league = storedLeague();
    const watch = service.createWatch({
      id: flagValue('--id') ?? `${kind}:${config.game}:${league}:${itemId ?? flagValue('--cat') ?? 'any'}:${threshold}`,
      game: config.game,
      league,
      kind: kind as 'price_above' | 'price_below' | 'change_abs' | 'opportunity',
      itemId,
      category: flagValue('--cat') ?? null,
      threshold,
      mode: (flagValue('--mode') as 'once' | 'repeat' | undefined) ?? 'once',
      webhookUrl: flagValue('--webhook') ?? null,
      createdAt: new Date().toISOString(),
      active: true,
    });
    console.log(`Created watch ${watch.id}. Any running Exilium surface will evaluate it after each refresh.`);
    return;
  }
  if (sub === 'rm') {
    const id = process.argv[4];
    if (id === undefined) throw new Error('Usage: exilium watches rm <id>');
    console.log(service.deleteWatch(id) ? `Deleted ${id}.` : `No watch named ${id}.`);
    return;
  }
  if (sub === 'events') {
    console.log(formatWatchEvents(service.recentWatchEvents(Number(flagValue('--limit') ?? 20))));
    return;
  }
  console.log(formatWatchTable(service.listWatches()));
}

async function cmdLive(): Promise<void> {
  const urls = process.argv.slice(3).filter((a) => !a.startsWith('--'));
  if (urls.length === 0) {
    throw new Error('Usage: exilium live <trade search URL> [more URLs] — copy the URL from pathofexile.com/trade after setting up your search.');
  }
  const sessionId = config.poesessid;
  if (sessionId === undefined || sessionId === '') {
    throw new Error(
      'No session cookie configured. Run `exilium setup` (stores it in ~/.exilium/config.json, chmod 600), or set EXILIUM_POESESSID for this run. The cookie stays on this machine and is sent only to pathofexile.com.',
    );
  }
  const searches = urls.map(parseTradeUrl);
  const { default: WebSocket } = await import('ws');
  const { execFile } = await import('node:child_process');
  const { promisify } = await import('node:util');
  const exec = promisify(execFile);
  const clipboard = (text: string): Promise<void> => copyToClipboard(text, { platform: process.platform });
  const notifier = createNotifier({
    platform: process.platform,
    execFn: async (cmd, args) => exec(cmd, [...args]),
    fetchFn: (url, init) => fetch(url, init),
    webhookUrl: config.webhookUrl,
    log: (m) => console.error(m),
  });
  const deps = {
    fetchFn: (url: string, init: { headers: Record<string, string> }) => fetch(url, init),
    clipboard,
    notify: (title: string, message: string) => notifier.notify(title, message),
    log: (m: string) => console.error(m),
  };

  console.log('Exilium live search — whispers are COPIED to your clipboard, never sent. Paste in game to contact the seller. Ctrl+C to stop.');
  for (const search of searches) {
    const seen = new Set<string>();
    let consecutiveFailures = 0;
    const connect = (): void => {
      const ws = new WebSocket(buildLiveWsUrl(search), {
        headers: {
          Cookie: `POESESSID=${sessionId}`,
          'User-Agent': 'Exilium/0.1.0 (+https://github.com/andrewli8/exilium)',
          Origin: 'https://www.pathofexile.com',
        },
      });
      ws.on('open', () => {
        consecutiveFailures = 0;
        console.log(`watching ${search.league}/${search.searchId} (${search.realm})`);
      });
      ws.on('message', (data: Buffer) => {
        void (async () => {
          try {
            const msg = JSON.parse(data.toString()) as { new?: string[] };
            const fresh = (msg.new ?? []).filter((id) => !seen.has(id));
            if (fresh.length === 0) return;
            for (const id of fresh) seen.add(id);
            const listings = await handleNewListings(fresh, search, sessionId, deps);
            const stamp = new Date().toISOString();
            for (const l of listings) {
              console.log(`[${stamp}] ${l.itemName} · ${l.priceText} · seller ${l.seller}`);
              if (l.whisper !== '') console.log(`  whisper (copied): ${l.whisper}`);
            }
          } catch (err) {
            console.error(err instanceof Error ? err.message : String(err));
          }
        })();
      });
      ws.on('close', (code: number) => {
        consecutiveFailures += 1;
        if (consecutiveFailures >= 5) {
          console.error(`live socket for ${search.searchId} failed ${consecutiveFailures} times in a row — giving up on this search. Check EXILIUM_POESESSID and the URL, then rerun.`);
          return;
        }
        const delay = Math.min(300_000, 30_000 * 2 ** (consecutiveFailures - 1));
        console.error(`live socket for ${search.searchId} closed (${code}) — reconnecting in ${Math.round(delay / 1000)}s`);
        setTimeout(connect, delay);
      });
      ws.on('error', (err: Error) => {
        console.error(`live socket error for ${search.searchId}: ${err.message}${err.message.includes('401') ? ' — check EXILIUM_POESESSID' : ''}`);
      });
    };
    connect();
  }
}

async function cmdBacktest(): Promise<void> {
  const horizon = Number(flagValue('--horizon') ?? 6);
  if (Number.isNaN(horizon) || horizon < 1) throw new Error('--horizon must be a positive number of hours');
  const league = storedLeague();
  const categories = repo.latestAll(config.game, league).map((s) => s.category);
  const detectors = { minVolume: 100, zThreshold: 1.5, minDeviationPct: 10, minDivergence: 0.03 };
  const merged = new Map<string, { signals: number; wins: number; moveSum: number; baseSum: number }>();
  let ticks = 0;
  let skipped = 0;
  let from: string | null = null;
  let to: string | null = null;
  for (const category of categories) {
    const timeline = repo.snapshotTimeline(config.game, league, category);
    const report = runBacktest(timeline, { horizonHours: horizon, detectors });
    ticks = Math.max(ticks, report.ticks);
    skipped += report.skippedNoHorizon;
    if (report.from !== null && (from === null || report.from < from)) from = report.from;
    if (report.to !== null && (to === null || report.to > to)) to = report.to;
    for (const [kind, d] of Object.entries(report.perDetector)) {
      const e = merged.get(kind) ?? { signals: 0, wins: 0, moveSum: 0, baseSum: 0 };
      merged.set(kind, {
        signals: e.signals + d.signals,
        wins: e.wins + d.wins,
        moveSum: e.moveSum + d.avgForwardMovePct * d.signals,
        baseSum: e.baseSum + d.baselineHitRate * d.signals,
      });
    }
  }
  console.log(`Backtest · ${config.game}/${league} · ${categories.length} categories · ${ticks} snapshots deep · horizon ${horizon}h · signal ONSETS only`);
  console.log(`Window: ${from ?? '—'} → ${to ?? '—'}\n`);
  if (merged.size === 0) {
    console.log(`No scoreable signals yet${skipped > 0 ? ` (${skipped} fired too close to the end of history)` : ''}.`);
    console.log('History deepens every refresh — keep the TUI, dashboard, or a cron ingest running and re-run this in a day or two.');
    return;
  }
  for (const [kind, e] of merged.entries()) {
    const hit = e.signals === 0 ? 0 : (e.wins / e.signals) * 100;
    const avg = e.signals === 0 ? 0 : e.moveSum / e.signals;
    const base = e.signals === 0 ? 0 : (e.baseSum / e.signals) * 100;
    console.log(`${kind}: ${e.signals} signal onsets · ${hit.toFixed(0)}% predicted direction (baseline: ${base.toFixed(0)}% of all items moved that way) · avg forward move ${avg.toFixed(2)}%`);
  }
  if (skipped > 0) console.log(`(${skipped} signals fired too close to the end of history to score)`);
  console.log('\nCaveat: hit rate measures direction over the horizon, not realized profit — gold fees and fills are what the journal measures.');
}

async function cmdStash(): Promise<void> {
  const account = flagValue('--account') ?? config.account;
  const sessionId = config.poesessid;
  if (account === undefined || sessionId === undefined || sessionId === '') {
    throw new Error(
      'Stash reading needs your account name (including the #tag, e.g. CoolExile#1234) and session cookie. Easiest: run `exilium setup` once. Or per-run:\n  EXILIUM_POESESSID=<cookie> exilium stash --account "CoolExile#1234"\nThe cookie stays on this machine and goes only to pathofexile.com — same trust model as `exilium live`.',
    );
  }
  const league = storedLeague();
  const service = makeService();
  const stashRepo = new StashRepository(db);
  console.log(`Reading stash for ${account} (${config.game}/${league}) — one request per tab, politely spaced…`);
  const items = await fetchAllStashItems(account, league, sessionId, {
    fetchFn: (url, init) => fetch(url, init),
    delayMs: 600,
  });
  const market = repo
    .latestAll(config.game, league)
    .flatMap((s) => s.lines)
    .map((l) => ({ itemId: l.itemId, name: l.name, category: l.category, primaryValue: l.primaryValue, totalChange: l.totalChange, volumePrimaryValue: l.volumePrimaryValue, sparkline: l.sparkline, change24h: null }));
  const primary = service.marketSnapshot(config.game, league).primaryCurrency;
  const valuation = valueStash(items, market);
  const previous = stashRepo.latest(config.game, league, account);
  stashRepo.save({
    game: config.game,
    league,
    account,
    takenAt: new Date().toISOString(),
    totalValue: valuation.total,
    items,
  });

  for (const l of valuation.lines.slice(0, 15)) {
    console.log(`${String(l.count).padStart(6)}x ${l.name.padEnd(40)} ${formatNumber(l.each).padStart(12)} ${primary}  = ${Math.round(l.total).toLocaleString('en-US')}`);
  }
  if (valuation.lines.length > 15) console.log(`  … and ${valuation.lines.length - 15} more priced lines`);
  console.log(`\nStash value (currency/stackables): ${Math.round(valuation.total).toLocaleString('en-US')} ${primary}`);
  if (valuation.unmatched.length > 0) {
    console.log(`Unpriced (gear/uniques are out of scope): ${valuation.unmatched.length} item types`);
  }
  if (previous !== null) {
    const d = diffStash(previous.items, items, market);
    if (d.gained.length === 0 && d.lost.length === 0) {
      console.log(`\nNo changes since last snapshot (${previous.takenAt}).`);
    } else {
      console.log(`\nSince last snapshot (${previous.takenAt}) — your trade check:`);
      for (const g of d.gained) console.log(`  + ${g.count}x ${g.name}`);
      for (const l of d.lost) console.log(`  - ${l.count}x ${l.name}`);
      console.log(`  net value change: ${d.valueDelta >= 0 ? '+' : ''}${Math.round(d.valueDelta).toLocaleString('en-US')} ${primary}`);
    }
  }
  const history = stashRepo.netWorthHistory(config.game, league, account, 100);
  if (history.length >= 2) {
    console.log(`\nNet worth over ${history.length} snapshots: ${history.map((h) => Math.round(h.totalValue)).join(' → ')}`);
  }
}

async function cmdSellsheet(): Promise<void> {
  const file = flagValue('--file');
  if (file === undefined) {
    throw new Error('Usage: exilium sellsheet --file counts.txt [--discount 10]\nLines: "<count> <item name>", e.g. "12 Ambush Scarab of Containment". # comments allowed.');
  }
  const discount = Number(flagValue('--discount') ?? 0) / 100;
  if (Number.isNaN(discount) || discount < 0 || discount >= 1) throw new Error('--discount must be a percentage between 0 and 99');
  const league = storedLeague();
  const service = makeService();
  const market = repo
    .latestAll(config.game, league)
    .flatMap((s) => s.lines)
    .map((l) => ({ itemId: l.itemId, name: l.name, category: l.category, primaryValue: l.primaryValue, totalChange: l.totalChange, volumePrimaryValue: l.volumePrimaryValue, sparkline: l.sparkline, change24h: null }));
  const primary = service.marketSnapshot(config.game, league).primaryCurrency;
  const sheet = buildSellSheet(parseCounts(readFileSync(file, 'utf8')), market, primary, discount);
  for (const l of sheet.lines) {
    console.log(`${String(l.count).padStart(4)}x ${l.name.padEnd(40)} ${formatNumber(l.askEach).padStart(12)} ${primary} each  = ${Math.round(l.total).toLocaleString('en-US')}`);
  }
  console.log(`\nTotal: ${Math.round(sheet.total).toLocaleString('en-US')} ${primary}`);
  if (sheet.unmatched.length > 0) console.log(`Unmatched (price these yourself): ${sheet.unmatched.join(', ')}`);
  if (sheet.wtsMessage !== '') {
    console.log(`\nWTS message (paste into trade chat or TFT):\n${sheet.wtsMessage}`);
  }
}

async function cmdRising(): Promise<void> {
  const league = storedLeague();
  const limit = Number(flagValue('--limit') ?? 15);
  const service = makeService();
  const primary = service.marketSnapshot(config.game, league).primaryCurrency;
  const scored = repo
    .latestAll(config.game, league)
    .flatMap((s) => s.lines)
    .filter((l) => l.totalChange > 0 && l.volumePrimaryValue > 0)
    .map((l) => ({ l, score: l.totalChange * Math.log10(1 + l.volumePrimaryValue) }))
    .sort((a, b) => b.score - a.score)
    .slice(0, limit);
  console.log(`${config.game}/${league} · rising items (7d gain weighted by volume) — league-start lens\n`);
  console.log(formatItemTable(scored.map(({ l }) => ({ itemId: l.itemId, name: l.name, category: l.category, primaryValue: l.primaryValue, totalChange: l.totalChange, volumePrimaryValue: l.volumePrimaryValue, sparkline: l.sparkline, change24h: null })), primary));
}

const HELP = `exilium — Path of Exile trading terminal

Getting started
  exilium setup                 One-time interactive setup (game, first data pull, optional account/cookie)
  exilium                       Open the terminal UI (auto-refreshes every 5 min)

Market
  exilium snapshot              Top movers and volume
  exilium categories            Item categories with counts and volume
  exilium list <category>       Browse a category   [--sort value|volume|change]
  exilium rising                Volume-weighted gainers (league-start lens)
  exilium price <name>          Price any currency/stackable by name
  exilium pricecheck            Copy an item in-game (Ctrl+C), then run this for a live trade price and search

Trading
  exilium opps                  Detector signals    [--min-edge N] [--category C] [--experimental]
  exilium arb                   Cross-rate arbitrage table [--min-gap N] [--limit N]
  exilium live <trade-url>      Live-search monitor; whisper copied to clipboard
  exilium stash                 Value your stash, net worth, trade-check delta [--account NAME]
  exilium sellsheet --file F    Price a dump tab into a bulk WTS message [--discount N]
  exilium journal [add ...]     Record and review trade outcomes
  exilium backtest              Score detectors against stored history [--horizon H]

Automation
  exilium watch                 Foreground alert loop (desktop/Discord)
  exilium simulate              Test watches/snipes on synthetic moves [--moves "divine:+10"] [--rounds N] [--live] [--notify]
  exilium watches [add|rm|events]  Persistent watches (shared with agents)
  exilium ingest                Force a data refresh now
  exilium dashboard             Self-refreshing web dashboard on :4321
  exilium mcp                   MCP server for AI agents (14+ tools)

Config: ~/.exilium/config.json (written by setup) — env vars override.
Docs and walkthroughs: https://github.com/andrewli8/exilium/tree/main/examples`;

async function cmdHelp(): Promise<void> {
  console.log(HELP);
}

async function cmdSetup(): Promise<void> {
  // Interactive on a TTY; scriptable when answers are piped (one per line:
  // game, account, poesessid) — which is also how the integration test runs.
  let ask: (q: string, fallback: string) => Promise<string>;
  let cleanup = (): void => undefined;
  if (process.stdin.isTTY === true) {
    const { createInterface } = await import('node:readline/promises');
    const rl = createInterface({ input: process.stdin, output: process.stdout });
    ask = async (q, fallback) => {
      const a = (await rl.question(q)).trim();
      return a === '' ? fallback : a;
    };
    cleanup = () => rl.close();
  } else {
    const piped: string[] = [];
    let buffer = '';
    for await (const chunk of process.stdin) buffer += String(chunk);
    piped.push(...buffer.split('\n'));
    let cursor = 0;
    ask = async (q, fallback) => {
      const a = (piped[cursor++] ?? '').trim();
      console.log(`${q}${a}`);
      return a === '' ? fallback : a;
    };
  }
  console.log('Exilium setup — a couple of questions, then a first data pull.');
  console.log('Everything except `stash` and `live` needs NO account or cookie — skip both questions freely.\n');
  const game = (await ask('Game — poe1 or poe2? [poe1] ', 'poe1')) === 'poe2' ? 'poe2' : 'poe1';
  const account = await ask('PoE account name incl. tag, e.g. CoolExile#1234 (Enter to skip): ', '');
  if (account !== '' && !account.includes('#')) {
    console.log(`  Note: modern PoE account names include a #tag (like "${account}#1234") — check your profile page if stash reads fail.`);
  }
  let poesessid = '';
  if (account !== '') {
    console.log('\nOptional: your POESESSID cookie enables `stash` and `live`.');
    console.log('How to find it (you must be logged in at pathofexile.com):');
    console.log('  Chrome/Edge:  F12 → Application tab → Cookies → https://www.pathofexile.com → copy the POESESSID value');
    console.log('  Firefox:      F12 → Storage tab → Cookies → https://www.pathofexile.com → copy the POESESSID value');
    console.log('  Safari:       enable Develop menu → Web Inspector → Storage → Cookies');
    console.log('Security: it is stored ONLY in ~/.exilium/config.json on this machine (permissions 600 — only your');
    console.log('user can read it), never enters the project folder or git, is never logged, and is sent to exactly');
    console.log('one host: pathofexile.com, over HTTPS. Treat it like a password; log out to invalidate it any time.');
    poesessid = await ask('POESESSID (Enter to skip): ', '');
  }
  cleanup();

  const fileConfig: Record<string, unknown> = { game };
  if (account !== '') fileConfig['account'] = account;
  if (poesessid !== '') fileConfig['poesessid'] = poesessid;
  const path = configFilePath(process.env);
  writeFileSync(path, `${JSON.stringify(fileConfig, null, 2)}\n`, { mode: 0o600 });
  chmodSync(path, 0o600);
  console.log(`\nSaved ${path} (permissions 600).`);

  console.log('Pulling first market data…');
  const client = new NinjaClient({ userAgent: config.userAgent });
  const leagues = await client.getLeagues(game as 'poe1' | 'poe2');
  const league = leagues.find((l) => !/standard|hardcore|^hc /i.test(l.id))?.id ?? leagues[0]?.id ?? 'Standard';
  const result = await ingestLeague(client, repo, {
    game: game as 'poe1' | 'poe2',
    league,
    categories: CATEGORIES_BY_GAME[game as 'poe1' | 'poe2'],
    now: () => new Date().toISOString(),
    minIntervalSec: 0,
  });
  console.log(`Ingested ${league}: ${result.saved.length} categories.\n`);
  console.log('You are set. Try:\n  exilium              (terminal UI)\n  exilium snapshot\n  exilium help         (everything else)');
}

async function cmdSimulate(): Promise<void> {
  const league = storedLeague();
  const snapshots = repo.latestAll(config.game, league);
  if (snapshots.length === 0) throw new Error('No data to simulate against — run `exilium ingest` first.');
  console.log('SIMULATION — synthetic data only. Your real database and pathofexile.com are not touched.\n');

  if (process.argv.includes('--live')) {
    const count = Number(flagValue('--count') ?? 5);
    const names = ['Mageblood', 'Headhunter', 'Original Sin', 'Mirror of Kalandra', 'Progenesis'];
    const random = rng(Number(flagValue('--seed') ?? 42));
    const listings = Array.from({ length: count }, (_, i) => ({
      id: `sim-${i}`,
      itemName: names[Math.floor(random() * names.length)]!,
      amount: Math.round(1 + random() * 60),
      currency: 'divine',
      seller: `SimSeller${i}`,
    }));
    const fetchFn = makeFakeListingFetch(listings);
    const { execFile } = await import('node:child_process');
    const { promisify } = await import('node:util');
    const exec = promisify(execFile);
    const notifier = createNotifier({
      platform: process.platform,
      execFn: async (cmd, args) => exec(cmd, [...args]),
      fetchFn: (url, init) => fetch(url, init),
      webhookUrl: config.webhookUrl,
      log: (m) => console.error(m),
    });
    console.log(`Simulated live search: ${count} fake listings, one every 2s — clipboard and notifications are REAL so you can verify the whole path.\n`);
    for (const l of listings) {
      const results = await handleNewListings([l.id], { realm: 'trade', league, searchId: 'simulated' }, 'SIMULATED', {
        fetchFn,
        clipboard: (text) => copyToClipboard(text, { platform: process.platform }),
        notify: (title, message) => notifier.notify(title, message),
        log: (m) => console.error(m),
      });
      for (const r of results) {
        console.log(`[SIM] ${r.itemName} · ${r.priceText} · seller ${r.seller}`);
        console.log(`  whisper (copied): ${r.whisper}`);
      }
      await new Promise((r) => setTimeout(r, 2000));
    }
    console.log('\nSimulated live search complete.');
    return;
  }

  const roundsCount = Number(flagValue('--rounds') ?? 3);
  const movesArg = flagValue('--moves');
  const random = rng(Number(flagValue('--seed') ?? 42));
  const watches = makeService().listWatches().filter((w) => w.game === config.game && w.league === league);
  const allLines = snapshots.flatMap((s) => s.lines);
  // Demo watches aim at the item the FIRST move touches, so a scripted
  // simulation demonstrably fires instead of watching an unrelated item.
  const firstQuery = movesArg === undefined ? undefined : parseMoves(movesArg)[0]?.query.toLowerCase();
  const targetLine =
    (firstQuery === undefined
      ? undefined
      : allLines.find((l) => l.itemId.toLowerCase() === firstQuery || l.name.toLowerCase().includes(firstQuery))) ??
    allLines[0]!;
  if (watches.length === 0) {
    console.log(`No active watches for this league — simulating against 2 demo watches on ${targetLine.name} (±5%).\n`);
  }
  const simWatches = watches.length > 0 ? watches : [
    { id: 'demo-rise', game: config.game, league, kind: 'price_above' as const, itemId: targetLine.itemId, category: null, threshold: targetLine.primaryValue * 1.05, mode: 'repeat' as const, webhookUrl: null, createdAt: new Date().toISOString(), active: true },
    { id: 'demo-drop', game: config.game, league, kind: 'price_below' as const, itemId: targetLine.itemId, category: null, threshold: targetLine.primaryValue * 0.95, mode: 'repeat' as const, webhookUrl: null, createdAt: new Date().toISOString(), active: true },
  ];
  const rounds = Array.from({ length: roundsCount }, () =>
    movesArg !== undefined ? parseMoves(movesArg) : randomMoves(snapshots[0]!, 8, random),
  );
  const result = runWatchSimulation({ snapshots, watches: simWatches, rounds, startIso: new Date().toISOString() });

  const notify = process.argv.includes('--notify');
  for (const round of result.rounds) {
    console.log(`Round ${round.round}: ${round.applied.length === 0 ? 'no moves matched' : round.applied.join(', ')}`);
    if (round.unmatched.length > 0) console.log(`  unmatched: ${round.unmatched.join(', ')}`);
    if (round.fired.length === 0) {
      console.log('  no watches fired');
    } else {
      for (const f of round.fired) {
        console.log(`  🔔 ${f.watchId}: ${JSON.stringify(f.payload)}`);
      }
    }
  }
  const totalFired = result.rounds.reduce((a, r) => a + r.fired.length, 0);
  console.log(`\n${totalFired} watch event(s) fired across ${roundsCount} round(s) — same pipeline as production, in-memory only.`);
  if (notify && totalFired > 0) {
    const { execFile } = await import('node:child_process');
    const { promisify } = await import('node:util');
    const exec = promisify(execFile);
    const notifier = createNotifier({
      platform: process.platform,
      execFn: async (cmd, args) => exec(cmd, [...args]),
      fetchFn: (url, init) => fetch(url, init),
      webhookUrl: config.webhookUrl,
      log: (m) => console.error(m),
    });
    await notifier.notify(`Exilium SIMULATION: ${totalFired} watch events`, 'Desktop notification path verified.');
  }
}

/** Get the item text: an explicit --file wins; a piped stdin (non-TTY) is
 * used as-is; otherwise we read the clipboard — the game already put the
 * item there when you pressed Ctrl+C, so no terminal paste is needed. */
async function readItemText(): Promise<string> {
  const fileArg = flagValue('--file');
  if (fileArg !== undefined) return readFileSync(fileArg, 'utf8');
  if (process.stdin.isTTY !== true) {
    let buffer = '';
    for await (const chunk of process.stdin) buffer += String(chunk);
    return buffer;
  }
  return readClipboard({ platform: process.platform });
}

async function cmdPriceCheck(): Promise<void> {
  const text = await readItemText();
  const item = parseItem(text);
  if (item === null) {
    throw new Error(
      'No PoE item found. In game, hover the item and press Ctrl+C, then run `exilium pricecheck`. (Or pipe/point --file at the item text.)',
    );
  }
  const league = storedLeague();
  const statsPath = joinPath(homedirForStats(), '.exilium', `trade-stats-${config.game}.json`);
  let index;
  try {
    index = await loadStatIndex(config.game, statsPath, (url, i) => fetch(url, i), Date.now());
  } catch (err) {
    console.error(`Could not load trade stat data (${err instanceof Error ? err.message : err}); searching without mod filters.`);
    const { buildStatIndex } = await import('./trade/trade-stats.js');
    index = buildStatIndex({ result: [] });
  }
  const payload = buildTradeQuery(item, index, config.game);
  const url = tradeUrlFor(payload, config.game, league);

  const sessionId = config.poesessid;
  if (sessionId !== undefined && sessionId !== '') {
    let listings: Awaited<ReturnType<typeof searchListings>> = [];
    try {
      listings = await searchListings(payload, config.game, league, 10, { fetchFn: (u, i) => fetch(u, i), sessionId });
    } catch (err) {
      console.error(err instanceof Error ? err.message : String(err));
    }
    console.log(`\n${formatPriceCheck(item, listings)}`);
  } else {
    console.log(`\n${item.name}${item.baseType !== undefined && item.baseType !== item.name ? ` · ${item.baseType}` : ''} (${item.rarity})`);
    console.log('\nLive prices need your session cookie (run `exilium setup`). Opening the filtered trade search instead.');
  }

  // stdin is untouched (we read the clipboard), so on a TTY we can wait for
  // one Enter to open the browser. Otherwise just print the link.
  if (process.stdin.isTTY === true) {
    console.log('\nPress Enter to open this search in your browser (Ctrl+C to skip).');
    const { createInterface } = await import('node:readline/promises');
    const rl = createInterface({ input: process.stdin, output: process.stdout });
    await rl.question('');
    rl.close();
    openUrl(url, { platform: process.platform });
    console.log('Opened the trade search in your browser.');
  } else {
    console.log(`\nTrade search: ${url}`);
  }
}

const commands: Record<string, () => Promise<void>> = {
  setup: cmdSetup,
  pricecheck: cmdPriceCheck,
  pc: cmdPriceCheck,
  simulate: cmdSimulate,
  help: cmdHelp,
  tui: cmdTui,
  ingest: cmdIngest,
  mcp: cmdMcp,
  dashboard: cmdDashboard,
  watch: cmdWatch,
  price: cmdPrice,
  categories: cmdCategories,
  list: cmdList,
  opps: cmdOpps,
  journal: cmdJournal,
  watches: cmdWatches,
  live: cmdLive,
  backtest: cmdBacktest,
  sellsheet: cmdSellsheet,
  rising: cmdRising,
  stash: cmdStash,
  snapshot: cmdSnapshot,
  arb: cmdArb,
};

const cmd = process.argv[2] ?? 'tui';
const run = commands[cmd];
if (run === undefined) {
  console.error('Unknown command. Run `exilium help` for the full list, or `exilium setup` if this is your first time.');
  process.exit(2);
}
run().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
