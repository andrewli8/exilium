import { describe, expect, test } from 'vitest';
import { buildStatIndex, matchMod } from '../src/trade/trade-stats.js';
import { buildTradeQuery } from '../src/trade/price-check.js';
import type { ParsedItem } from '../src/trade/parse-item.js';

const RAW_STATS = {
  result: [
    { id: 'explicit', label: 'Explicit', entries: [
      { id: 'explicit.stat_3299347043', text: '+# to maximum Life', type: 'explicit' },
      { id: 'explicit.stat_4220027924', text: '+#% to Cold Resistance', type: 'explicit' },
    ] },
    { id: 'implicit', label: 'Implicit', entries: [
      { id: 'implicit.stat_3441501978', text: '+#% to Fire and Lightning Resistances', type: 'implicit' },
    ] },
  ],
};

const index = buildStatIndex(RAW_STATS);

describe('matchMod', () => {
  test('matches an explicit mod to its stat id and pulls the value as min', () => {
    expect(matchMod({ text: '+95 to maximum Life', kind: 'explicit' }, index)).toEqual({
      id: 'explicit.stat_3299347043', value: { min: 95 },
    });
  });
  test('matches an implicit mod in the implicit group', () => {
    expect(matchMod({ text: '+12% to Fire and Lightning Resistances', kind: 'implicit' }, index)).toEqual({
      id: 'implicit.stat_3441501978', value: { min: 12 },
    });
  });
  test('returns null for an unknown mod', () => {
    expect(matchMod({ text: 'Grants nonsense', kind: 'explicit' }, index)).toBeNull();
  });
});

function item(o: Partial<ParsedItem>): ParsedItem {
  return { rarity: 'Rare', itemClass: 'Body Armours', name: 'Doom Shell', baseType: 'Saintly Chainmail', itemLevel: 84, quality: 20, links: 6, corrupted: true, mods: [], ...o };
}

describe('buildTradeQuery', () => {
  test('rares query by base with ilvl, links, corruption, and matched stat filters', () => {
    const payload = buildTradeQuery(item({
      mods: [
        { text: '+95 to maximum Life', kind: 'explicit' },
        { text: '+45% to Cold Resistance', kind: 'explicit' },
        { text: '+12% to Fire and Lightning Resistances', kind: 'implicit' },
      ],
    }), index, 'poe1');
    expect(payload.query.type).toBe('Saintly Chainmail');
    expect(payload.query.status).toEqual({ option: 'online' });
    expect(payload.query.filters.misc_filters.filters.ilvl).toEqual({ min: 84 });
    expect(payload.query.filters.misc_filters.filters.corrupted).toEqual({ option: 'true' });
    expect(payload.query.filters.socket_filters.filters.links).toEqual({ min: 6 });
    const ids = payload.query.stats[0].filters.map((f: { id: string }) => f.id);
    expect(ids).toContain('explicit.stat_3299347043');
    expect(ids).toContain('implicit.stat_3441501978');
    expect(payload.sort).toEqual({ price: 'asc' });
  });

  test('uniques query by name + base, no stat filters', () => {
    const payload = buildTradeQuery(item({ rarity: 'Unique', name: 'Facebreaker', baseType: 'Strapped Mitts', mods: [{ text: 'x', kind: 'explicit' }] }), index, 'poe1');
    expect(payload.query.name).toBe('Facebreaker');
    expect(payload.query.type).toBe('Strapped Mitts');
    expect(payload.query.stats[0].filters).toHaveLength(0);
  });

  test('currency/gems query by name only, poe2 uses available status', () => {
    const payload = buildTradeQuery(item({ rarity: 'Currency', name: 'Divine Orb', baseType: undefined, mods: [] }), index, 'poe2');
    expect(payload.query.type).toBe('Divine Orb');
    expect(payload.query.status).toEqual({ option: 'available' });
  });
});
