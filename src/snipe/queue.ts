import type { SnipeAlert } from './engine.js';
import { projectCandidateBoard } from './board.js';

export type TravelStatus = 'new' | 'traveling' | 'traveled' | 'failed';

export interface SnipeQueueEntry {
  readonly alert: SnipeAlert;
  readonly status: TravelStatus;
  readonly detail: string | null;
  readonly receivedAt: string;
}

export interface SnipeQueueState {
  readonly entries: readonly SnipeQueueEntry[];
  readonly view: 'board' | 'detail';
  readonly selectedTargetId: string | null;
  readonly selectedListingId: string | null;
  readonly showHidden: boolean;
  readonly showDetails: boolean;
  readonly notice: string | null;
  readonly maxEntries: number;
}

export type SnipeQueueAction =
  | { readonly type: 'add'; readonly alert: SnipeAlert; readonly receivedAt: string }
  | { readonly type: 'move'; readonly delta: number; readonly minMarginPct?: number }
  | { readonly type: 'travel-start'; readonly listingId: string }
  | { readonly type: 'travel-success'; readonly listingId: string; readonly detail: string }
  | { readonly type: 'travel-failure'; readonly listingId: string; readonly detail: string }
  | { readonly type: 'dismiss'; readonly listingId: string }
  | { readonly type: 'remove-gone'; readonly listingId: string }
  | { readonly type: 'open-detail'; readonly minMarginPct?: number }
  | { readonly type: 'next-view'; readonly minMarginPct?: number }
  | { readonly type: 'previous-view'; readonly minMarginPct?: number }
  | { readonly type: 'board' }
  | { readonly type: 'toggle-hidden'; readonly minMarginPct?: number }
  | { readonly type: 'reconcile-floor'; readonly minMarginPct: number }
  | { readonly type: 'toggle-details' };

export function createQueueState(maxEntries = 200): SnipeQueueState {
  return {
    entries: [],
    view: 'board',
    selectedTargetId: null,
    selectedListingId: null,
    showHidden: false,
    showDetails: false,
    notice: null,
    maxEntries,
  };
}

export function selectedQueueEntry(state: SnipeQueueState, minMarginPct?: number): SnipeQueueEntry | undefined {
  const board = projectCandidateBoard(state, {
    showHidden: state.showHidden,
    ...(minMarginPct === undefined ? {} : { minMarginPct }),
  });
  const group = board.groups.find((candidate) => candidate.targetId === state.selectedTargetId);
  if (group === undefined) return undefined;
  if (state.view === 'board') return group.best;
  return group.entries.find((entry) => entry.alert.listingId === state.selectedListingId) ?? group.best;
}

function addEntry(state: SnipeQueueState, alert: SnipeAlert, receivedAt: string): SnipeQueueState {
  if (state.entries.some((entry) => entry.alert.listingId === alert.listingId)) return state;
  const entries = [
    { alert, receivedAt, status: 'new' as const, detail: null },
    ...state.entries,
  ];
  const selectedTargetId = state.selectedTargetId ?? alert.targetId;
  const selectedListingId = state.selectedListingId ?? alert.listingId;
  while (entries.length > state.maxEntries) {
    let removeIndex = entries.length - 1;
    while (removeIndex >= 0 && entries[removeIndex]?.alert.listingId === selectedListingId) removeIndex -= 1;
    if (removeIndex < 0) break;
    entries.splice(removeIndex, 1);
  }
  return { ...state, entries, selectedTargetId, selectedListingId };
}

function boardAtFloor(state: SnipeQueueState, minMarginPct?: number) {
  return projectCandidateBoard(state, {
    showHidden: state.showHidden,
    ...(minMarginPct === undefined ? {} : { minMarginPct }),
  });
}

function moveSelection(state: SnipeQueueState, delta: number, minMarginPct?: number): SnipeQueueState {
  const board = boardAtFloor(state, minMarginPct);
  if (board.groups.length === 0) return state;
  if (state.view === 'detail') {
    const group = board.groups.find((candidate) => candidate.targetId === state.selectedTargetId);
    if (group === undefined || group.entries.length === 0) return state;
    const current = Math.max(0, group.entries.findIndex((entry) => entry.alert.listingId === state.selectedListingId));
    const next = Math.max(0, Math.min(group.entries.length - 1, current + delta));
    return { ...state, selectedListingId: group.entries[next]!.alert.listingId };
  }
  const current = Math.max(0, board.groups.findIndex((group) => group.targetId === state.selectedTargetId));
  const next = Math.max(0, Math.min(board.groups.length - 1, current + delta));
  const group = board.groups[next]!;
  return { ...state, selectedTargetId: group.targetId, selectedListingId: group.best.alert.listingId };
}

