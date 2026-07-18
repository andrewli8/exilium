/** End-to-end smoke test: spawn the real MCP server over stdio and exercise
 * every tool against live-ingested data, printing a compact transcript. */
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

const client = new Client({ name: 'smoke', version: '0.0.1' });
await client.connect(
  new StdioClientTransport({ command: 'npx', args: ['tsx', 'src/cli.ts', 'mcp'], cwd: process.cwd() }),
);

const text = (r: unknown): any => JSON.parse((r as any).content[0].text);

const tools = await client.listTools();
console.log('tools:', tools.tools.map((t) => t.name).join(', '));

const leagues = text(await client.callTool({ name: 'get_leagues', arguments: {} }));
console.log('leagues:', leagues);
const league = leagues.leagues[0];

const snap = text(await client.callTool({ name: 'get_market_snapshot', arguments: { league } }));
console.log(`snapshot: ${snap.categories} categories, top mover: ${snap.topMovers[0].name} (${snap.topMovers[0].totalChange}%)`);

const price = text(await client.callTool({ name: 'price_item', arguments: { league, query: 'chaos orb' } }));
console.log(`price chaos orb: ${price.divineValue} div / ${price.exaltedValue?.toFixed(1)} ex (confidence ${price.confidence.toFixed(2)})`);

const opps = text(await client.callTool({ name: 'find_opportunities', arguments: { league, include_experimental: true } }));
console.log(`opportunities: ${opps.opportunities.length} total, ${opps.opportunities.filter((o: any) => !o.experimental).length} non-experimental`);
const top = opps.opportunities[0];
if (top !== undefined) {
  console.log(`top: [${top.kind}] ${top.itemName} edge=${(top.edge * 100).toFixed(1)}% — ${top.rationale.slice(0, 110)}`);
  const plan = text(await client.callTool({ name: 'draft_trade_plan', arguments: { league, opportunity_id: top.id } }));
  console.log(`plan: ${plan.summary}`);
  console.log(`      steps=${plan.steps.length}, humanNote="${plan.humanExecutionNote.slice(0, 60)}..."`);
  const hist = text(await client.callTool({ name: 'get_pair_history', arguments: { league, item_id: top.itemId } }));
  console.log(`history for ${top.itemId}: ${hist.points.length} stored point(s), sparkline ${hist.latestSparkline.length} entries`);
}

await client.close();
