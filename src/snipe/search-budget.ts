/**
 * Client-side budget for trade searches the browser-live tabs trigger.
 * Every plain search page load runs one search under the account, and the
 * site's search policy escalates fast: overrunning a short window earns a
 * multi-minute lockout, and the locked-out page has no live-search button,
 * which reads as a dead tab and triggers reopens that spend more searches.
 * Staying under the policy client-side breaks that loop.
 */

export interface SearchWindow {
  readonly max: number;
  readonly periodMs: number;
}

/** Below the commonly observed trade search policy (8/10s, 15/60s,
 * 60/300s) with headroom for searches the user runs by hand. */
export const DEFAULT_SEARCH_WINDOWS: readonly SearchWindow[] = [
  { max: 5, periodMs: 10_000 },
  { max: 10, periodMs: 60_000 },
  { max: 40, periodMs: 300_000 },
];

/** Earliest time a new search fits every window, given past search times. */
export function nextSearchSlot(history: readonly number[], now: number, windows: readonly SearchWindow[]): number {
  let at = now;
  for (const { max, periodMs } of windows) {
    const recent = history.filter((t) => t > now - periodMs).sort((a, b) => a - b);
    if (recent.length >= max) at = Math.max(at, recent[recent.length - max]! + periodMs);
  }
  return at;
}

/** Drop history older than the longest window (keeps the list bounded). */
export function pruneSearchHistory(history: readonly number[], now: number, windows: readonly SearchWindow[]): number[] {
  const longest = Math.max(0, ...windows.map((w) => w.periodMs));
  return history.filter((t) => t > now - longest);
}
