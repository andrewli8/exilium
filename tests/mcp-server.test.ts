import { beforeEach, describe, expect, test } from 'vitest';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { buildMcpServer } from '../src/mcp/server.js';
import { ExiliumService } from '../src/mcp/service.js';
import { createDb } from '../src/storage/db.js';
import { SnapshotRepository } from '../src/storage/snapshot-repository.js';
import type { MarketLine, MarketSnapshot } from '../src/domain/types.js';

function line(overrides: Partial<MarketLine>): MarketLine {
  return {
    itemId: 'chaos',
    name: 'Chaos Orb',
    category: 'Currency',
    primaryValue: 0.13,
    volumePrimaryValue: 100000,
    maxVolumeCurrency: 'divine',
    maxVolumeRate: 7.6,
    sparkline: [1, 2, 1, 2, 1, 2, 1],
    totalChange: 1,
    ...overrides,
  };
}

/** PoE1 fixture — chaos-primary, exercised via the default game. */
const POE1_SNAP: MarketSnapshot = {
  game: 'poe1',
  league: 'Mirage',
  category: 'Currency',
  fetchedAt: '2026-07-18T18:00:00Z',
  core: { primary: 'chaos', perPrimary: { chaos: 1, divine: 0.0014 } },
  lines: [
    line({ itemId: 'fusing', name: 'Orb of Fusing', primaryValue: 0.5 }),
    line({
      itemId: 'crashed-orb',
      name: 'Crashed Orb',
      primaryValue: 20,
      volumePrimaryValue: 50000,
      maxVolumeCurrency: 'divine',
      maxVolumeRate: 5,
      sparkline: [10, 12, 11, 9, 10, 11, -40],
      totalChange: -40,
    }),
  ],
};

const POE2_SNAP: MarketSnapshot = {
  game: 'poe2',
  league: 'Runes of Aldur',
  category: 'Currency',
  fetchedAt: '2026-07-18T18:00:00Z',
  core: { primary: 'divine', perPrimary: { divine: 1, exalted: 400, chaos: 8 } },
  lines: [line({ itemId: 'exalted', name: 'Exalted Orb', primaryValue: 0.0025 })],
};

async function connectedClient() {
  const repo = new SnapshotRepository(createDb(':memory:'));
  repo.save(POE1_SNAP);
  repo.save(POE2_SNAP);
  const server = buildMcpServer(new ExiliumService(repo), 'poe1');
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: 'test', version: '0.0.1' });
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
  return client;
}

function parseText(result: { content?: unknown }): any {
  const content = (result as any).content as { type: string; text: string }[];
  return JSON.parse(content[0]!.text);
}

