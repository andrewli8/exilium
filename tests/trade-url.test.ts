import { describe, expect, test } from 'vitest';
import { buildTradeSearchUrl } from '../src/trade/trade-url.js';

function query(url: string): any {
  return JSON.parse(decodeURIComponent(url.split('?q=')[1]!));
}

describe('buildTradeSearchUrl', () => {
  test('strips the display variant so the trade site can match the type', () => {
    const url = buildTradeSearchUrl('poe1', 'Mirage', 'Awakened Empower Support (lvl 5, corrupt)', 'SkillGem');
    expect(query(url).query.type).toBe('Awakened Empower Support');
    expect(query(url).query.name).toBeUndefined();
  });

  test('uniques search by name (not type), variant stripped', () => {
    const url = buildTradeSearchUrl('poe1', 'Mirage', 'Mageblood (5 Flasks)', 'UniqueAccessory');
    expect(query(url).query.name).toBe('Mageblood');
    expect(query(url).query.type).toBeUndefined();
  });

  test('linked-unique variant like (6L) is stripped from the name', () => {
    const url = buildTradeSearchUrl('poe1', 'Mirage', 'Tabula Rasa (6L)', 'UniqueArmour');
    expect(query(url).query.name).toBe('Tabula Rasa');
  });

  test('plain currency keeps its type and the priced+online defaults', () => {
    const url = buildTradeSearchUrl('poe1', 'Mirage', 'Divine Orb', 'Currency');
    const q = query(url);
    expect(q.query.type).toBe('Divine Orb');
    expect(q.query.status).toEqual({ option: 'online' });
    expect(q.query.filters).toBeUndefined(); // no invalid sale_type filter
  });

  test('poe2 uses the trade2 route, available status, and strips variants', () => {
    const url = buildTradeSearchUrl('poe2', 'Runes of Aldur', 'Exalted Orb', 'Currency');
    expect(url).toContain('/trade2/search/poe2/Runes%20of%20Aldur?q=');
    expect(query(url).query.status).toEqual({ option: 'available' });
  });

  test('category is optional — falls back to type search', () => {
    const url = buildTradeSearchUrl('poe1', 'Mirage', 'Chaos Orb');
    expect(query(url).query.type).toBe('Chaos Orb');
  });
});
