import { describe, expect, test } from 'vitest';
import { renderDashboard } from '../src/dashboard/render.js';
import type { MarketSummary, OpportunitiesResult } from '../src/mcp/service.js';

const SUMMARY: MarketSummary = {
  game: 'poe2',
  primaryCurrency: 'divine',
  divinePerPrimary: 1,
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
      direction: 'buy',
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
    expect(html).toMatch(/prices in divine/i);
  });

  test('escapes HTML in item names', () => {
    const html = renderDashboard(SUMMARY, OPPS);
    expect(html).not.toContain('Crashed <Orb>');
    expect(html).toContain('Crashed &lt;Orb&gt;');
  });

  test('embeds auto-reload and a data-age badge', () => {
    const html = renderDashboard(SUMMARY, OPPS, { nowMs: Date.parse('2026-07-18T18:04:00Z'), reloadSec: 30 });
    expect(html).toContain('4m ago');
    expect(html).toMatch(/setTimeout.*location\.reload.*30000|content="30"/);
  });

  test('renders pair charts when history is provided', () => {
    const html = renderDashboard(SUMMARY, OPPS, { nowMs: Date.parse('2026-07-18T18:04:00Z'), reloadSec: 30 }, [
      {
        itemId: 'chaos',
        name: 'Chaos Orb',
        points: [
          { fetchedAt: '2026-07-18T17:00:00Z', primaryValue: 0.12, volumePrimaryValue: 100 },
          { fetchedAt: '2026-07-18T18:00:00Z', primaryValue: 0.13, volumePrimaryValue: 100 },
        ],
      },
    ]);
    expect(html).toContain('Price History');
    expect(html).toContain('Chaos Orb');
    expect(html).toContain('<svg');
    expect(html).toContain('polyline');
  });

  test('shows currency icons and divine conversion for large chaos prices', () => {
    const summary: MarketSummary = {
      ...SUMMARY,
      game: 'poe1',
      primaryCurrency: 'chaos',
      divinePerPrimary: 1 / 720,
      topMovers: [
        { itemId: 'big', name: 'Mageblood', category: 'Currency', primaryValue: 144000, totalChange: 1, volumePrimaryValue: 5000 },
        { itemId: 'small', name: 'Fusing', category: 'Currency', primaryValue: 2, totalChange: 1, volumePrimaryValue: 5000 },
      ],
    };
    const html = renderDashboard(summary, OPPS, { nowMs: Date.parse('2026-07-18T18:04:00Z'), reloadSec: 30 });
    expect(html).toContain('alt="div"');
    expect(html).toContain('alt="c"');
    expect(html).toContain('200'); // 144000c / 720 = 200 div
    expect(html).toContain('poecdn.com');
  });

  test('renders a watch-events section when events are provided', () => {
    const html = renderDashboard(SUMMARY, OPPS, { nowMs: Date.parse('2026-07-18T18:04:00Z'), reloadSec: 30 }, [], [
      {
        seq: 1,
        watchId: 'divine-alert',
        firedAt: '2026-07-18T17:30:00Z',
        dedupeKey: 'k',
        payload: { itemName: 'Divine <Orb>', value: 755 },
      },
    ]);
    expect(html).toContain('Watch Events');
    expect(html).toContain('divine-alert');
    expect(html).toContain('755');
    expect(html).toContain('Divine &lt;Orb&gt;');
  });

  test('shows an empty-state message when there is no data', () => {
    const html = renderDashboard(
      { game: 'poe1', primaryCurrency: 'chaos', divinePerPrimary: null, league: 'X', asOf: null, categories: 0, topMovers: [], topVolume: [] },
      { league: 'X', opportunities: [] },
    );
    expect(html).toMatch(/no data ingested/i);
  });
});
