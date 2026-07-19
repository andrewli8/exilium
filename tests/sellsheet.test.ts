import { describe, expect, test } from 'vitest';
import { buildSellSheet, parseCounts } from '../src/trade/sellsheet.js';
import type { DetailedMover } from '../src/mcp/service.js';

const MARKET: readonly DetailedMover[] = [
  { itemId: 'horned-bloodlines', name: 'Horned Scarab of Bloodlines', category: 'Scarab', primaryValue: 1838, totalChange: 6.8, volumePrimaryValue: 172509, sparkline: [] },
  { itemId: 'ambush', name: 'Ambush Scarab of Containment', category: 'Scarab', primaryValue: 583.4, totalChange: -47.7, volumePrimaryValue: 22945, sparkline: [] },
];

describe('parseCounts', () => {
  test('parses "count name" lines, skipping blanks and comments', () => {
    const rows = parseCounts('3 Horned Scarab of Bloodlines\n\n# dump tab 2\n12 ambush scarab of containment\n');
    expect(rows).toEqual([
      { count: 3, query: 'Horned Scarab of Bloodlines' },
      { count: 12, query: 'ambush scarab of containment' },
    ]);
  });

  test('rejects malformed lines with the line number', () => {
    expect(() => parseCounts('three scarabs')).toThrow(/line 1/i);
  });
});

describe('buildSellSheet', () => {
  test('prices matched items, totals them, and drafts a WTS message', () => {
    const sheet = buildSellSheet(
      [
        { count: 3, query: 'horned scarab of bloodlines' },
        { count: 12, query: 'Ambush Scarab of Containment' },
        { count: 5, query: 'unknown thing' },
      ],
      MARKET,
      'chaos',
    );
    expect(sheet.lines).toHaveLength(2);
    expect(sheet.lines[0]!.total).toBeCloseTo(3 * 1838);
    expect(sheet.total).toBeCloseTo(3 * 1838 + 12 * 583.4);
    expect(sheet.unmatched).toEqual(['unknown thing']);
    expect(sheet.wtsMessage).toContain('WTS');
    expect(sheet.wtsMessage).toContain('3x Horned Scarab of Bloodlines');
    expect(sheet.wtsMessage).toMatch(/chaos/);
  });

  test('applies a bulk discount to the asking price', () => {
    const sheet = buildSellSheet([{ count: 10, query: 'ambush scarab of containment' }], MARKET, 'chaos', 0.1);
    expect(sheet.lines[0]!.askEach).toBeCloseTo(583.4 * 0.9);
    expect(sheet.wtsMessage).toContain('10% under market');
  });
});
