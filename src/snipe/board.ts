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

export interface CandidateTarget {
  readonly targetId: string;
  readonly targetLabel: string;
}

export interface SearchCandidateGroup {
  readonly targetId: string;
  readonly targetLabel: string;
  readonly entries: readonly SnipeQueueEntry[];
  readonly best: SnipeQueueEntry | null;
  readonly moreCount: number;
  readonly hiddenCount: number;
}

export interface SearchCandidateBoard extends Omit<CandidateBoard, 'groups'> {
  readonly groups: readonly SearchCandidateGroup[];
}

export interface SearchCandidateBoardOptions extends CandidateBoardOptions {
  readonly targets: readonly CandidateTarget[];
}

export interface ListingRow {
  readonly entry: SnipeQueueEntry;
  readonly qualifies: boolean;
}

export interface ListingTable {
  readonly rows: readonly ListingRow[];
  readonly qualifyingCount: number;
  readonly belowFloorCount: number;
  readonly unknownCount: number;
}

export interface ListingTableOptions {
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

function entryQualifies(entry: SnipeQueueEntry, minMarginPct: number | undefined): boolean {
  if (entry.alert.unknownMargin || entry.alert.marginPct === null) return false;
  const floor = entry.alert.targetMinMarginPct ?? minMarginPct;
  return floor === undefined ? entry.alert.qualifiesMargin : entry.alert.marginPct >= floor;
}

export function projectListingTable(
  state: Pick<SnipeQueueState, 'entries'>,
  options: ListingTableOptions = {},
): ListingTable {
  const entries = state.entries.filter(active);
  const rows = entries
    .map((entry): ListingRow => ({ entry, qualifies: entryQualifies(entry, options.minMarginPct) }))
    .sort((left, right) => {
      const recency = listedTime(right.entry) - listedTime(left.entry);
      if (recency !== 0) return recency;
      return Date.parse(right.entry.receivedAt) - Date.parse(left.entry.receivedAt);
    });
  const unknownCount = rows.filter((row) => row.entry.alert.unknownMargin).length;
  const qualifyingCount = rows.filter((row) => row.qualifies).length;
  return {
    rows,
    qualifyingCount,
    belowFloorCount: rows.length - qualifyingCount - unknownCount,
    unknownCount,
  };
}

export function projectCandidateBoard(
  state: Pick<SnipeQueueState, 'entries'>,
  options: CandidateBoardOptions,
): CandidateBoard {
  const entries = state.entries.filter(active);
  const qualifies = (entry: SnipeQueueEntry): boolean => entryQualifies(entry, options.minMarginPct);
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

export function projectSearchCandidateBoard(
  state: Pick<SnipeQueueState, 'entries'>,
  options: SearchCandidateBoardOptions,
): SearchCandidateBoard {
  const visible = projectCandidateBoard(state, options);
  const all = projectCandidateBoard(state, { ...options, showHidden: true });
  const visibleByTarget = new Map(visible.groups.map((group, index) => [group.targetId, { group, index }]));
  const allByTarget = new Map(all.groups.map((group) => [group.targetId, group]));
  const configuredIds = new Set(options.targets.map((target) => target.targetId));
  const targets = [
    ...options.targets,
    ...all.groups
      .filter((group) => !configuredIds.has(group.targetId))
      .map((group) => ({ targetId: group.targetId, targetLabel: group.targetLabel })),
  ];
  const configuredOrder = new Map(targets.map((target, index) => [target.targetId, index]));
  const groups = targets.map((target): SearchCandidateGroup => {
    const shown = visibleByTarget.get(target.targetId)?.group;
    const every = allByTarget.get(target.targetId);
    const entries = shown?.entries ?? [];
    return {
      targetId: target.targetId,
      targetLabel: target.targetLabel,
      entries,
      best: shown?.best ?? null,
      moreCount: Math.max(0, entries.length - 1),
      hiddenCount: Math.max(0, (every?.entries.length ?? 0) - entries.length),
    };
  }).sort((left, right) => {
    const leftRank = visibleByTarget.get(left.targetId)?.index;
    const rightRank = visibleByTarget.get(right.targetId)?.index;
    if (leftRank !== undefined && rightRank !== undefined) return leftRank - rightRank;
    if (leftRank !== undefined) return -1;
    if (rightRank !== undefined) return 1;
    return (configuredOrder.get(left.targetId) ?? 0) - (configuredOrder.get(right.targetId) ?? 0);
  });
  return {
    groups,
    qualifyingCount: visible.qualifyingCount,
    belowFloorCount: visible.belowFloorCount,
    unknownCount: visible.unknownCount,
  };
}
