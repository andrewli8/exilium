import type { SnipeQueueEntry, SnipeQueueState } from './queue.js';

export interface CandidateGroup {
  readonly targetId: string;
  readonly targetLabel: string;
  readonly entries: readonly SnipeQueueEntry[];
  readonly best: SnipeQueueEntry;
  readonly moreCount: number;
}

export interface CandidateBoard {
  readonly groups: readonly CandidateGroup[];
  readonly qualifyingCount: number;
  readonly belowFloorCount: number;
  readonly unknownCount: number;
}

export interface CandidateBoardOptions {
  readonly showHidden: boolean;
  readonly minMarginPct?: number;
}

function listedTime(entry: SnipeQueueEntry): number {
  const value = entry.alert.listedAt ?? entry.receivedAt;
  const parsed = Date.parse(value);
  return Number.isNaN(parsed) ? Number.NEGATIVE_INFINITY : parsed;
}

function compareEntries(left: SnipeQueueEntry, right: SnipeQueueEntry): number {
  const margin = (right.alert.marginPct ?? Number.NEGATIVE_INFINITY)
    - (left.alert.marginPct ?? Number.NEGATIVE_INFINITY);
  if (margin !== 0) return margin;
  const recency = listedTime(right) - listedTime(left);
  if (recency !== 0) return recency;
  // Modern Array#sort is stable; preserve newest-first queue order for exact ties.
  return 0;
}

function active(entry: SnipeQueueEntry): boolean {
  return entry.status !== 'traveled';
}

export function projectCandidateBoard(
  state: Pick<SnipeQueueState, 'entries'>,
  options: CandidateBoardOptions,
): CandidateBoard {
  const entries = state.entries.filter(active);
  const qualifies = (entry: SnipeQueueEntry): boolean => {
    if (entry.alert.unknownMargin || entry.alert.marginPct === null) return false;
    const floor = entry.alert.targetMinMarginPct ?? options.minMarginPct;
    return floor === undefined
      ? entry.alert.qualifiesMargin
      : entry.alert.marginPct >= floor;
  };
  const unknownCount = entries.filter((entry) => entry.alert.unknownMargin).length;
  const belowFloorCount = entries.filter((entry) =>
    !entry.alert.unknownMargin && !qualifies(entry),
  ).length;
  const qualifyingCount = entries.filter(qualifies).length;
  const visible = options.showHidden ? entries : entries.filter(qualifies);
  const grouped = new Map<string, SnipeQueueEntry[]>();
  for (const entry of visible) {
    const group = grouped.get(entry.alert.targetId) ?? [];
    group.push(entry);
    grouped.set(entry.alert.targetId, group);
  }
  const groups = [...grouped.entries()].map(([targetId, groupEntries]): CandidateGroup => {
    const sorted = [...groupEntries].sort(compareEntries);
    const best = sorted[0]!;
    return {
      targetId,
      targetLabel: best.alert.targetLabel,
      entries: sorted,
      best,
      moreCount: Math.max(0, sorted.length - 1),
    };
  }).sort((left, right) => compareEntries(left.best, right.best));
  return { groups, qualifyingCount, belowFloorCount, unknownCount };
}
