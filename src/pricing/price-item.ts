import type { MarketLine, MarketSnapshot, PriceQuote } from '../domain/types.js';
import { volumeConfidence } from '../signals/stats.js';

interface Candidate {
  readonly line: MarketLine;
  readonly snapshot: MarketSnapshot;
}

/** Price a currency/stackable by id or name against the latest snapshots.
 * Match order: exact id, exact name (case-insensitive), then substring
 * (highest volume wins). Returns null when nothing matches.
 * Rare-item valuation is out of scope by design (PRD §6). */
export function priceItem(query: string, snapshots: readonly MarketSnapshot[]): PriceQuote | null {
  const q = query.trim().toLowerCase();
  if (q === '') throw new Error('price_item query must be non-empty');

  const all: readonly Candidate[] = snapshots.flatMap((snapshot) =>
    snapshot.lines.map((line) => ({ line, snapshot })),
  );

  const byVolume = (a: Candidate, b: Candidate) => b.line.volumePrimaryValue - a.line.volumePrimaryValue;
  const match =
    all.find((c) => c.line.itemId.toLowerCase() === q) ??
    all.find((c) => c.line.name.toLowerCase() === q) ??
    [...all].sort(byVolume).find((c) => c.line.name.toLowerCase().includes(q) || c.line.itemId.toLowerCase().includes(q)) ??
    null;

  if (match === null) return null;
  const { line, snapshot } = match;
  const { perDivine } = snapshot.core;
  const toUnits = (currency: string): number | null => {
    const rate = perDivine[currency];
    return rate === undefined ? null : line.primaryValue * rate;
  };

  return {
    itemId: line.itemId,
    name: line.name,
    league: snapshot.league,
    divineValue: line.primaryValue,
    exaltedValue: toUnits('exalted'),
    chaosValue: toUnits('chaos'),
    confidence: volumeConfidence(line.volumePrimaryValue),
    asOf: snapshot.fetchedAt,
  };
}
