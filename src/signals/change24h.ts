import type { PricePoint } from '../storage/snapshot-repository.js';

/** 24-hour change, best source first:
 * 1. Our own stored history — price now vs the snapshot closest to 24h ago
 *    (accepted window 18–30h, so cron gaps don't disqualify it).
 * 2. poe.ninja's sparkline — cumulative daily points, so the last two points
 *    isolate the most recent day segment.
 * Callers fall back from (1) to (2); both can be null on day one. */

const TARGET_MS = 24 * 3600_000;
const MIN_MS = 18 * 3600_000;
const MAX_MS = 30 * 3600_000;

export function change24hFromHistory(
  currentPrice: number,
  history: readonly PricePoint[],
  nowMs: number,
): number | null {
  let best: { price: number; distance: number } | null = null;
  for (const p of history) {
    const age = nowMs - Date.parse(p.fetchedAt);
    if (age < MIN_MS || age > MAX_MS || p.primaryValue <= 0) continue;
    const distance = Math.abs(age - TARGET_MS);
    if (best === null || distance < best.distance) best = { price: p.primaryValue, distance };
  }
  if (best === null) return null;
  return ((currentPrice - best.price) / best.price) * 100;
}

export function change24hFromSparkline(cumulative: readonly number[]): number | null {
  if (cumulative.length < 2) return null;
  const last = cumulative[cumulative.length - 1]!;
  const prev = cumulative[cumulative.length - 2]!;
  return ((1 + last / 100) / (1 + prev / 100) - 1) * 100;
}
