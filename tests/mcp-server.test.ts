import { beforeEach, describe, expect, test } from 'vitest';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { buildMcpServer } from '../src/mcp/server.js';
import { ExiliumService } from '../src/mcp/service.js';
import { createDb } from '../src/storage/db.js';
import { SnapshotRepository } from '../src/storage/snapshot-repository.js';
import type { MarketSnapshot } from '../src/domain/types.js';

const SNAP: MarketSnapshot = {
  league: 'Runes of Aldur',
  category: 'Currency',
  fetchedAt: '2026-07-18T18:00:00Z',
  core: { primary: 'divine', perDivine: { divine: 1, exalted: 400, chaos: 8 } },
  lines: [
    {
      itemId: 'chaos',
      name: 'Chaos Orb',
      category: 'Currency',
      primaryValue: 0.13,
      volumePrimaryValue: 100000,
      maxVolumeCurrency: 'divine',
      maxVolumeRate: 7.6,
      sparkline: [1, 2, 1, 2, 1, 2, 1],
      totalChange: 1,
    },
    {
      itemId: 'crashed-orb',
      name: 'Crashed Orb',
      category: 'Currency',
      primaryValue: 0.5,
      volumePrimaryValue: 50000,
      maxVolumeCurrency: 'exalted',
      maxVolumeRate: 5,
      sparkline: [10, 12, 11, 9, 10, 11, -40],
      totalChange: -40,
    },
  ],
};

async function connectedClient() {
  const repo = new SnapshotRepository(createDb(':memory:'));
  repo.save(SNAP);
  const server = buildMcpServer(new ExiliumService(repo));
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

  test('exposes the six PRD v0 tools', async () => {
    const { tools } = await client.listTools();
    const names = tools.map((t) => t.name).sort();
    expect(names).toEqual([
      'draft_trade_plan',
      'find_opportunities',
      'get_leagues',
      'get_market_snapshot',
      'get_pair_history',
      'price_item',
    ]);
    // Every tool description must carry the human-executes stance or be read-only data.
    const draft = tools.find((t) => t.name === 'draft_trade_plan')!;
    expect(draft.description).toMatch(/never execut/i);
  });

  test('get_market_snapshot returns compact movers for the league', async () => {
    const res = await client.callTool({ name: 'get_market_snapshot', arguments: { league: 'Runes of Aldur' } });
    const body = parseText(res);
    expect(body.league).toBe('Runes of Aldur');
    expect(body.topMovers[0].itemId).toBe('crashed-orb');
    expect(body.topMovers[0].totalChange).toBe(-40);
  });

  test('price_item resolves and converts', async () => {
    const res = await client.callTool({ name: 'price_item', arguments: { query: 'chaos orb', league: 'Runes of Aldur' } });
    const body = parseText(res);
    expect(body.divineValue).toBe(0.13);
    expect(body.exaltedValue).toBeCloseTo(52);
  });

  test('find_opportunities excludes experimental signals unless opted in', async () => {
    const base = parseText(
      await client.callTool({ name: 'find_opportunities', arguments: { league: 'Runes of Aldur' } }),
    );
    expect(base.opportunities.every((o: any) => o.experimental === false)).toBe(true);
    const withExp = parseText(
      await client.callTool({
        name: 'find_opportunities',
        arguments: { league: 'Runes of Aldur', include_experimental: true },
      }),
    );
    expect(withExp.opportunities.some((o: any) => o.experimental === true)).toBe(true);
  });

  test('draft_trade_plan turns an opportunity id into a human plan and errors on unknown ids', async () => {
    const opps = parseText(
      await client.callTool({ name: 'find_opportunities', arguments: { league: 'Runes of Aldur' } }),
    );
    const planRes = await client.callTool({
      name: 'draft_trade_plan',
      arguments: { league: 'Runes of Aldur', opportunity_id: opps.opportunities[0].id },
    });
    const plan = parseText(planRes);
    expect(plan.steps.length).toBeGreaterThan(0);
    expect(plan.humanExecutionNote).toMatch(/never executes/i);

    const bad = await client.callTool({
      name: 'draft_trade_plan',
      arguments: { league: 'Runes of Aldur', opportunity_id: 'nope' },
    });
    expect(bad.isError).toBe(true);
  });

  test('get_pair_history and get_leagues serve stored data only', async () => {
    const hist = parseText(
      await client.callTool({ name: 'get_pair_history', arguments: { league: 'Runes of Aldur', item_id: 'chaos' } }),
    );
    expect(hist.points).toHaveLength(1);
    expect(hist.points[0].primaryValue).toBe(0.13);
    const leagues = parseText(await client.callTool({ name: 'get_leagues', arguments: {} }));
    expect(leagues.leagues).toEqual(['Runes of Aldur']);
  });
});
