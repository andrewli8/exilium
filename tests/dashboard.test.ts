import { describe, expect, test } from 'vitest';
import { renderDashboard } from '../src/dashboard/render.js';
import type { MarketSummary, OpportunitiesResult } from '../src/mcp/service.js';

const SUMMARY: MarketSummary = {
  league: 'Runes of Aldur',
  asOf: '2026-07-18T18:00:00Z',
  categories: 2,
  topMovers: [
    { itemId: 'crashed-orb', name: 'Crashed <Orb>', category: 'Currency', primaryValue: 0.5, totalChange: -40, volumePrimaryValue: 50000 },
  ],
  topVolume: [
    { itemId: 'chaos', name: 'Chaos Orb', category: 'Currency', primaryValue: 0.13, totalChange: 1, volumePrimaryValue: 100000 },
  ],
};

const OPPS: OpportunitiesResult = {
  league: 'Runes of Aldur',
  opportunities: [
    {
      id: 'mean-reversion:Runes of Aldur:crashed-orb',
      kind: 'mean-reversion',
      league: 'Runes of Aldur',
      itemId: 'crashed-orb',
      itemName: 'Crashed <Orb>',
      category: 'Currency',
      edge: 0.5,
      confidence: 0.8,
      rationale: 'way below trend',
      dataFreshness: '2026-07-18T18:00:00Z',
      experimental: false,
    },
  ],
};

describe('renderDashboard', () => {
  test('renders league, movers, and opportunities into HTML', () => {
    const html = renderDashboard(SUMMARY, OPPS);
    expect(html).toContain('Runes of Aldur');
    expect(html).toContain('Chaos Orb');
    expect(html).toContain('mean-reversion');
    expect(html).toContain('50.0%'); // edge formatted
  });

  test('escapes HTML in item names', () => {
    const html = renderDashboard(SUMMARY, OPPS);
    expect(html).not.toContain('Crashed <Orb>');
    expect(html).toContain('Crashed &lt;Orb&gt;');
  });

  test('shows an empty-state message when there is no data', () => {
    const html = renderDashboard(
      { league: 'X', asOf: null, categories: 0, topMovers: [], topVolume: [] },
      { league: 'X', opportunities: [] },
    );
    expect(html).toMatch(/no data ingested/i);
  });
});
