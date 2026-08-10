import React, { useEffect, useReducer, useRef, useState } from 'react';
import { Box, Text, render, useApp, useInput, type RenderOptions } from 'ink';
import type { SnipeTarget } from './bettertrading.js';
import type { SnipeAlert } from './engine.js';
import {
  createQueueState,
  queueReducer,
  selectedQueueEntry,
  type SnipeQueueEntry,
} from './queue.js';
import {
  createSelectionState,
  selectionReducer,
  targetSelectionId,
} from './selection.js';
import type { TravelResult } from './travel.js';
import { fold, glyphs } from '../tui/glyphs.js';
import { projectCandidateBoard, type CandidateGroup } from './board.js';
import type { SnipeStore } from './store.js';
import { SnipeBoardView } from './board-view.js';

export interface SnipeTargetPickerProps {
  readonly targets: readonly SnipeTarget[];
  readonly onSubmit: (targets: readonly SnipeTarget[]) => void;
  readonly onCancel: () => void;
}

export function SnipeTargetPicker({ targets, onSubmit, onCancel }: SnipeTargetPickerProps) {
  const [state, dispatch] = useReducer(selectionReducer, targets, createSelectionState);
  const { exit } = useApp();

  useInput((input, key) => {
    if (key.upArrow) dispatch({ type: 'move', delta: -1 });
    else if (key.downArrow) dispatch({ type: 'move', delta: 1 });
    else if (input === ' ') dispatch({ type: 'toggle' });
    else if (input.toLowerCase() === 'a') dispatch({ type: 'toggle-all' });
    else if (/^[1-9]$/.test(input)) dispatch({ type: 'toggle-index', index: Number(input) - 1 });
    else if (key.return) {
      if (state.selectedIds.size === 0) return;
      const selected = targets.filter((target) => state.selectedIds.has(targetSelectionId(target)));
      onSubmit(selected);
      exit(selected);
    } else if (key.escape) {
      onCancel();
      exit([]);
    }
  });

  return (
    <Box flexDirection="column">
      <Text bold>{fold('Choose Better Trading searches for this run')}</Text>
      <Text dimColor>{fold(`${glyphs.upDown} move ${glyphs.sep} Space/1-9 toggle ${glyphs.sep} a all ${glyphs.sep} ${glyphs.enterKey} enable ${glyphs.sep} Esc cancel`)}</Text>
      {targets.map((target, index) => {
        const selected = state.selectedIds.has(targetSelectionId(target));
        return (
          <Text key={targetSelectionId(target)} inverse={state.cursor === index}>
            {state.cursor === index ? glyphs.select : ' '} {index + 1}. {selected ? '[x]' : '[ ]'} {fold(target.label)}
          </Text>
        );
      })}
      {state.selectedIds.size === 0 ? <Text dimColor>Select at least one search to enable it.</Text> : null}
    </Box>
  );
}

export async function promptSnipeTargets(
  targets: readonly SnipeTarget[],
  options?: RenderOptions,
): Promise<readonly SnipeTarget[]> {
  const instance = render(
    <SnipeTargetPicker targets={targets} onSubmit={() => undefined} onCancel={() => undefined} />,
    options,
  );
  const result = await instance.waitUntilExit();
  return Array.isArray(result) ? result as readonly SnipeTarget[] : [];
}

export interface SnipeQueueAppProps {
  readonly alerts: readonly SnipeAlert[];
  readonly onTravel: (alert: SnipeAlert) => Promise<TravelResult>;
  readonly onExit?: () => void;
  readonly now?: () => number;
  readonly searchCount?: number;
  readonly minMarginPct?: number;
}

const MAX_INGESTED_LISTING_IDS = 1_000;

function ageText(receivedAt: string, now: number): string {
  const seconds = Math.max(0, Math.floor((now - Date.parse(receivedAt)) / 1_000));
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  return minutes < 60 ? `${minutes}m` : `${Math.floor(minutes / 60)}h`;
}

function percentText(entry: SnipeQueueEntry): string {
  const value = entry.alert.marginPct;
  return value === null ? 'unknown' : `${value >= 0 ? '+' : ''}${value.toFixed(1)}%`;
}

function shortFailure(detail: string): string {
  if (/Could not attach|connectOverCDP|Browser\.setDownloadBehavior|Chrome unavailable|connection is closed/i.test(detail)) {
    return 'Chrome unavailable — run exilium chrome, then press Enter again';
  }
  const firstLine = detail.split('\n', 1)[0]!.trim();
  return firstLine.length <= 100 ? firstLine : `${firstLine.slice(0, 97)}…`;
}

