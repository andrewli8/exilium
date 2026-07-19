import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, test } from 'vitest';
import { normalizeExchangeOverview } from '../src/sources/ninja/normalize.js';

/** Recorded real poe.ninja responses (July 2026). These catch schema drift
 * that hand-built fixtures cannot — the null-sparkline production bug was
 * exactly this class. Re-record with curl if poe.ninja changes shape. */
function fixture(name: string): unknown {
  return JSON.parse(readFileSync(join(__dirname, 'fixtures', name), 'utf8'));
}

describe('normalizer against recorded real payloads', () => {
  test('PoE1 currency overview normalizes completely and sanely', () => {
    const snap = normalizeExchangeOverview(fixture('poe1-currency-overview.json'), {
      game: 'poe1',
      league: 'Mirage',
      category: 'Currency',
      fetchedAt: '2026-07-19T00:00:00Z',
    });
    expect(snap.core.primary).toBe('chaos');
    expect(snap.core.perPrimary['chaos']).toBe(1);
    expect(snap.lines.length).toBeGreaterThan(50);
    for (const l of snap.lines) {
      expect(l.primaryValue).toBeGreaterThan(0);
      expect(l.name).not.toBe('');
      expect(Number.isFinite(l.volumePrimaryValue)).toBe(true);
      expect(l.sparkline.every((v) => Number.isFinite(v))).toBe(true);
    }
  });

  test('PoE2 currency overview normalizes with divine as primary', () => {
    const snap = normalizeExchangeOverview(fixture('poe2-currency-overview.json'), {
      game: 'poe2',
      league: 'Runes of Aldur',
      category: 'Currency',
      fetchedAt: '2026-07-19T00:00:00Z',
    });
    expect(snap.core.primary).toBe('divine');
    expect(snap.lines.length).toBeGreaterThan(30);
    const named = snap.lines.filter((l) => l.name !== l.itemId);
    expect(named.length).toBeGreaterThan(snap.lines.length / 2);
  });
});
