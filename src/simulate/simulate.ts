import { createDb } from '../storage/db.js';
import { SnapshotRepository } from '../storage/snapshot-repository.js';
import { WatchRepository } from '../storage/watch-repository.js';
import { ExiliumService } from '../mcp/service.js';
import type { FiredWatchEvent } from '../mcp/service.js';
import type { MarketSnapshot } from '../domain/types.js';
import type { Watch } from '../storage/watch-repository.js';

/** Simulation harness: exercise watches and the snipe pipeline against
 * synthetic market movement. Everything runs in an in-memory database —
 * the real store and pathofexile.com are never touched. Built for exactly
 * the league-downtime case where no live movement exists to test against. */

export interface Move {
  readonly query: string;
  readonly pct: number;
}

export function parseMoves(input: string): readonly Move[] {
  return input.split(',').map((raw) => {
    const token = raw.trim();
    const m = /^(.+?):\s*([+-]?\d+(?:\.\d+)?)%?$/.exec(token);
    if (m === null) {
      throw new Error(`Could not parse move "${token}". Expected "<item>:<+/-pct>", e.g. "divine:+10, ambush scarab:-30".`);
    }
    return { query: m[1]!.trim(), pct: Number(m[2]) };
  });
}

export interface ApplyResult {
  readonly snapshot: MarketSnapshot;
  readonly applied: readonly string[];
  /** Queries that matched at least one line in THIS snapshot. */
  readonly matched: readonly string[];
  readonly unmatched: readonly string[];
}

export function applyMoves(snapshot: MarketSnapshot, moves: readonly Move[], newFetchedAt: string): ApplyResult {
  const applied: string[] = [];
  const matchedQueries = new Set<string>();
  const lines = snapshot.lines.map((line) => {
    const move = moves.find(
      (mv) =>
        line.itemId.toLowerCase() === mv.query.toLowerCase() ||
        line.name.toLowerCase().includes(mv.query.toLowerCase()),
    );
    if (move === undefined) return line;
    matchedQueries.add(move.query);
    applied.push(`${line.name} ${move.pct >= 0 ? '+' : ''}${move.pct}%`);
    return { ...line, primaryValue: line.primaryValue * (1 + move.pct / 100) };
  });
  const unmatched = moves.map((m) => m.query).filter((q) => !matchedQueries.has(q));
  return { snapshot: { ...snapshot, fetchedAt: newFetchedAt, lines }, applied, matched: [...matchedQueries], unmatched };
}

/** Deterministic PRNG so simulations replay identically per seed. */
export function rng(seed: number): () => number {
  let a = seed;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export function randomMoves(snapshot: MarketSnapshot, count: number, random: () => number): readonly Move[] {
  const lines = [...snapshot.lines];
  const moves: Move[] = [];
  for (let i = 0; i < count && lines.length > 0; i++) {
    const idx = Math.floor(random() * lines.length);
    const line = lines.splice(idx, 1)[0]!;
    const pct = Math.round((random() * 80 - 40) * 10) / 10; // ±40%
    moves.push({ query: line.itemId, pct });
  }
  return moves;
}

export interface SimulationRound {
  readonly round: number;
  readonly applied: readonly string[];
  readonly unmatched: readonly string[];
  readonly fired: readonly FiredWatchEvent[];
}

export interface SimulationResult {
  readonly rounds: readonly SimulationRound[];
}

export interface SimulationInput {
  readonly snapshots: readonly MarketSnapshot[];
  readonly watches: readonly Watch[];
  /** Moves to apply per round; each entry is one evaluation cycle. */
  readonly rounds: readonly (readonly Move[])[];
  readonly startIso: string;
}

/** Replay rounds of synthetic movement through the REAL watch pipeline
 * (storage, evaluation, dedupe, once-mode deactivation) in memory. */
export function runWatchSimulation(input: SimulationInput): SimulationResult {
  const db = createDb(':memory:');
  const snapRepo = new SnapshotRepository(db);
  const watchRepo = new WatchRepository(db);
  for (const s of input.snapshots) snapRepo.save(s);
  for (const w of input.watches) watchRepo.upsert(w);
  const service = new ExiliumService(snapRepo, undefined, watchRepo);

  let current = [...input.snapshots];
  const startMs = Date.parse(input.startIso);
  const rounds: SimulationRound[] = [];
  for (let r = 0; r < input.rounds.length; r++) {
    const stamp = new Date(startMs + r * 60_000).toISOString();
    const applied: string[] = [];
    const matchedAnywhere = new Set<string>();
    current = current.map((snap) => {
      const result = applyMoves(snap, input.rounds[r]!, stamp);
      applied.push(...result.applied);
      for (const q of result.matched) matchedAnywhere.add(q.toLowerCase());
      return result.snapshot;
    });
    // A query is only unmatched if NO category snapshot matched it.
    const unmatched = input.rounds[r]!
      .map((m) => m.query)
      .filter((q) => !matchedAnywhere.has(q.toLowerCase()));
    for (const snap of current) snapRepo.save(snap);
    const fired = service.runWatchEvaluation();
    rounds.push({ round: r + 1, applied, unmatched, fired });
  }
  return { rounds };
}

export interface FakeListing {
  readonly id: string;
  readonly itemName: string;
  readonly amount: number;
  readonly currency: string;
  readonly seller: string;
}

/** A fetchFn for handleNewListings that fabricates trade-API responses —
 * the whole snipe pipeline (whisper, clipboard, notification) runs for real
 * against synthetic listings. */
export function makeFakeListingFetch(
  listings: readonly FakeListing[],
): (url: string, init: { headers: Record<string, string> }) => Promise<Response> {
  const byId = new Map(listings.map((l) => [l.id, l]));
  return async (url: string) => {
    const idsPart = /\/fetch\/([^?]+)/.exec(url)?.[1] ?? '';
    const result = idsPart
      .split(',')
      .map((id) => byId.get(id))
      .filter((l): l is FakeListing => l !== undefined)
      .map((l) => ({
        id: l.id,
        listing: {
          whisper: `@${l.seller} Hi, I would like to buy your ${l.itemName} listed for ${l.amount} ${l.currency} (SIMULATED)`,
          price: { amount: l.amount, currency: l.currency },
          account: { name: l.seller, lastCharacterName: l.seller },
        },
        item: { name: '', typeLine: l.itemName },
      }));
    return new Response(JSON.stringify({ result }), { status: 200 });
  };
}