function groupStatus(group: CandidateGroup): string {
  const status = group.best.status;
  if (status === 'traveling') return 'TRAVELING';
  if (status === 'failed') return 'FAILED';
  return group.best.alert.source === 'live' ? 'LIVE' : 'CURRENT';
}

function groupRow(group: CandidateGroup, selected: boolean, now: number): string {
  const marker = selected ? glyphs.select : ' ';
  const status = groupStatus(group).padEnd(9);
  const target = fold(group.targetLabel).slice(0, 24).padEnd(24);
  const price = fold(group.best.alert.priceText).slice(0, 12).padStart(12);
  const profit = percentText(group.best).padStart(9);
  const listed = ageText(group.best.alert.listedAt ?? group.best.receivedAt, now).padStart(7);
  const more = group.moreCount === 0 ? '' : `+${group.moreCount}`;
  return `${marker} ${status} ${target} ${price} ${profit} ${listed} ${more}`.trimEnd();
}

function detailRow(entry: SnipeQueueEntry, selected: boolean, now: number): string {
  const marker = selected ? glyphs.select : ' ';
  const item = fold(entry.alert.itemName).slice(0, 32).padEnd(32);
  const price = fold(entry.alert.priceText).slice(0, 12).padStart(12);
  const profit = percentText(entry).padStart(9);
  const listed = ageText(entry.alert.listedAt ?? entry.receivedAt, now).padStart(7);
  const status = entry.status === 'traveling' ? ' TRAVELING' : entry.status === 'failed' ? ' FAILED' : '';
  return `${marker} ${item} ${price} ${profit} ${listed}${status}`.trimEnd();
}

function rowColor(entry: SnipeQueueEntry, floor: number): 'green' | 'cyan' | 'yellow' | 'red' {
  if (entry.status === 'failed') return 'red';
  const effectiveFloor = entry.alert.targetMinMarginPct ?? floor;
  if (entry.alert.unknownMargin || entry.alert.stale || entry.alert.marginPct === null || entry.alert.marginPct < effectiveFloor) return 'yellow';
  if (entry.alert.source === 'live') return 'cyan';
  return 'green';
}

