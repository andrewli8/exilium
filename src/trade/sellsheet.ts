import type { DetailedMover } from '../mcp/service.js';
import { formatNumber } from '../domain/format-price.js';

/** Dump-tab sell sheet: turn "12 Ambush Scarab of Containment" lines into a
 * priced sheet and a paste-ready bulk WTS message. Pricing comes from the
 * local market store; the discount is how bulk actually clears. */

export interface CountLine {
  readonly count: number;
  readonly query: string;
}

const LINE = /^(\d+)\s*[x×]?\s+(.+)$/;

export function parseCounts(input: string): readonly CountLine[] {
  const rows: CountLine[] = [];
  const lines = input.split('\n');
  for (let i = 0; i < lines.length; i++) {
    const raw = lines[i]!.trim();
    if (raw === '' || raw.startsWith('#')) continue;
    const m = LINE.exec(raw);
    if (m === null) {
      throw new Error(`Could not parse line ${i + 1}: "${raw}". Expected "<count> <item name>", e.g. "12 Ambush Scarab of Containment".`);
    }
    rows.push({ count: Number(m[1]), query: m[2]!.trim() });
  }
  return rows;
}

export interface SellSheetLine {
  readonly count: number;
  readonly name: string;
  readonly marketEach: number;
  readonly askEach: number;
  readonly total: number;
}

export interface SellSheet {
  readonly lines: readonly SellSheetLine[];
  readonly unmatched: readonly string[];
  readonly total: number;
  readonly wtsMessage: string;
}

export function buildSellSheet(
  counts: readonly CountLine[],
  market: readonly DetailedMover[],
  primaryCurrency: string,
  discount = 0,
): SellSheet {
  const lines: SellSheetLine[] = [];
  const unmatched: string[] = [];
  for (const c of counts) {
    const q = c.query.toLowerCase();
    const match =
      market.find((m) => m.name.toLowerCase() === q || m.itemId.toLowerCase() === q) ??
      market.find((m) => m.name.toLowerCase().includes(q));
    if (match === undefined) {
      unmatched.push(c.query);
      continue;
    }
    const askEach = match.primaryValue * (1 - discount);
    lines.push({
      count: c.count,
      name: match.name,
      marketEach: match.primaryValue,
      askEach,
      total: c.count * askEach,
    });
  }
  const total = lines.reduce((a, l) => a + l.total, 0);
  const discountNote = discount > 0 ? ` (${Math.round(discount * 100)}% under market)` : '';
  const parts = lines.map((l) => `${l.count}x ${l.name} @ ${round(l.askEach)}`);
  const wtsMessage =
    lines.length === 0
      ? ''
      : `WTS bulk${discountNote}: ${parts.join(' | ')} — ${round(total)} ${primaryCurrency} the lot`;
  return { lines, unmatched, total, wtsMessage };
}

function round(v: number): string {
  return formatNumber(v);
}
