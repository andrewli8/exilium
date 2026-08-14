import type { MarketLine, MarketSnapshot, PriceQuote } from '../domain/types.js';
import { volumeConfidence } from '../signals/stats.js';
import { matchesSearch } from '../tui/search.js';

interface Candidate {
  readonly line: MarketLine;
  readonly snapshot: MarketSnapshot;
}

interface CandidateIndex {
  readonly byId: ReadonlyMap<string, Candidate>;
  readonly byName: ReadonlyMap<string, Candidate>;
  /** All candidates, highest volume first — sorted once, reused. */
  readonly byVolume: readonly Candidate[];
}

/** The snipe hot path prices every incoming listing against the same cached
 * snapshots array; flat-scanning and re-sorting ~35k lines per call cost
 * tens of milliseconds. Index once per distinct snapshots array instead. */
const indexCache = new WeakMap<object, CandidateIndex>();

function buildIndex(snapshots: readonly MarketSnapshot[]): CandidateIndex {
  const byId = new Map<string, Candidate>();
  const byName = new Map<string, Candidate>();
  const byVolume: Candidate[] = [];
  for (const snapshot of snapshots) {
    for (const line of snapshot.lines) {
      const candidate = { line, snapshot };
      byVolume.push(candidate);
      const id = line.itemId.toLowerCase();
      if (!byId.has(id)) byId.set(id, candidate);
      const name = line.name.toLowerCase();
      if (!byName.has(name)) byName.set(name, candidate);
    }
  }
  byVolume.sort((a, b) => b.line.volumePrimaryValue - a.line.volumePrimaryValue);
  return { byId, byName, byVolume };
}

function indexFor(snapshots: readonly MarketSnapshot[]): CandidateIndex {
  const cached = indexCache.get(snapshots);
  if (cached !== undefined) return cached;
  const index = buildIndex(snapshots);
  indexCache.set(snapshots, index);
  return index;
}

/** Price a currency/stackable by id or name against the latest snapshots.
 * Match order: exact id, exact name (case-insensitive), then substring
 * (highest volume wins). Returns null when nothing matches.
 * Rare-item valuation is out of scope by design (PRD §6). */
export function priceItem(query: string, snapshots: readonly MarketSnapshot[]): PriceQuote | null {
  const q = query.trim().toLowerCase();
  if (q === '') throw new Error('price_item query must be non-empty');

  const index = indexFor(snapshots);
  const match =
    index.byId.get(q) ??
    index.byName.get(q) ??
    // The item's own variant lines ("Mageblood (5 Flasks)") outrank arbitrary
    // lines that merely contain the name ("Squandered Highlands (Foil
    // Mageblood)" — a Valdo map, priced very differently).
    index.byVolume.find((c) => c.line.name.toLowerCase().startsWith(`${q} (`)) ??
    index.byVolume.find((c) => matchesSearch(`${c.line.name} ${c.line.itemId}`, query)) ??
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