export function SnipeQueueApp({ alerts, onTravel, onExit, now, searchCount, minMarginPct }: SnipeQueueAppProps) {
  const [state, dispatch] = useReducer(queueReducer, undefined, () => createQueueState());
  const inFlight = useRef(new Set<string>());
  const ingestedIds = useRef(new Set<string>());
  const ingestedOrder = useRef<string[]>([]);
  const { exit } = useApp();
  const clock = now ?? Date.now;
  const [floor, setFloor] = useState(minMarginPct ?? 0);
  const [floorInput, setFloorInput] = useState<string | null>(null);
  const alertSignature = alerts.map((alert) => alert.listingId).join('\u0000');

  useEffect(() => {
    for (const alert of alerts) {
      if (ingestedIds.current.has(alert.listingId)) continue;
      ingestedIds.current.add(alert.listingId);
      ingestedOrder.current.push(alert.listingId);
      while (ingestedOrder.current.length > MAX_INGESTED_LISTING_IDS) {
        const expired = ingestedOrder.current.shift();
        if (expired !== undefined) ingestedIds.current.delete(expired);
      }
      dispatch({ type: 'add', alert, receivedAt: new Date(clock()).toISOString() });
    }
  }, [alertSignature, clock]);

  const beginTravel = (entry: SnipeQueueEntry): void => {
    const listingId = entry.alert.listingId;
    if (!['new', 'failed'].includes(entry.status) || inFlight.current.has(listingId)) return;
    inFlight.current.add(listingId);
    dispatch({ type: 'travel-start', listingId });
    void onTravel(entry.alert)
      .then((result) => {
        if (result.action === 'traveled') {
          dispatch({ type: 'travel-success', listingId, detail: result.detail });
        } else if (result.action === 'gone') {
          dispatch({ type: 'remove-gone', listingId });
        } else {
          dispatch({ type: 'travel-failure', listingId, detail: result.technicalDetail ?? result.detail });
        }
      })
      .catch((error: unknown) => {
        dispatch({
          type: 'travel-failure',
          listingId,
          detail: error instanceof Error ? error.message : String(error),
        });
      })
      .finally(() => inFlight.current.delete(listingId));
  };

  useInput((input, key) => {
    if (floorInput !== null) {
      if (key.escape) setFloorInput(null);
      else if (key.return) {
        const parsed = Number(floorInput);
        if (floorInput !== '' && Number.isFinite(parsed) && parsed >= 0) {
          setFloor(parsed);
          dispatch({ type: 'reconcile-floor', minMarginPct: parsed });
        }
        setFloorInput(null);
      } else if (key.backspace || key.delete) setFloorInput((value) => value?.slice(0, -1) ?? null);
      else if (/^[0-9.]+$/.test(input) && !(input.includes('.') && floorInput.includes('.'))) setFloorInput(`${floorInput}${input}`);
      return;
    }
    if (key.upArrow) dispatch({ type: 'move', delta: key.shift ? -10 : -1, minMarginPct: floor });
    else if (key.downArrow) dispatch({ type: 'move', delta: key.shift ? 10 : 1, minMarginPct: floor });
    else if (key.return && key.shift) dispatch({ type: 'open-detail', minMarginPct: floor });
    else if (key.tab && key.shift) dispatch({ type: 'previous-view', minMarginPct: floor });
    else if (key.tab) dispatch({ type: 'next-view', minMarginPct: floor });
    else if (key.escape) dispatch({ type: 'board' });
    else if (input.toLowerCase() === 'u') dispatch({ type: 'toggle-hidden', minMarginPct: floor });
    else if (input.toLowerCase() === 't' || input.toLowerCase() === 'f') setFloorInput('');
    else if (input === '?') dispatch({ type: 'toggle-details' });
    else if (input.toLowerCase() === 'q') {
      onExit?.();
      exit();
    } else {
      const entry = selectedQueueEntry(state, floor);
      if (entry === undefined) return;
      if (key.return) beginTravel(entry);
      else if (input.toLowerCase() === 'r' && entry.status === 'failed') beginTravel(entry);
      else if (input.toLowerCase() === 'd') dispatch({ type: 'dismiss', listingId: entry.alert.listingId });
    }
  });

  const board = projectCandidateBoard(state, { showHidden: state.showHidden, minMarginPct: floor });
  const selectedGroup = board.groups.find((group) => group.targetId === state.selectedTargetId);
  const liveSearchCount = searchCount ?? new Set(state.entries.map((entry) => entry.alert.targetId)).size;
  const failed = selectedQueueEntry(state, floor);
  const failureNotice = failed?.status === 'failed' && failed.detail !== null ? `✗ ${shortFailure(failed.detail)}` : null;
  const notice = failureNotice ?? state.notice ?? ' ';

  return (
    <Box flexDirection="column">
      <Text bold>{fold(state.view === 'detail' && selectedGroup !== undefined
        ? `EXILIUM SNIPES / ${selectedGroup.targetLabel.toUpperCase()}`
        : 'EXILIUM SNIPES')}</Text>
      <Text>
        <Text color="cyan">{fold(`● ${liveSearchCount} LIVE`)}</Text>
        <Text dimColor>{fold(` ${glyphs.sep} Chrome on demand`)}</Text>
      </Text>
      {state.view === 'board' ? (
        <>
          <Text>{fold(`Floor +${floor}% ${glyphs.sep} Sort PROFIT ↓ / RECENCY ${glyphs.sep} ${board.groups.length} candidate${board.groups.length === 1 ? '' : 's'}`)}</Text>
          <Text dimColor>{'  STATUS    TARGET                     BEST PRICE    PROFIT  LISTED MORE'}</Text>
          {board.groups.length === 0
            ? <Text dimColor>{fold(`0 candidates ${glyphs.sep} waiting for +${floor}% opportunities`)}</Text>
            : board.groups.map((group) => (
              <Text
                key={group.targetId}
                inverse={group.targetId === state.selectedTargetId}
                color={rowColor(group.best, floor)}
              >
                {groupRow(group, group.targetId === state.selectedTargetId, clock())}
              </Text>
            ))}
          <Text dimColor>{fold(`${board.groups.length} shown ${glyphs.sep} ${board.belowFloorCount} below floor ${glyphs.sep} ${board.unknownCount} unknown`)}</Text>
          <Text dimColor>{fold(`${glyphs.upDown} select ${glyphs.sep} ${glyphs.enterKey} travel best ${glyphs.sep} Shift+Enter inspect ${glyphs.sep} u hidden ${glyphs.sep} q quit`)}</Text>
        </>
      ) : (
        <>
          <Text dimColor>{'  VALDO MAP                           PRICE    PROFIT  LISTED'}</Text>
          {selectedGroup?.entries.map((entry) => (
            <Text
              key={entry.alert.listingId}
              inverse={entry.alert.listingId === state.selectedListingId}
              color={rowColor(entry, floor)}
            >
              {detailRow(entry, entry.alert.listingId === state.selectedListingId, clock())}
            </Text>
          )) ?? <Text dimColor>No listings for this search</Text>}
          <Text dimColor>{fold(`${glyphs.upDown} select ${glyphs.sep} ${glyphs.enterKey} travel ${glyphs.sep} Shift+Tab previous ${glyphs.sep} Esc board`)}</Text>
        </>
      )}
      <Text color={failureNotice === null ? 'green' : 'red'}>{fold(notice)}</Text>
      {floorInput === null ? null : (
        <Text color="yellow">{fold(`Set threshold: ${floorInput === '' ? '▌' : `${floorInput}▌`}% ${glyphs.sep} Enter apply ${glyphs.sep} Esc cancel`)}</Text>
      )}
      {state.showDetails && failed?.detail !== null && failed?.detail !== undefined ? (
        <Text dimColor>{fold(`Technical detail: ${failed.detail}`)}</Text>
      ) : null}
    </Box>
  );
}

