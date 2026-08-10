import { describe, expect, test } from 'vitest';
import type { MarketLine, MarketSnapshot } from '../src/domain/types.js';
import { assessMargin, assessMarginAgainstFloor, passesMarginGate } from '../src/snipe/margin.js';

const NOW = Date.parse('2026-08-09T12:00:00Z');

function line(partial: Partial<MarketLine> & { itemId: string; name: string; primaryValue: number }): MarketLine {
  return {
    category: 'UniqueAccessory',
    volumePrimaryValue: 1000,
    maxVolumeCurrency: null,
    maxVolumeRate: null,
    sparkline: [],
    totalChange: 0,
    ...partial,
  };
}

function snapshot(partial: Partial<MarketSnapshot> & { lines: readonly MarketLine[] }): MarketSnapshot {
  return {
    game: 'poe1',
    league: 'Allflame',
    category: 'UniqueAccessory',
    fetchedAt: new Date(NOW - 4 * 60 * 1000).toISOString(),
    core: { primary: 'chaos', perPrimary: { chaos: 1, divine: 0.005 } },
    ...partial,
  };
}

const SNAPSHOTS = [
  snapshot({
    lines: [
      line({ itemId: 'mageblood', name: 'Mageblood', primaryValue: 40_000 }),
      line({ itemId: 'voices-1p', name: 'Voices (1 passive)', primaryValue: 9_000, volumePrimaryValue: 5000 }),
    ],
  }),
];

describe('assessMargin', () => {
  test('converts a divine listing to chaos and computes margin against the reference', () => {
    const a = assessMargin({ itemName: 'Mageblood', price: { amount: 150, currency: 'divine' }, snapshots: SNAPSHOTS, nowMs: NOW });
    expect(a.listedChaos).toBe(30_000);
    expect(a.referenceChaos).toBe(40_000);
    expect(a.marginChaos).toBe(10_000);
    expect(a.marginPct).toBe(25);
    expect(a.freshness?.level).toBe('live');
  });

  test('chaos listings pass through at face value', () => {
    const a = assessMargin({ itemName: 'Mageblood', price: { amount: 41_000, currency: 'chaos' }, snapshots: SNAPSHOTS, nowMs: NOW });
    expect(a.listedChaos).toBe(41_000);
    expect(a.marginChaos).toBe(-1_000);
  });

  test('unknown listing currency yields no conversion and no margin, never a guess', () => {
    const a = assessMargin({ itemName: 'Mageblood', price: { amount: 3, currency: 'wisdom' }, snapshots: SNAPSHOTS, nowMs: NOW });
    expect(a.listedChaos).toBeNull();
    expect(a.marginChaos).toBeNull();
    expect(a.referenceChaos).toBe(40_000);
  });

  test('unpriced items (rares) have no reference and no margin', () => {
    const a = assessMargin({ itemName: 'Loath Cut Ring of the Penguin', price: { amount: 10, currency: 'chaos' }, snapshots: SNAPSHOTS, nowMs: NOW });
    expect(a.referenceChaos).toBeNull();
    expect(a.marginChaos).toBeNull();
    expect(a.listedChaos).toBe(10);
  });

  test('unpriced listings ("no price") still assess the reference side', () => {
    const a = assessMargin({ itemName: 'Mageblood', price: null, snapshots: SNAPSHOTS, nowMs: NOW });
    expect(a.listedChaos).toBeNull();
    expect(a.referenceChaos).toBe(40_000);
    expect(a.marginChaos).toBeNull();
  });

  test('reference older than 10 minutes is flagged stale', () => {
    const old = [snapshot({ fetchedAt: new Date(NOW - 11 * 60 * 1000).toISOString(), lines: SNAPSHOTS[0]!.lines })];
    const a = assessMargin({ itemName: 'Mageblood', price: { amount: 1, currency: 'divine' }, snapshots: old, nowMs: NOW });
    expect(a.freshness?.level).toBe('stale');
  });

  test('substring matching still finds variant-suffixed names', () => {
    const a = assessMargin({ itemName: 'Voices', price: { amount: 40, currency: 'divine' }, snapshots: SNAPSHOTS, nowMs: NOW });
    expect(a.referenceChaos).toBe(9_000);
  });
});

describe('assessMarginAgainstFloor', () => {
  test('prices an unindexed listing against the search floor', () => {
    const assessment = assessMarginAgainstFloor({
      price: { amount: 0.5, currency: 'divine' }, // 100c at 200c/divine
      floorChaos: 200,
      snapshots: SNAPSHOTS,
      nowMs: NOW,
    });
    expect(assessment.listedChaos).toBe(100);
    expect(assessment.referenceChaos).toBe(200);
    expect(assessment.referenceName).toBe('search floor');
    expect(assessment.marginChaos).toBe(100);
    expect(assessment.marginPct).toBe(50);
    expect(assessment.freshness?.level).toBe('live');
  });

  test('keeps unknowns null when the listing has no priceable currency', () => {
    const assessment = assessMarginAgainstFloor({
      price: { amount: 3, currency: 'exalted-unknown' },
      floorChaos: 200,
      snapshots: SNAPSHOTS,
      nowMs: NOW,
    });
    expect(assessment.listedChaos).toBeNull();
    expect(assessment.marginChaos).toBeNull();
    expect(assessment.marginPct).toBeNull();
  });
});

describe('passesMarginGate', () => {
  const known = assessMargin({ itemName: 'Mageblood', price: { amount: 150, currency: 'divine' }, snapshots: SNAPSHOTS, nowMs: NOW });
  const unknown = assessMargin({ itemName: 'Some Rare Ring', price: { amount: 10, currency: 'chaos' }, snapshots: SNAPSHOTS, nowMs: NOW });

  test('no threshold: everything passes without flags', () => {
    expect(passesMarginGate(known, null)).toEqual({ pass: true, unknownMargin: false });
  });

  test('threshold compares against the computed percent', () => {
    expect(passesMarginGate(known, 20)).toEqual({ pass: true, unknownMargin: false });
    expect(passesMarginGate(known, 30)).toEqual({ pass: false, unknownMargin: false });
  });

  test('unknown margins pass the gate but are flagged so alerts can say so', () => {
    expect(passesMarginGate(unknown, 20)).toEqual({ pass: true, unknownMargin: true });
  });
});
