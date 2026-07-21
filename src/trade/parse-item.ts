/** Parse the text block PoE puts on the clipboard when you Ctrl+C an item.
 * Sections are separated by lines of dashes; the header carries class,
 * rarity, name and base. We keep only what a trade query needs. */

export type Rarity = 'Normal' | 'Magic' | 'Rare' | 'Unique' | 'Currency' | 'Gem' | 'Divination Card' | 'Unknown';
export type ModKind = 'implicit' | 'explicit' | 'crafted' | 'enchant' | 'fractured' | 'scourge';

export interface ItemMod {
  readonly text: string;
  readonly kind: ModKind;
}

export interface ParsedItem {
  readonly rarity: Rarity;
  readonly itemClass: string | undefined;
  readonly name: string;
  readonly baseType: string | undefined;
  readonly itemLevel: number | undefined;
  readonly quality: number | undefined;
  readonly links: number | undefined;
  readonly corrupted: boolean;
  readonly mods: readonly ItemMod[];
}

const DIVIDER = /^-{3,}$/;

/** Property/requirement keys that are never mods. */
const META_KEYS = [
  'Requirements', 'Level', 'Str', 'Dex', 'Int', 'Sockets', 'Item Level', 'Quality', 'Stack Size',
  'Armour', 'Evasion Rating', 'Energy Shield', 'Ward', 'Block chance', 'Chance to Block',
  'Physical Damage', 'Elemental Damage', 'Fire Damage', 'Cold Damage', 'Lightning Damage', 'Chaos Damage',
  'Critical Strike Chance', 'Critical Hit Chance', 'Attacks per Second', 'Weapon Range', 'Radius',
  'Limited to', 'Item Class', 'Rarity', 'Talisman Tier', 'Area Level', 'Map Tier', 'Quality (',
];

const FLAGS = new Set(['Corrupted', 'Mirrored', 'Split', 'Unidentified', 'Synthesised Item']);

const TAG_MAP: Readonly<Record<string, ModKind>> = {
  implicit: 'implicit',
  crafted: 'crafted',
  enchant: 'enchant',
  fractured: 'fractured',
  scourge: 'scourge',
};

function isMeta(line: string): boolean {
  return META_KEYS.some((k) => line.startsWith(`${k}:`));
}

export function parseItem(text: string): ParsedItem | null {
  const lines = text.replace(/\r/g, '').split('\n');
  const sections: string[][] = [[]];
  for (const raw of lines) {
    if (DIVIDER.test(raw.trim())) sections.push([]);
    else sections[sections.length - 1]!.push(raw.replace(/\s+$/, ''));
  }
  const header = sections[0]!.map((l) => l.trim()).filter((l) => l !== '');
  const rarityLine = header.find((l) => l.startsWith('Rarity:'));
  if (rarityLine === undefined) return null;

  const rarity = normalizeRarity(rarityLine.slice('Rarity:'.length).trim());
  const itemClass = header.find((l) => l.startsWith('Item Class:'))?.slice('Item Class:'.length).trim();
  const nameLines = header.filter((l) => !l.startsWith('Rarity:') && !l.startsWith('Item Class:'));
  if (nameLines.length === 0) return null;

  const hasBase = rarity === 'Rare' || rarity === 'Unique' || rarity === 'Magic' || rarity === 'Normal';
  const name = nameLines[0]!;
  const baseType = hasBase && nameLines.length > 1 ? nameLines[1] : undefined;

  let itemLevel: number | undefined;
  let quality: number | undefined;
  let links: number | undefined;
  let corrupted = false;
  const mods: ItemMod[] = [];

  for (const section of sections.slice(1)) {
    for (const raw of section) {
      const line = raw.trim();
      if (line === '') continue;
      if (FLAGS.has(line)) {
        if (line === 'Corrupted') corrupted = true;
        continue;
      }
      const ilvl = /^Item Level:\s*(\d+)/.exec(line);
      if (ilvl !== null) { itemLevel = Number(ilvl[1]); continue; }
      const q = /^Quality:\s*\+?(\d+)%/.exec(line);
      if (q !== null) { quality = Number(q[1]); continue; }
      const sock = /^Sockets:\s*(.+)$/.exec(line);
      if (sock !== null) { links = maxLinks(sock[1]!); continue; }
      if (isMeta(line)) continue;
      // A mod line. Peel off a trailing tag like "(implicit)".
      const tagMatch = /\s*\(([a-z]+)\)\s*$/.exec(line);
      const kind = tagMatch !== null ? TAG_MAP[tagMatch[1]!] : undefined;
      if (tagMatch !== null && kind === undefined) continue; // "(augmented)" etc — not a mod tag
      const cleanText = tagMatch !== null ? line.slice(0, tagMatch.index).trim() : line;
      mods.push({ text: cleanText, kind: kind ?? 'explicit' });
    }
  }

  return { rarity, itemClass, name, baseType, itemLevel, quality, links, corrupted, mods };
}

function normalizeRarity(r: string): Rarity {
  const known: Rarity[] = ['Normal', 'Magic', 'Rare', 'Unique', 'Currency', 'Gem', 'Divination Card'];
  return known.find((k) => k === r) ?? 'Unknown';
}

/** Longest run of linked sockets (hyphen-joined group). */
function maxLinks(sockets: string): number {
  return Math.max(0, ...sockets.split(' ').map((group) => group.split('-').length));
}
