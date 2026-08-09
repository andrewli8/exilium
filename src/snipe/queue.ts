import type { SnipeAlert } from './engine.js';

export type TravelStatus = 'new' | 'traveling' | 'traveled' | 'failed';

export interface SnipeQueueEntry {
  readonly alert: SnipeAlert;
  readonly status: TravelStatus;
  readonly detail: string | null;
  readonly receivedAt: string;
}

export interface SnipeQueueState {
  readonly entries: readonly SnipeQueueEntry[];
  readonly selectedListingId: string | null;
  readonly maxEntries: number;
}

export type SnipeQueueAction =
  | { readonly type: 'add'; readonly alert: SnipeAlert; readonly receivedAt: string }
  | { readonly type: 'move'; readonly delta: number }
  | { readonly type: 'travel-start'; readonly listingId: string }
  | { readonly type: 'travel-success'; readonly listingId: string; readonly detail: string }
  | { readonly type: 'travel-failure'; readonly listingId: string; readonly detail: string }
  | { readonly type: 'dismiss'; readonly listingId: string };

export function createQueueState(maxEntries = 200): SnipeQueueState {
  return { entries: [], selectedListingId: null, maxEntries };
}

export function selectedQueueEntry(state: SnipeQueueState): SnipeQueueEntry | undefined {
  return state.entries.find((entry) => entry.alert.listingId === state.selectedListingId);
}

function addEntry(state: SnipeQueueState, alert: SnipeAlert, receivedAt: string): SnipeQueueState {
  if (state.entries.some((entry) => entry.alert.listingId === alert.listingId)) return state;
  const entries = [
    { alert, receivedAt, status: 'new' as const, detail: null },
    ...state.entries,
  ];
  const selectedListingId = state.selectedListingId ?? alert.listingId;
  while (entries.length > state.maxEntries) {
    let removeIndex = entries.length - 1;
    while (removeIndex >= 0 && entries[removeIndex]?.alert.listingId === selectedListingId) removeIndex -= 1;
    if (removeIndex < 0) break;
    entries.splice(removeIndex, 1);
  }
  return { ...state, entries, selectedListingId };
}

function moveSelection(state: SnipeQueueState, delta: number): SnipeQueueState {
  if (state.entries.length === 0) return state;
  const current = Math.max(0, state.entries.findIndex((entry) => entry.alert.listingId === state.selectedListingId));
  const next = Math.max(0, Math.min(state.entries.length - 1, current + delta));
  return { ...state, selectedListingId: state.entries[next]!.alert.listingId };
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
  const selectedListingId = state.selectedListingId === listingId
    ? entries[Math.min(removedIndex, entries.length - 1)]?.alert.listingId ?? null
    : state.selectedListingId;
  return { ...state, entries, selectedListingId };
}

export function queueReducer(state: SnipeQueueState, action: SnipeQueueAction): SnipeQueueState {
  switch (action.type) {
    case 'add':
      return addEntry(state, action.alert, action.receivedAt);
    case 'move':
      return moveSelection(state, action.delta);
    case 'travel-start':
      return transition(state, action.listingId, ['new', 'failed'], 'traveling', null);
    case 'travel-success':
      return transition(state, action.listingId, ['traveling'], 'traveled', action.detail);
    case 'travel-failure':
      return transition(state, action.listingId, ['traveling'], 'failed', action.detail);
    case 'dismiss':
      return dismiss(state, action.listingId);
  }
}
