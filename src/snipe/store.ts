import type { CatalogEntry } from './catalog.js';
import type { SnipeAlert } from './engine.js';
import {
  projectListingTable,
  projectSearchCandidateBoard,
  type ListingTable,
  type SearchCandidateBoard,
} from './board.js';
import {
  createQueueState,
  queueReducer,
  type SnipeQueueAction,
  type SnipeQueueState,
} from './queue.js';

export type SnipeSearchState =
  | 'stopped'
  | 'connecting'
  | 'live'
  | 'seeding'
  | 'cooldown'
  | 'rate-limited'
  | 'reconnecting'
  | 'auth-required';

export interface SnipeSearchSnapshot {
  readonly target: CatalogEntry;
  readonly state: SnipeSearchState;
  readonly detail: string | null;
}

export interface SnipeSnapshot {
  readonly searches: readonly SnipeSearchSnapshot[];
  readonly queue: SnipeQueueState;
  readonly board: SearchCandidateBoard;
  readonly table: ListingTable;
  readonly floor: number;
  readonly progress: { readonly seeded: number; readonly total: number };
  readonly status: string | null;
  /** True while an inline prompt (threshold entry) owns the keyboard; a host
   * TUI must mute its own shortcuts (tab switching, quit) while set. */
  readonly keyboardCapture: boolean;
  /** Flat profit threshold (chaos + the label as entered, e.g. "5d");
   * overrides the percent floor while set. */
  readonly flatFloor: { readonly chaos: number; readonly label: string } | null;
  /** Chaos per divine from the latest snapshots; lets the UI convert "5d"
   * threshold input. Null until price data arrives. */
  readonly chaosPerDivine: number | null;
}

export interface SnipeStoreOptions {
  readonly minMarginPct?: number;
  readonly maxEntries?: number;
  readonly maxRememberedIds?: number;
}

export class SnipeStore {
  private searches: SnipeSearchSnapshot[];
  private queue: SnipeQueueState;
  private floor: number;
  private progress: SnipeSnapshot['progress'];
  private status: string | null = null;
  private keyboardCapture = false;
  private flatFloor: { readonly chaos: number; readonly label: string } | null = null;
  private chaosPerDivine: number | null = null;
  private readonly listeners = new Set<() => void>();
  private readonly rememberedIds = new Set<string>();
  private readonly rememberedOrder: string[] = [];
  private readonly maxRememberedIds: number;
  private current: SnipeSnapshot;

  constructor(targets: readonly CatalogEntry[], options: SnipeStoreOptions = {}) {
    this.searches = targets.map((target) => ({ target, state: 'stopped', detail: null }));
    this.floor = options.minMarginPct ?? 0;
    this.queue = {
      ...createQueueState(options.maxEntries ?? 200),
      selectedTargetId: targets[0]?.key ?? null,
    };
    this.progress = { seeded: 0, total: targets.length };
    this.maxRememberedIds = options.maxRememberedIds ?? Math.max(1_000, (options.maxEntries ?? 200) * 10);
    this.current = this.buildSnapshot();
  }

  readonly snapshot = (): SnipeSnapshot => this.current;