export interface SnipeConsoleOptions {
  readonly onTravel: (alert: SnipeAlert) => Promise<TravelResult>;
  readonly onExit?: () => void;
  readonly now?: () => number;
  readonly searchCount?: number;
  readonly minMarginPct?: number;
  readonly store?: SnipeStore;
}

export interface SnipeConsoleHandle {
  addAlert(alert: SnipeAlert): void;
  waitUntilExit(): Promise<unknown>;
  close(): void;
}

export async function travelStoreListing(
  store: SnipeStore,
  listingId: string,
  travel: (alert: SnipeAlert) => Promise<TravelResult>,
): Promise<TravelResult> {
  const entry = store.snapshot().queue.entries.find((candidate) => candidate.alert.listingId === listingId);
  if (entry === undefined) return { action: 'gone', detail: 'listing is no longer in the queue' };
  if (entry.status !== 'new' && entry.status !== 'failed') {
    return { action: 'failed', detail: 'travel is already in progress or complete' };
  }
  store.dispatch({ type: 'travel-start', listingId });
  try {
    const result = await travel(entry.alert);
    if (result.action === 'traveled') store.dispatch({ type: 'travel-success', listingId, detail: result.detail });
    else if (result.action === 'gone') store.dispatch({ type: 'remove-gone', listingId });
    else store.dispatch({ type: 'travel-failure', listingId, detail: result.technicalDetail ?? result.detail });
    return result;
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    store.dispatch({ type: 'travel-failure', listingId, detail });
    return { action: 'failed', detail, technicalDetail: detail };
  }
}

export function renderSnipeConsole(
  options: SnipeConsoleOptions,
  renderOptions?: RenderOptions,
): SnipeConsoleHandle {
  if (options.store !== undefined) {
    const store = options.store;
    const instance = render(
      <SnipeBoardView
        store={store}
        onTravel={(listingId) => travelStoreListing(store, listingId, options.onTravel)}
        {...(options.onExit === undefined ? {} : { onExit: options.onExit })}
      />,
      renderOptions,
    );
    return {
      addAlert: (alert) => store.ingest(alert),
      waitUntilExit: () => instance.waitUntilExit(),
      close: () => instance.unmount(),
    };
  }
  let alerts: readonly SnipeAlert[] = [];
  const props = {
    onTravel: options.onTravel,
    ...(options.onExit === undefined ? {} : { onExit: options.onExit }),
    ...(options.now === undefined ? {} : { now: options.now }),
    ...(options.searchCount === undefined ? {} : { searchCount: options.searchCount }),
    ...(options.minMarginPct === undefined ? {} : { minMarginPct: options.minMarginPct }),
  };
  const view = () => <SnipeQueueApp alerts={[...alerts]} {...props} />;
  const instance = render(view(), renderOptions);
  return {
    addAlert(alert) {
      // Props are an event batch, not a second unbounded queue. The component
      // owns bounded history and keeps its reducer state across rerenders.
      alerts = [alert];
      instance.rerender(view());
    },
    waitUntilExit: () => instance.waitUntilExit(),
    close: () => instance.unmount(),
  };
}
