import { describe, expect, test } from 'vitest';
import { parseItem } from '../src/trade/parse-item.js';

const RARE = `Item Class: Body Armours
Rarity: Rare
Doom Shell
Saintly Chainmail
--------
Quality: +20% (augmented)
Armour: 728 (augmented)
--------
Requirements:
Level: 62
Str: 138
--------
Sockets: R-R-R-R-R-R
--------
Item Level: 84
--------
+12% to Fire and Lightning Resistances (implicit)
--------
+95 to maximum Life
+45% to Cold Resistance
17% increased Stun and Block Recovery
--------
Corrupted
--------`;

const UNIQUE = `Item Class: Gloves
Rarity: Unique
Facebreaker
Strapped Mitts
--------
Requirements:
Level: 16
--------
Sockets: R-R-R-R
--------
Item Level: 68
--------
+25 to Strength (implicit)
--------
600% increased Unarmed Physical Damage
--------
Your movements are slow and steady`;

const CURRENCY = `Item Class: Stackable Currency
Rarity: Currency
Divine Orb
--------
Stack Size: 5/10
--------
Randomises the numeric values of the random modifiers on an item`;

describe('parseItem', () => {
  test('parses a rare item: class, name, base, ilvl, quality, links, corruption, mods', () => {
    const item = parseItem(RARE)!;
    expect(item.rarity).toBe('Rare');
    expect(item.itemClass).toBe('Body Armours');
    expect(item.name).toBe('Doom Shell');
    expect(item.baseType).toBe('Saintly Chainmail');
    expect(item.itemLevel).toBe(84);
    expect(item.quality).toBe(20);
    expect(item.links).toBe(6);
    expect(item.corrupted).toBe(true);
    const explicit = item.mods.filter((m) => m.kind === 'explicit').map((m) => m.text);
    expect(explicit).toContain('+95 to maximum Life');
    expect(explicit).toContain('+45% to Cold Resistance');
    expect(item.mods.find((m) => m.kind === 'implicit')?.text).toBe('+12% to Fire and Lightning Resistances');
  });

  test('does not mistake requirement/property lines for mods', () => {
    const item = parseItem(RARE)!;
    const texts = item.mods.map((m) => m.text);
    expect(texts).not.toContain('Str: 138');
    expect(texts).not.toContain('Armour: 728 (augmented)');
    expect(texts).not.toContain('Corrupted');
  });

  test('parses a unique by name and base', () => {
    const item = parseItem(UNIQUE)!;
    expect(item.rarity).toBe('Unique');
    expect(item.name).toBe('Facebreaker');
    expect(item.baseType).toBe('Strapped Mitts');
    expect(item.links).toBe(4);
  });

  test('parses stackable currency (name only, no base)', () => {
    const item = parseItem(CURRENCY)!;
    expect(item.rarity).toBe('Currency');
    expect(item.name).toBe('Divine Orb');
    expect(item.baseType).toBeUndefined();
  });

  test('returns null for non-item text', () => {
    expect(parseItem('just some chat message')).toBeNull();
    expect(parseItem('')).toBeNull();
  });
});