function transition(
  state: SnipeQueueState,
  listingId: string,
  from: readonly TravelStatus[],
  status: TravelStatus,
  detail: string | null,
): SnipeQueueState {
  const current = state.entries.find((entry) => entry.alert.listingId === listingId);
  if (current === undefined || !from.includes(current.status)) return state;
  return {
    ...state,
    entries: state.entries.map((entry) =>
      entry.alert.listingId === listingId ? { ...entry, status, detail } : entry,
    ),
  };
}

function dismiss(state: SnipeQueueState, listingId: string): SnipeQueueState {
  const removedIndex = state.entries.findIndex((entry) => entry.alert.listingId === listingId);
  if (removedIndex < 0) return state;
  const entries = state.entries.filter((entry) => entry.alert.listingId !== listingId);
  let selectedListingId = state.selectedListingId === listingId
    ? entries[Math.min(removedIndex, entries.length - 1)]?.alert.listingId ?? null
    : state.selectedListingId;
  let selectedTargetId = state.selectedTargetId;
  const remainingTarget = entries.find((entry) => entry.alert.targetId === selectedTargetId);
  if (remainingTarget === undefined) {
    const replacement = entries[Math.min(removedIndex, entries.length - 1)];
    selectedTargetId = replacement?.alert.targetId ?? null;
    selectedListingId = replacement?.alert.listingId ?? null;
  }
  return { ...state, entries, selectedTargetId, selectedListingId };
}

function setView(state: SnipeQueueState, view: 'board' | 'detail', minMarginPct?: number): SnipeQueueState {
  if (view === 'detail') {
    const board = boardAtFloor(state, minMarginPct);
    const group = board.groups.find((candidate) => candidate.targetId === state.selectedTargetId);
    if (group === undefined) return state;
    return { ...state, view, selectedListingId: group.best.alert.listingId };
  }
  return { ...state, view };
}

export function queueReducer(state: SnipeQueueState, action: SnipeQueueAction): SnipeQueueState {
  switch (action.type) {
    case 'add':
      return addEntry(state, action.alert, action.receivedAt);
    case 'move':
      return moveSelection(state, action.delta, action.minMarginPct);
    case 'travel-start':
      return transition(state, action.listingId, ['new', 'failed'], 'traveling', null);
    case 'travel-success': {
      const next = transition(state, action.listingId, ['traveling'], 'traveled', action.detail);
      return next === state ? state : {
        ...next,
        notice: 'Travel requested successfully — queue updated',
      };
    }
    case 'travel-failure':
      return transition(state, action.listingId, ['traveling'], 'failed', action.detail);
    case 'dismiss':
      return dismiss(state, action.listingId);
    case 'remove-gone': {
      const target = state.entries.find((entry) => entry.alert.listingId === action.listingId)?.alert.targetLabel;
      const next = dismiss(state, action.listingId);
      return { ...next, notice: `${target ?? 'Listing'}: listing sold or removed — queue updated` };
    }
    case 'open-detail':
      return setView(state, 'detail', action.minMarginPct);
    case 'next-view':
      return setView(state, state.view === 'board' ? 'detail' : 'board', action.minMarginPct);
    case 'previous-view':
      return setView(state, state.view === 'board' ? 'detail' : 'board', action.minMarginPct);
    case 'board':
      return setView(state, 'board');
    case 'toggle-hidden': {
      const showHidden = !state.showHidden;
      const next = { ...state, showHidden };
      const board = projectCandidateBoard(next, {
        showHidden,
        ...(action.minMarginPct === undefined ? {} : { minMarginPct: action.minMarginPct }),
      });
      const selected = board.groups.find((group) => group.targetId === next.selectedTargetId) ?? board.groups[0];
      return {
        ...next,
        selectedTargetId: selected?.targetId ?? next.selectedTargetId,
        selectedListingId: selected?.best.alert.listingId ?? next.selectedListingId,
      };
    }
    case 'reconcile-floor': {
      const board = boardAtFloor(state, action.minMarginPct);
      const selected = board.groups.find((group) => group.targetId === state.selectedTargetId) ?? board.groups[0];
      return {
        ...state,
        selectedTargetId: selected?.targetId ?? null,
        selectedListingId: selected?.best.alert.listingId ?? null,
      };
    }
    case 'toggle-details':
      return { ...state, showDetails: !state.showDetails };
  }
}
