import { describe, expect, test } from 'vitest';
import type { MarketLine, MarketSnapshot } from '../src/domain/types.js';
import type { LiveListing } from '../src/trade/live-search.js';
import type { SnipeTarget } from '../src/snipe/bettertrading.js';
import { assessMargin } from '../src/snipe/margin.js';
import { buildSearchPageUrl, decideSnipe, formatAlert } from '../src/snipe/engine.js';

const NOW = Date.parse('2026-08-09T12:00:00Z');

const LINES: readonly MarketLine[] = [
  {
    itemId: 'mageblood',
    name: 'Mageblood',
    category: 'UniqueAccessory',
    primaryValue: 40_000,
    volumePrimaryValue: 1000,
    maxVolumeCurrency: null,
    maxVolumeRate: null,
    sparkline: [],
    totalChange: 0,
  },
];

const SNAPSHOTS: readonly MarketSnapshot[] = [
  {
    game: 'poe1',
    league: 'Allflame',
    category: 'UniqueAccessory',
    fetchedAt: new Date(NOW - 4 * 60 * 1000).toISOString(),
    core: { primary: 'chaos', perPrimary: { chaos: 1, divine: 0.005 } },
    lines: LINES,
  },
];

const TARGET: SnipeTarget = { label: 'MB snipes', realm: 'trade', searchId: 'AbC123', league: null };

function listing(partial: Partial<LiveListing> = {}): LiveListing {
  return {
    id: 'listing-1',
    itemName: 'Mageblood Heavy Belt',
    referenceName: 'Mageblood',
    priceText: '150 divine',
    price: { amount: 150, currency: 'divine' },
    seller: 'Valdo_Enjoyer',
    whisper: '@Valdo_Enjoyer Hi, I would like to buy your Mageblood',
    ...partial,
  };
}

function decide(over: {
  listing?: LiveListing;
  target?: SnipeTarget;
  globalMinMarginPct?: number | null;
  seen?: ReadonlySet<string>;
}) {
  const l = over.listing ?? listing();
  return decideSnipe({
    listing: l,
    target: over.target ?? TARGET,
    assessment: assessMargin({ itemName: l.referenceName, price: l.price, snapshots: SNAPSHOTS, nowMs: NOW }),
    snapshots: SNAPSHOTS,
    globalMinMarginPct: over.globalMinMarginPct ?? null,
    league: 'Allflame',
    seen: over.seen ?? new Set(),
  });
}

describe('decideSnipe', () => {
  test('a fresh profitable listing becomes an alert with margin and search URL', () => {
    const result = decide({});
    expect(result.kind).toBe('alert');
    if (result.kind !== 'alert') return;
    expect(result.alert.marginText).toBe('+10,000c (+25.0%)');
    expect(result.alert.searchUrl).toBe('https://www.pathofexile.com/trade/search/Allflame/AbC123');
    expect(result.alert.freshnessText).toContain('4m ago');
    expect(result.alert.stale).toBe(false);
  });

  test('already-seen listings are suppressed', () => {
    const result = decide({ seen: new Set(['listing-1']) });
    expect(result).toEqual({ kind: 'suppressed', reason: 'duplicate listing listing-1' });
  });

  test('listings above the per-target max buy are suppressed (same currency)', () => {
    const target = { ...TARGET, maxBuy: { amount: 100, currency: 'divine' } };
    const result = decide({ target });
    expect(result.kind).toBe('suppressed');
    if (result.kind !== 'suppressed') return;
    expect(result.reason).toContain('max buy');
  });

  test('max buy compares across currencies via chaos', () => {
    const target = { ...TARGET, maxBuy: { amount: 100, currency: 'divine' } };
    const cheap = listing({ priceText: '10000 chaos', price: { amount: 10_000, currency: 'chaos' } });
    expect(decide({ target, listing: cheap }).kind).toBe('alert');
  });

  test('an unconvertible max buy fails open with an alert, not a silent skip', () => {
    const target = { ...TARGET, maxBuy: { amount: 5, currency: 'wisdom' } };
    expect(decide({ target }).kind).toBe('alert');
  });

  test('per-target min margin overrides the global threshold', () => {
    expect(decide({ target: { ...TARGET, minMarginPct: 30 }, globalMinMarginPct: 10 }).kind).toBe('suppressed');
    expect(decide({ target: { ...TARGET, minMarginPct: 20 }, globalMinMarginPct: 90 }).kind).toBe('alert');
  });

  test('the global min margin applies when the target has none', () => {
    expect(decide({ globalMinMarginPct: 30 }).kind).toBe('suppressed');
    expect(decide({ globalMinMarginPct: 20 }).kind).toBe('alert');
  });

  test('unpriceable items pass a margin threshold flagged as unknown', () => {
    const rare = listing({ itemName: 'Loath Cut Ring', referenceName: 'Loath Cut Ring', price: { amount: 10, currency: 'chaos' } });
    const result = decide({ listing: rare, globalMinMarginPct: 30 });
    expect(result.kind).toBe('alert');
    if (result.kind !== 'alert') return;
    expect(result.alert.unknownMargin).toBe(true);
    expect(result.alert.marginText).toContain('no reference price');
  });
});

describe('formatAlert', () => {
  test('renders notification title/body and a console line', () => {
    const result = decide({});
    if (result.kind !== 'alert') throw new Error('expected alert');
    const rendered = formatAlert(result.alert);
    expect(rendered.title).toContain('Mageblood');
    expect(rendered.title).toContain('150 divine');
    expect(rendered.body).toContain('+10,000c (+25.0%)');
    expect(rendered.body).not.toMatch(/whisper|copied/i);
    expect(rendered.line).toContain('MB snipes');
    expect(rendered.line).toContain('Valdo_Enjoyer');
  });

  test('marks stale references loudly', () => {
    const staleSnapshots = [{ ...SNAPSHOTS[0]!, fetchedAt: new Date(NOW - 20 * 60 * 1000).toISOString() }];
    const l = listing();
    const result = decideSnipe({
      listing: l,
      target: TARGET,
      assessment: assessMargin({ itemName: l.referenceName, price: l.price, snapshots: staleSnapshots, nowMs: NOW }),
      snapshots: staleSnapshots,
      globalMinMarginPct: null,
      league: 'Allflame',
      seen: new Set(),
    });
    if (result.kind !== 'alert') throw new Error('expected alert');
    expect(result.alert.stale).toBe(true);
    expect(formatAlert(result.alert).body).toContain('STALE');
  });
});

describe('buildSearchPageUrl', () => {
  test('poe1 and poe2 shapes, league-encoded', () => {
    expect(buildSearchPageUrl({ ...TARGET, realm: 'trade' }, 'Allflame')).toBe(
      'https://www.pathofexile.com/trade/search/Allflame/AbC123',
    );
    expect(buildSearchPageUrl({ ...TARGET, realm: 'trade2' }, 'Runes of Aldur')).toBe(
      'https://www.pathofexile.com/trade2/search/poe2/Runes%20of%20Aldur/AbC123',
    );
  });
});
