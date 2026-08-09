import type { SnipeTarget } from './bettertrading.js';

export interface SelectionState {
  readonly targets: readonly SnipeTarget[];
  readonly cursor: number;
  readonly selectedIds: ReadonlySet<string>;
}

export type SelectionAction =
  | { readonly type: 'move'; readonly delta: number }
  | { readonly type: 'toggle' }
  | { readonly type: 'toggle-index'; readonly index: number }
  | { readonly type: 'toggle-all' };

export interface SelectionRequest {
  readonly isTTY: boolean;
  readonly all: boolean;
  readonly searches: readonly string[];
}

export function targetSelectionId(target: SnipeTarget): string {
  return `${target.realm}:${target.searchId}`;
}

export function createSelectionState(targets: readonly SnipeTarget[]): SelectionState {
  return { targets, cursor: 0, selectedIds: new Set() };
}

function toggleAt(state: SelectionState, index: number): SelectionState {
  const target = state.targets[index];
  if (target === undefined) return state;
  const key = targetSelectionId(target);
  const selectedIds = new Set(state.selectedIds);
  if (selectedIds.has(key)) selectedIds.delete(key);
  else selectedIds.add(key);
  return { ...state, selectedIds };
}

export function selectionReducer(state: SelectionState, action: SelectionAction): SelectionState {
  if (state.targets.length === 0) return state;
  switch (action.type) {
    case 'move':
      return {
        ...state,
        cursor: Math.max(0, Math.min(state.targets.length - 1, state.cursor + action.delta)),
      };
    case 'toggle':
      return toggleAt(state, state.cursor);
    case 'toggle-index':
      return toggleAt(state, action.index);
    case 'toggle-all': {
      const allSelected = state.targets.every((target) => state.selectedIds.has(targetSelectionId(target)));
      return {
        ...state,
        selectedIds: allSelected
          ? new Set()
          : new Set(state.targets.map(targetSelectionId)),
      };
    }
  }
}

function resolveSelector(targets: readonly SnipeTarget[], selector: string): SnipeTarget {
  const normalized = selector.toLowerCase();
  const keyMatches = targets.filter((target) => targetSelectionId(target).toLowerCase() === normalized);
  const idMatches = targets.filter((target) => target.searchId.toLowerCase() === normalized);
  const labelMatches = targets.filter((target) => target.label.toLowerCase() === normalized);
  const matches = keyMatches.length > 0 ? keyMatches : idMatches.length > 0 ? idMatches : labelMatches;
  if (matches.length === 0) throw new Error(`Unknown snipe search selector "${selector}"`);
  if (matches.length > 1) throw new Error(`Ambiguous snipe search selector "${selector}"`);
  return matches[0]!;
}

/** Resolve explicit flags, or return null when an interactive picker should
 * run. Selected results are returned in source order, never selector order. */
export function resolveRequestedTargets(
  targets: readonly SnipeTarget[],
  request: SelectionRequest,
): readonly SnipeTarget[] | null {
  if (request.all) return targets;
  if (request.searches.length === 0) {
    if (request.isTTY) return null;
    throw new Error('Non-interactive snipe runs require --all or at least one --search ID.');
  }
  const selected = new Set(request.searches.map((selector) => targetSelectionId(resolveSelector(targets, selector))));
  return targets.filter((target) => selected.has(targetSelectionId(target)));
}
