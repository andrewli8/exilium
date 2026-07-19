import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import type { Game } from '../domain/types.js';
import type { ExiliumService } from './service.js';

const gameSchema = z.enum(['poe1', 'poe2']).optional();

const HUMAN_RULE = 'Exilium is decision support only: it never executes trades — a human performs every trade in-game.';

function json(body: unknown) {
  return { content: [{ type: 'text' as const, text: JSON.stringify(body) }] };
}

/** Build the Exilium MCP server. Tools serve cached snapshot data only and
 * never trigger upstream API calls (PRD architectural invariant).
 * `defaultGame` applies when a tool call omits the game argument. */
export function buildMcpServer(service: ExiliumService, defaultGame: Game = 'poe1'): McpServer {
  const server = new McpServer({ name: 'exilium', version: '0.1.0' });
  const resolveGame = (game: Game | undefined): Game => game ?? defaultGame;

  server.registerTool(
    'get_leagues',
    {
      description: `List leagues with ingested market data. Read-only cached data. ${HUMAN_RULE}`,
      inputSchema: {},
      annotations: { readOnlyHint: true },
    },
    async () => json(service.leagues()),
  );

  server.registerTool(
    'get_market_snapshot',
    {
      description: `Compact market overview for a league: top movers and top-volume Currency Exchange markets, priced in the game's primary currency (PoE1: chaos, PoE2: divine). Read-only cached data. ${HUMAN_RULE}`,
      inputSchema: { game: gameSchema, league: z.string().min(1) },
      annotations: { readOnlyHint: true },
    },
    async ({ game, league }) => json(service.marketSnapshot(resolveGame(game), league)),
  );

  server.registerTool(
    'get_categories',
    {
      description: `Item categories (Currency, Scarab, Fragment, Essence, DivinationCard, …) with market counts and traded volume for a league. Use these names for category filters. Read-only cached data. ${HUMAN_RULE}`,
      inputSchema: { game: gameSchema, league: z.string().min(1) },
      annotations: { readOnlyHint: true },
    },
    async ({ game, league }) => json({ league, categories: service.categoryList(resolveGame(game), league) }),
  );

  server.registerTool(
    'list_items',
    {
      description: `Every market in one category (e.g. all Scarabs), sorted by value, volume, or change. Compact rows with price, 7d change, volume, sparkline. Read-only cached data. ${HUMAN_RULE}`,
      inputSchema: {
        game: gameSchema,
        league: z.string().min(1),
        category: z.string().min(1),
        sort: z.enum(['value', 'volume', 'change']).optional(),
        limit: z.number().int().positive().max(500).optional(),
      },
      annotations: { readOnlyHint: true },
    },
    async ({ game, league, category, sort, limit }) =>
      json({ league, category, items: service.listItems(resolveGame(game), league, category, sort ?? 'value').slice(0, limit ?? 100) }),
  );

  server.registerTool(
    'get_pair_history',
    {
      description: `Stored price history (from repeated ingestion) plus the latest trailing sparkline for one item. Read-only cached data. ${HUMAN_RULE}`,
      inputSchema: { game: gameSchema, league: z.string().min(1), item_id: z.string().min(1), limit: z.number().int().positive().max(1000).optional() },
      annotations: { readOnlyHint: true },
    },
    async ({ game, league, item_id, limit }) => json(service.pairHistory(resolveGame(game), league, item_id, limit)),
  );

  server.registerTool(
    'price_item',
    {
      description: `Price a currency/stackable by id or name (currency, essences, catalysts, fragments — NOT rare items). Returns the value in the game's primary currency plus conversions, with a volume-based confidence. Read-only cached data. ${HUMAN_RULE}`,
      inputSchema: { game: gameSchema, query: z.string().min(1), league: z.string().min(1) },
      annotations: { readOnlyHint: true },
    },
    async ({ game, query, league }) => {
      const quote = service.price(query, resolveGame(game), league);
      return quote === null ? json({ found: false, query }) : json(quote);
    },
  );

  server.registerTool(
    'find_opportunities',
    {
      description: `Current durable-edge signals (mean-reversion; plus experimental cross-rate divergence when include_experimental=true). Edges are estimates from minutes-to-hours-old data, gold fees not included. Read-only cached data. ${HUMAN_RULE}`,
      inputSchema: {
        game: gameSchema,
        league: z.string().min(1),
        include_experimental: z.boolean().optional(),
        min_edge_pct: z.number().nonnegative().optional(),
        category: z.string().optional(),
      },
      annotations: { readOnlyHint: true },
    },
    async ({ game, league, include_experimental, min_edge_pct, category }) =>
      json(service.opportunities(resolveGame(game), league, include_experimental ?? false, (min_edge_pct ?? 0) / 100, category)),
  );

  server.registerTool(
    'find_arbitrage',
    {
      description: `Cross-rate arbitrage table: every market's listed price vs the price implied by its highest-volume quote pair and core rates. min_divergence_pct filters small gaps (default 0 = show all, sorted widest first). Gaps are usually <0.5% — the in-game exchange is efficient; treat wide gaps as stale-data suspects and re-verify in-game. Read-only cached data. ${HUMAN_RULE}`,
      inputSchema: {
        game: gameSchema,
        league: z.string().min(1),
        min_divergence_pct: z.number().nonnegative().optional(),
        limit: z.number().int().positive().max(200).optional(),
        category: z.string().optional(),
      },
      annotations: { readOnlyHint: true },
    },
    async ({ game, league, min_divergence_pct, limit, category }) =>
      json({ league, rows: service.arbitrage(resolveGame(game), league, min_divergence_pct ?? 0, category).slice(0, limit ?? 50) }),
  );

  server.registerTool(
    'create_watch',
    {
      description: `Create (or idempotently update, by id) a persistent server-side watch. Kinds: price_above/price_below (item_id + threshold in the game's primary currency), change_abs (|7d change| ≥ threshold %, item_id or category scoped), opportunity (detector edge ≥ threshold %). mode 'once' (default) deactivates after first fire; 'repeat' fires once per data snapshot. Results via poll_watch_results or an optional webhook. ${HUMAN_RULE}`,
      inputSchema: {
        game: gameSchema,
        league: z.string().min(1),
        kind: z.enum(['price_above', 'price_below', 'change_abs', 'opportunity']),
        item_id: z.string().optional(),
        category: z.string().optional(),
        threshold: z.number(),
        mode: z.enum(['once', 'repeat']).optional(),
        webhook_url: z.string().url().optional(),
        id: z.string().min(1).max(64).optional(),
      },
    },
    async ({ game, league, kind, item_id, category, threshold, mode, webhook_url, id }) => {
      if ((kind === 'price_above' || kind === 'price_below') && item_id === undefined) {
        throw new Error(`${kind} watches require item_id`);
      }
      const g = resolveGame(game);
      const watch = service.createWatch({
        id: id ?? `${kind}:${g}:${league}:${item_id ?? category ?? 'any'}:${threshold}`,
        game: g,
        league,
        kind,
        itemId: item_id ?? null,
        category: category ?? null,
        threshold,
        mode: mode ?? 'once',
        webhookUrl: webhook_url ?? null,
        createdAt: new Date().toISOString(),
        active: true,
      });
      return json({ watch });
    },
  );

  server.registerTool(
    'list_watches',
    {
      description: `List active watches. Read-only. ${HUMAN_RULE}`,
      inputSchema: {},
      annotations: { readOnlyHint: true },
    },
    async () => json({ watches: service.listWatches() }),
  );

  server.registerTool(
    'delete_watch',
    {
      description: `Delete a watch and its recorded events by id. ${HUMAN_RULE}`,
      inputSchema: { id: z.string().min(1) },
    },
    async ({ id }) => json({ id, deleted: service.deleteWatch(id) }),
  );

  server.registerTool(
    'poll_watch_results',
    {
      description: `Evaluate due watches against the latest cached data and return fired events after the cursor. Pass the returned nextCursor on the next call. Evaluation uses cached snapshots only — never triggers upstream calls. ${HUMAN_RULE}`,
      inputSchema: { cursor: z.number().int().nonnegative(), limit: z.number().int().positive().max(200).optional() },
    },
    async ({ cursor, limit }) => json(service.pollWatchResults(cursor, limit ?? 50)),
  );

  server.registerTool(
    'draft_trade_plan',
    {
      description: `Turn an opportunity id (from find_opportunities) into an ordered, human-executable trade plan with gold-fee guidance. Exilium never executes trades; the plan is for the human to carry out in-game.`,
      inputSchema: { game: gameSchema, league: z.string().min(1), opportunity_id: z.string().min(1) },
      annotations: { readOnlyHint: true },
    },
    async ({ game, league, opportunity_id }) => json(service.plan(resolveGame(game), league, opportunity_id)),
  );

  return server;
}
