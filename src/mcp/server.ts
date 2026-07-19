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
      },
      annotations: { readOnlyHint: true },
    },
    async ({ game, league, include_experimental, min_edge_pct }) =>
      json(service.opportunities(resolveGame(game), league, include_experimental ?? false, (min_edge_pct ?? 0) / 100)),
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
      },
      annotations: { readOnlyHint: true },
    },
    async ({ game, league, min_divergence_pct, limit }) =>
      json({ league, rows: service.arbitrage(resolveGame(game), league, min_divergence_pct ?? 0).slice(0, limit ?? 50) }),
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
