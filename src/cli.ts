import { execFile } from 'node:child_process';
import { createServer } from 'node:http';
import { promisify } from 'node:util';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { loadConfig } from './config.js';
import { renderDashboard } from './dashboard/render.js';
import { ingestLeague } from './ingest/ingest.js';
import { buildMcpServer } from './mcp/server.js';
import { ExiliumService } from './mcp/service.js';
import { formatArbTable, formatOpportunityTable, formatPriceQuote, formatSnapshotTable } from './cli/format.js';
import { NinjaClient } from './sources/ninja/client.js';
import { createDb } from './storage/db.js';
import { SnapshotRepository } from './storage/snapshot-repository.js';
import { createNotifier } from './watch/notify.js';
import { initialWatchState, watchTick } from './watch/watch.js';

const config = loadConfig(process.env);
const repo = new SnapshotRepository(createDb(config.dbPath));

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
  console.log(`Ingesting ${config.game}/${league}: ${config.categories.join(', ')}`);
  const result = await ingestLeague(client, repo, {
    game: config.game,
    league,
    categories: config.categories,
    now: () => new Date().toISOString(),
  });
  console.log(`Saved: ${result.saved.join(', ') || '(none)'}`);
  for (const e of result.errors) console.error(`FAILED ${e.category}: ${e.message}`);
  if (result.saved.length === 0) process.exitCode = 1;
}

async function cmdMcp(): Promise<void> {
  const server = buildMcpServer(new ExiliumService(repo), config.game);
  await server.connect(new StdioServerTransport());
  console.error('Exilium MCP server running on stdio (cached data only — run `npm run ingest` to refresh).');
}

async function cmdDashboard(): Promise<void> {
  const service = new ExiliumService(repo);
  const league =
    config.league ?? repo.leaguesSeen().find((l) => l.game === config.game)?.league ?? 'Standard';
  const httpServer = createServer((_req, res) => {
    try {
      const html = renderDashboard(
        service.marketSnapshot(config.game, league),
        service.opportunities(config.game, league, true),
      );
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' }).end(html);
    } catch (err) {
      console.error('dashboard render failed:', err);
      res.writeHead(500).end('Internal error — check server logs.');
    }
  });
  httpServer.listen(config.dashboardPort, () => {
    console.log(`Exilium dashboard: http://localhost:${config.dashboardPort} (${config.game}, league: ${league})`);
  });
}

async function cmdWatch(): Promise<void> {
  const client = new NinjaClient({ userAgent: config.userAgent });
  const league = await resolveLeague(client);
  const service = new ExiliumService(repo);
  const notifier = createNotifier({
    platform: process.platform,
    execFn: async (cmd, args) => promisify(execFile)(cmd, [...args]),
    fetchFn: (url, init) => fetch(url, init),
    webhookUrl: config.webhookUrl,
    log: (m) => console.error(m),
  });
  const deps = {
    ingest: () =>
      ingestLeague(client, repo, {
        game: config.game,
        league,
        categories: config.categories,
        now: () => new Date().toISOString(),
      }),
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
  const quote = new ExiliumService(repo).price(query, config.game, storedLeague());
  console.log(quote === null ? `No match for "${query}" (currency/stackables only).` : formatPriceQuote(quote));
}

async function cmdOpps(): Promise<void> {
  const minEdge = Number(flagValue('--min-edge') ?? config.minEdgePct) / 100;
  const experimental = process.argv.includes('--experimental');
  const league = storedLeague();
  const { opportunities } = new ExiliumService(repo).opportunities(config.game, league, experimental, minEdge);
  console.log(`${config.game}/${league} · edges ≥ ${(minEdge * 100).toFixed(0)}%${experimental ? ' · incl. experimental' : ''}\n`);
  console.log(formatOpportunityTable(opportunities));
}

async function cmdSnapshot(): Promise<void> {
  console.log(formatSnapshotTable(new ExiliumService(repo).marketSnapshot(config.game, storedLeague())));
}

async function cmdArb(): Promise<void> {
  const minDiv = Number(flagValue('--min-gap') ?? 0);
  const limit = Number(flagValue('--limit') ?? 25);
  const league = storedLeague();
  const service = new ExiliumService(repo);
  const rows = service.arbitrage(config.game, league, minDiv).slice(0, limit);
  const primary = service.marketSnapshot(config.game, league).primaryCurrency;
  console.log(`${config.game}/${league} · cross-rate arbitrage (listed vs implied) · top ${limit}\n`);
  console.log(formatArbTable(rows, primary));
  console.log('\nGaps are usually <0.5% — the exchange is efficient. Wide gaps on low volume are stale-data suspects; re-verify in-game before acting.');
}

const commands: Record<string, () => Promise<void>> = {
  ingest: cmdIngest,
  mcp: cmdMcp,
  dashboard: cmdDashboard,
  watch: cmdWatch,
  price: cmdPrice,
  opps: cmdOpps,
  snapshot: cmdSnapshot,
  arb: cmdArb,
};

const cmd = process.argv[2] ?? '';
const run = commands[cmd];
if (run === undefined) {
  console.error('Usage: exilium <ingest|watch|snapshot|opps|arb|price|dashboard|mcp>');
  process.exit(2);
}
run().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
