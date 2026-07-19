export type FreshnessLevel = 'live' | 'stale' | 'old';

export interface Freshness {
  readonly ageSec: number;
  readonly level: FreshnessLevel;
  /** Compact human label: "just now", "4m ago", "3h ago". */
  readonly label: string;
}

const LIVE_MAX_SEC = 10 * 60;
const STALE_MAX_SEC = 30 * 60;

/** Classify how old a snapshot is, for freshness indicators. `nowMs` is
 * injected so callers own the clock (keeps this pure and testable). */
export function assessFreshness(asOf: string | null, nowMs: number): Freshness | null {
  if (asOf === null) return null;
  const ageSec = Math.max(0, Math.floor((nowMs - Date.parse(asOf)) / 1000));
  const level: FreshnessLevel = ageSec <= LIVE_MAX_SEC ? 'live' : ageSec <= STALE_MAX_SEC ? 'stale' : 'old';
  const label =
    ageSec < 60 ? 'just now' : ageSec < 3600 ? `${Math.floor(ageSec / 60)}m ago` : `${Math.floor(ageSec / 3600)}h ago`;
  return { ageSec, level, label };
}
