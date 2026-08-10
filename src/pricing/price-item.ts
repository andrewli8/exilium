import type { MarketLine, MarketSnapshot, PriceQuote } from '../domain/types.js';
import { volumeConfidence } from '../signals/stats.js';
import { matchesSearch } from '../tui/search.js';

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
    // The item's own variant lines ("Mageblood (5 Flasks)") outrank arbitrary
    // lines that merely contain the name ("Squandered Highlands (Foil
    // Mageblood)" — a Valdo map, priced very differently).
    [...all].sort(byVolume).find((c) => c.line.name.toLowerCase().startsWith(`${q} (`)) ??
    [...all].sort(byVolume).find((c) => matchesSearch(`${c.line.name} ${c.line.itemId}`, query)) ??
    null;

  if (match === null) return null;
  const { line, snapshot } = match;
  const { primary, perPrimary } = snapshot.core;
  const conversions = Object.fromEntries(
    Object.entries(perPrimary)
      .filter(([currency]) => currency !== primary)
      .map(([currency, rate]) => [currency, line.primaryValue * rate]),
  );

  return {
    itemId: line.itemId,
    name: line.name,
    game: snapshot.game,
    league: snapshot.league,
    primaryCurrency: primary,
    primaryValue: line.primaryValue,
    conversions,
    confidence: volumeConfidence(line.volumePrimaryValue),
    asOf: snapshot.fetchedAt,
  };
}
