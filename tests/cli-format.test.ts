import { describe, expect, test } from 'vitest';
import { formatArbTable, formatOpportunityTable, formatPriceQuote, formatSnapshotTable } from '../src/cli/format.js';
import type { Opportunity, PriceQuote } from '../src/domain/types.js';
import type { ArbRow } from '../src/mcp/service.js';
import type { MarketSummary } from '../src/mcp/service.js';

const QUOTE: PriceQuote = {
  itemId: 'divine',
  name: 'Divine Orb',
  game: 'poe1',
  league: 'Mirage',
  primaryCurrency: 'chaos',
  primaryValue: 723,
  conversions: { divine: 0.9999 },
  confidence: 0.95,
  asOf: '2026-07-18T18:00:00Z',
};

const OPP: Opportunity = {
  id: 'mean-reversion:poe1:Mirage:blessed',
  kind: 'mean-reversion',
  game: 'poe1',
  league: 'Mirage',
  itemId: 'blessed',
  itemName: 'Blessed Orb',
  category: 'Currency',
  edge: 0.35,
  confidence: 0.6,
  rationale: 'spiked above trend',
  dataFreshness: '2026-07-18T18:00:00Z',
  experimental: false,
};

describe('cli formatters', () => {
  test('formatPriceQuote shows value, currency, conversions and confidence', () => {
    const out = formatPriceQuote(QUOTE);
    expect(out).toContain('Divine Orb');
    expect(out).toContain('723');
    expect(out).toContain('chaos');
    expect(out).toContain('divine');
    expect(out).toContain('95%');
  });

  test('formatOpportunityTable renders aligned rows with edge percent', () => {
    const out = formatOpportunityTable([OPP]);
    expect(out).toContain('Blessed Orb');
    expect(out).toContain('35.0%');
    expect(out).toContain('mean-reversion');
  });

  test('formatOpportunityTable handles empty lists with a message', () => {
    expect(formatOpportunityTable([])).toMatch(/no opportunities/i);
  });

  test('formatSnapshotTable renders movers with primary currency header', () => {
    const summary: MarketSummary = {
      game: 'poe1',
      primaryCurrency: 'chaos',
      league: 'Mirage',
      asOf: '2026-07-18T18:00:00Z',
      categories: 13,
      topMovers: [
        { itemId: 'x', name: 'Mirror Shard', category: 'Currency', primaryValue: 4200, totalChange: 12.5, volumePrimaryValue: 90000 },
      ],
      topVolume: [],
    };
    const out = formatSnapshotTable(summary);
    expect(out).toContain('Mirror Shard');
    expect(out).toContain('chaos');
    expect(out).toContain('12.5');
  });

  test('formatArbTable renders divergences sorted with implied vs listed', () => {
    const rows: readonly ArbRow[] = [
      { itemId: 'a', itemName: 'Orb A', category: 'Currency', listed: 10, implied: 11, quoteCurrency: 'divine', divergencePct: 10, volumePrimaryValue: 500 },
      { itemId: 'b', itemName: 'Orb B', category: 'Currency', listed: 10, implied: 10.2, quoteCurrency: 'divine', divergencePct: 2, volumePrimaryValue: 900 },
    ];
    const out = formatArbTable(rows, 'chaos');
    expect(out).toContain('Orb A');
    expect(out).toContain('10.0%');
    expect(out.indexOf('Orb A')).toBeLessThan(out.indexOf('Orb B'));
  });
});
