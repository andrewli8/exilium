import type { Opportunity } from '../domain/types.js';
import type { IngestError, IngestResult } from '../ingest/ingest.js';
import type { Notifier } from './notify.js';

export interface WatchState {
  readonly seenIds: ReadonlySet<string>;
}

export function initialWatchState(): WatchState {
  return { seenIds: new Set() };
}

export interface WatchDeps {
  /** Refresh market data (may partially fail — errors are reported, not thrown). */
  readonly ingest: () => Promise<IngestResult>;
  /** Current opportunities from the freshly ingested snapshots. */
  readonly opportunities: () => readonly Opportunity[];
  readonly notifier: Notifier;
}

export interface WatchTickResult {
  readonly state: WatchState;
  readonly notified: readonly Opportunity[];
  readonly ingestErrors: readonly IngestError[];
}

const MAX_LISTED = 5;

function formatMessage(opps: readonly Opportunity[]): string {
  const listed = [...opps]
    .sort((a, b) => b.edge - a.edge)
    .slice(0, MAX_LISTED)
    .map((o) => `${o.itemName}: ${(o.edge * 100).toFixed(1)}% edge (${o.kind})`);
  const overflow = opps.length > MAX_LISTED ? ` … and ${opps.length - MAX_LISTED} more` : '';
  return `${listed.join(' · ')}${overflow}`;
}

/** One watch cycle: refresh data, find opportunities not yet notified, send a
 * single batched notification, and return the new (immutable) state. */
export async function watchTick(deps: WatchDeps, state: WatchState): Promise<WatchTickResult> {
  const ingestResult = await deps.ingest();
  const fresh = deps.opportunities().filter((o) => !state.seenIds.has(o.id));
  if (fresh.length > 0) {
    await deps.notifier.notify(
      `Exilium: ${fresh.length} new trade ${fresh.length === 1 ? 'opportunity' : 'opportunities'}`,
      formatMessage(fresh),
    );
  }
  return {
    state: { seenIds: new Set([...state.seenIds, ...fresh.map((o) => o.id)]) },
    notified: fresh,
    ingestErrors: ingestResult.errors,
  };
}