  readonly subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };

  ingest(alert: SnipeAlert, receivedAt = new Date().toISOString()): void {
    if (this.rememberedIds.has(alert.listingId)) return;
    this.remember(alert.listingId);
    this.queue = queueReducer(this.queue, { type: 'add', alert, receivedAt });
    this.rebuild();
  }

  dispatch(action: SnipeQueueAction): void {
    if (action.type === 'move' && this.queue.view === 'board') {
      const rows = this.current.table.rows;
      if (rows.length === 0) return;
      const currentIndex = Math.max(0, rows.findIndex((row) => row.entry.alert.listingId === this.queue.selectedListingId));
      const nextIndex = Math.max(0, Math.min(rows.length - 1, currentIndex + action.delta));
      const row = rows[nextIndex]!;
      this.queue = {
        ...this.queue,
        selectedTargetId: row.entry.alert.targetId,
        selectedListingId: row.entry.alert.listingId,
      };
    } else {
      this.queue = queueReducer(this.queue, action);
    }
    this.rebuild();
  }

  setSearchState(targetId: string, state: SnipeSearchState, detail: string | null = null): void {
    this.searches = this.searches.map((search) =>
      search.target.key === targetId ? { ...search, state, detail } : search,
    );
    this.rebuild();
  }

  setTargets(targets: readonly CatalogEntry[]): void {
    const existing = new Map(this.searches.map((search) => [search.target.key, search]));
    this.searches = targets.map((target) => {
      const prior = existing.get(target.key);
      return { target, state: prior?.state ?? 'stopped', detail: prior?.detail ?? null };
    });
    if (!targets.some((target) => target.key === this.queue.selectedTargetId)) {
      this.queue = {
        ...this.queue,
        selectedTargetId: targets[0]?.key ?? null,
        selectedListingId: null,
        view: 'board',
      };
    }
    this.progress = { seeded: Math.min(this.progress.seeded, targets.length), total: targets.length };
    this.rebuild();
  }

  setProgress(seeded: number, total: number): void {
    this.progress = { seeded, total };
    this.rebuild();
  }

  setFloor(floor: number): void {
    if (!Number.isFinite(floor) || floor < 0) return;
    this.floor = floor;
    this.flatFloor = null;
    this.queue = queueReducer(this.queue, { type: 'reconcile-floor', minMarginPct: floor });
    this.rebuild();
  }

  setFlatFloor(chaos: number, label: string): void {
    if (!Number.isFinite(chaos) || chaos < 0) return;
    this.flatFloor = { chaos, label };
    this.rebuild();
  }

  setChaosPerDivine(rate: number | null): void {
    if (rate !== null && (!Number.isFinite(rate) || rate <= 0)) return;
    if (this.chaosPerDivine === rate) return;
    this.chaosPerDivine = rate;
    this.rebuild();
  }

  setStatus(status: string | null): void {
    this.status = status;
    this.rebuild();
  }

  setKeyboardCapture(capture: boolean): void {
    if (this.keyboardCapture === capture) return;
    this.keyboardCapture = capture;
    this.rebuild();
  }

  private remember(listingId: string): void {
    this.rememberedIds.add(listingId);
    this.rememberedOrder.push(listingId);
    while (this.rememberedOrder.length > this.maxRememberedIds) {
      const expired = this.rememberedOrder.shift();
      if (expired !== undefined) this.rememberedIds.delete(expired);
    }
  }

  private buildSnapshot(): SnipeSnapshot {
    const board = projectSearchCandidateBoard(this.queue, {
      showHidden: this.queue.showHidden,
      minMarginPct: this.floor,
      targets: this.searches.map((search) => ({
        targetId: search.target.key,
        targetLabel: search.target.label,
      })),
    });
    return {
      searches: this.searches,
      queue: this.queue,
      board,
      table: projectListingTable(this.queue, {
        minMarginPct: this.floor,
        ...(this.flatFloor === null ? {} : { flatFloorChaos: this.flatFloor.chaos }),
      }),
      floor: this.floor,
      progress: this.progress,
      status: this.status,
      keyboardCapture: this.keyboardCapture,
      flatFloor: this.flatFloor,
      chaosPerDivine: this.chaosPerDivine,
    };
  }

  private rebuild(): void {
    this.current = this.buildSnapshot();
    if (this.current.board.groups.length > 0 && this.queue.selectedTargetId === null) {
      this.queue = { ...this.queue, selectedTargetId: this.current.board.groups[0]!.targetId };
      this.current = this.buildSnapshot();
    }
    if (this.queue.selectedListingId === null && this.current.table.rows.length > 0) {
      this.queue = { ...this.queue, selectedListingId: this.current.table.rows[0]!.entry.alert.listingId };
      this.current = this.buildSnapshot();
    }
    for (const listener of this.listeners) listener();
  }
}
