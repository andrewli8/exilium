import { describe, expect, test } from 'vitest';
import { matchesSearch } from '../src/tui/search.js';
import { priceItem } from '../src/pricing/price-item.js';
import type { MarketLine, MarketSnapshot } from '../src/domain/types.js';

describe('matchesSearch (token AND, substring per token)', () => {
  const hay = 'Greater Multistrike Support (1/23c) Currency';
  test('matches the base item text', () => {
    expect(matchesSearch(hay, 'multistrike')).toBe(true);
    expect(matchesSearch(hay, 'greater multistrike support')).toBe(true);
  });
  test('matches when words straddle the parenthetical (the reported bug)', () => {
    expect(matchesSearch('Awakened Empower Support (4) Currency', 'empower 4')).toBe(true);
    expect(matchesSearch(hay, 'multistrike 23')).toBe(true); // level/quality digits
    expect(matchesSearch(hay, 'multistrike 1 23')).toBe(true);
  });
  test('every token must be present', () => {
    expect(matchesSearch(hay, 'multistrike headhunter')).toBe(false);
  });
  test('empty query matches everything', () => {
    expect(matchesSearch(hay, '')).toBe(true);
    expect(matchesSearch(hay, '   ')).toBe(true);
  });
});

describe('priceItem token search', () => {
  function line(o: Partial<MarketLine>): MarketLine {
    return { itemId: 'x', name: 'X', category: 'SkillGem', primaryValue: 5, volumePrimaryValue: 100, maxVolumeCurrency: null, maxVolumeRate: null, sparkline: [], totalChange: 0, ...o };
  }
  const snap: MarketSnapshot = {
    game: 'poe1', league: 'Mirage', category: 'SkillGem', fetchedAt: '2026-07-20T18:00:00Z',
    core: { primary: 'chaos', perPrimary: { chaos: 1 } },
    lines: [
      line({ itemId: 'awakened-empower-4', name: 'Awakened Empower Support (4)', primaryValue: 30000, volumePrimaryValue: 5 }),
      line({ itemId: 'awakened-empower-5c', name: 'Awakened Empower Support (5c)', primaryValue: 90000, volumePrimaryValue: 3 }),
    ],
  };
  test('finds a gem by name plus level even across the parenthesis', () => {
    const q = priceItem('empower 4', [snap]);
    expect(q).not.toBeNull();
    expect(q!.itemId).toBe('awakened-empower-4');
  });
});
