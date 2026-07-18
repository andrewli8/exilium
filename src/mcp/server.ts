import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import type { ExiliumService } from './service.js';

const HUMAN_RULE = 'Exilium is decision support only: it never executes trades — a human performs every trade in-game.';

function json(body: unknown) {
  return { content: [{ type: 'text' as const, text: JSON.stringify(body) }] };
}

/** Build the Exilium MCP server. Tools serve cached snapshot data only and
 * never trigger upstream API calls (PRD architectural invariant). */
export function buildMcpServer(service: ExiliumService): McpServer {
  const server = new McpServer({ name: 'exilium', version: '0.1.0' });

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
      description: `Compact market overview for a league: top movers and top-volume Currency Exchange markets, prices in Divine Orbs. Read-only cached data. ${HUMAN_RULE}`,
      inputSchema: { league: z.string().min(1) },
      annotations: { readOnlyHint: true },
    },
    async ({ league }) => json(service.marketSnapshot(league)),
  );

  server.registerTool(
    'get_pair_history',
    {
      description: `Stored price history (from repeated ingestion) plus the latest trailing sparkline for one item. Read-only cached data. ${HUMAN_RULE}`,
      inputSchema: { league: z.string().min(1), item_id: z.string().min(1), limit: z.number().int().positive().max(1000).optional() },
      annotations: { readOnlyHint: true },
    },
    async ({ league, item_id, limit }) => json(service.pairHistory(league, item_id, limit)),
  );

  server.registerTool(
    'price_item',
    {
      description: `Price a currency/stackable by id or name (currency, essences, runes, fragments — NOT rare items). Returns divine/exalted/chaos values with a volume-based confidence. Read-only cached data. ${HUMAN_RULE}`,
      inputSchema: { query: z.string().min(1), league: z.string().min(1) },
      annotations: { readOnlyHint: true },
    },
    async ({ query, league }) => {
      const quote = service.price(query, league);
      return quote === null ? json({ found: false, query }) : json(quote);
    },
  );

  server.registerTool(
    'find_opportunities',
    {
      description: `Current durable-edge signals (mean-reversion; plus experimental cross-rate divergence when include_experimental=true). Edges are estimates from minutes-to-hours-old data, gold fees not included. Read-only cached data. ${HUMAN_RULE}`,
      inputSchema: {
        league: z.string().min(1),
        include_experimental: z.boolean().optional(),
        min_edge_pct: z.number().nonnegative().optional(),
      },
      annotations: { readOnlyHint: true },
    },
    async ({ league, include_experimental, min_edge_pct }) =>
      json(service.opportunities(league, include_experimental ?? false, (min_edge_pct ?? 0) / 100)),
  );

  server.registerTool(
    'draft_trade_plan',
    {
      description: `Turn an opportunity id (from find_opportunities) into an ordered, human-executable trade plan with gold-fee guidance. Exilium never executes trades; the plan is for the human to carry out in-game.`,
      inputSchema: { league: z.string().min(1), opportunity_id: z.string().min(1) },
      annotations: { readOnlyHint: true },
    },
    async ({ league, opportunity_id }) => json(service.plan(league, opportunity_id)),
  );

  return server;
}