describe('Exilium MCP server', () => {
  let client: Client;

  beforeEach(async () => {
    client = await connectedClient();
  });

  test('exposes the six PRD v0 tools with the human-executes stance', async () => {
    const { tools } = await client.listTools();
    const names = tools.map((t) => t.name).sort();
    expect(names).toEqual([
      'draft_trade_plan',
      'find_arbitrage',
      'find_opportunities',
      'get_categories',
      'get_leagues',
      'get_market_snapshot',
      'get_pair_history',
      'list_items',
      'price_item',
    ]);
    const draft = tools.find((t) => t.name === 'draft_trade_plan')!;
    expect(draft.description).toMatch(/never execut/i);
  });

  test('defaults to poe1 when game is omitted', async () => {
    const res = await client.callTool({ name: 'get_market_snapshot', arguments: { league: 'Mirage' } });
    const body = parseText(res);
    expect(body.game).toBe('poe1');
    expect(body.primaryCurrency).toBe('chaos');
    expect(body.topMovers[0].itemId).toBe('crashed-orb');
  });

  test('serves poe2 data when game is passed explicitly', async () => {
    const res = await client.callTool({
      name: 'get_market_snapshot',
      arguments: { game: 'poe2', league: 'Runes of Aldur' },
    });
    const body = parseText(res);
    expect(body.game).toBe('poe2');
    expect(body.primaryCurrency).toBe('divine');
  });

  test('price_item resolves in the game primary currency with conversions', async () => {
    const res = await client.callTool({ name: 'price_item', arguments: { query: 'orb of fusing', league: 'Mirage' } });
    const body = parseText(res);
    expect(body.primaryCurrency).toBe('chaos');
    expect(body.primaryValue).toBe(0.5);
    expect(body.conversions.divine).toBeCloseTo(0.0007);
  });

  test('find_opportunities excludes experimental signals unless opted in', async () => {
    const base = parseText(
      await client.callTool({ name: 'find_opportunities', arguments: { league: 'Mirage' } }),
    );
    expect(base.opportunities.length).toBeGreaterThan(0);
    expect(base.opportunities.every((o: any) => o.experimental === false)).toBe(true);
    const withExp = parseText(
      await client.callTool({
        name: 'find_opportunities',
        arguments: { league: 'Mirage', include_experimental: true },
      }),
    );
    expect(withExp.opportunities.some((o: any) => o.experimental === true)).toBe(true);
  });

  test('draft_trade_plan works from an opportunity id and errors on unknown ids', async () => {
    const opps = parseText(
      await client.callTool({ name: 'find_opportunities', arguments: { league: 'Mirage' } }),
    );
    const plan = parseText(
      await client.callTool({
        name: 'draft_trade_plan',
        arguments: { league: 'Mirage', opportunity_id: opps.opportunities[0].id },
      }),
    );
    expect(plan.steps.length).toBeGreaterThan(0);
    expect(plan.humanExecutionNote).toMatch(/never executes/i);

    const bad = await client.callTool({
      name: 'draft_trade_plan',
      arguments: { league: 'Mirage', opportunity_id: 'nope' },
    });
    expect(bad.isError).toBe(true);
  });

  test('find_arbitrage returns listed-vs-implied rows sorted by gap', async () => {
    const res = parseText(
      await client.callTool({ name: 'find_arbitrage', arguments: { league: 'Mirage' } }),
    );
    expect(res.rows.length).toBeGreaterThan(0);
    const row = res.rows[0];
    expect(row).toHaveProperty('listed');
    expect(row).toHaveProperty('implied');
    expect(row).toHaveProperty('divergencePct');
    const gaps = res.rows.map((r: any) => r.divergencePct);
    expect(gaps).toEqual([...gaps].sort((a: number, b: number) => b - a));
  });

  test('get_categories and list_items browse by item type', async () => {
    const cats = parseText(await client.callTool({ name: 'get_categories', arguments: { league: 'Mirage' } }));
    expect(cats.categories[0]).toHaveProperty('category');
    expect(cats.categories[0]).toHaveProperty('markets');

    const items = parseText(
      await client.callTool({ name: 'list_items', arguments: { league: 'Mirage', category: 'currency', sort: 'volume' } }),
    );
    expect(items.items.length).toBeGreaterThan(0);
    expect(items.items.every((i: any) => i.category === 'Currency')).toBe(true);

    const bad = await client.callTool({ name: 'list_items', arguments: { league: 'Mirage', category: 'Wands' } });
    expect(bad.isError).toBe(true);
  });

  test('get_pair_history and get_leagues serve stored data only', async () => {
    const hist = parseText(
      await client.callTool({ name: 'get_pair_history', arguments: { league: 'Mirage', item_id: 'fusing' } }),
    );
    expect(hist.points).toHaveLength(1);
    expect(hist.points[0].primaryValue).toBe(0.5);
    const leagues = parseText(await client.callTool({ name: 'get_leagues', arguments: {} }));
    expect(leagues.leagues).toEqual(
      expect.arrayContaining([
        { game: 'poe1', league: 'Mirage' },
        { game: 'poe2', league: 'Runes of Aldur' },
      ]),
    );
  });
});
