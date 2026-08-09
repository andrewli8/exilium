import React, { useEffect, useReducer, useRef } from 'react';
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
}

const MAX_INGESTED_LISTING_IDS = 1_000;

function ageText(receivedAt: string, now: number): string {
  const seconds = Math.max(0, Math.floor((now - Date.parse(receivedAt)) / 1_000));
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  return minutes < 60 ? `${minutes}m` : `${Math.floor(minutes / 60)}h`;
}

function rowText(entry: SnipeQueueEntry, selected: boolean, now: number): string {
  const { alert } = entry;
  const status = entry.status.toUpperCase().padEnd(9);
  const marker = selected ? glyphs.select : ' ';
  const details = [alert.priceText, alert.marginText, alert.freshnessText, alert.seller, ageText(alert.listedAt ?? entry.receivedAt, now)]
    .filter((value) => value.length > 0)
    .join(` ${glyphs.sep} `);
  const failure = entry.detail === null ? '' : ` ${glyphs.sep} ${entry.detail}`;
  return fold(`${marker} ${status} ${alert.itemName} (${alert.targetLabel}) ${glyphs.sep} ${details}${failure}`);
}

export function SnipeQueueApp({ alerts, onTravel, onExit, now }: SnipeQueueAppProps) {
  const [state, dispatch] = useReducer(queueReducer, undefined, () => createQueueState());
  const inFlight = useRef(new Set<string>());
  const ingestedIds = useRef(new Set<string>());
  const ingestedOrder = useRef<string[]>([]);
  const { exit } = useApp();
  const clock = now ?? Date.now;
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
        dispatch(result.action === 'traveled'
          ? { type: 'travel-success', listingId, detail: result.detail }
          : { type: 'travel-failure', listingId, detail: result.detail });
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
    if (key.upArrow) dispatch({ type: 'move', delta: -1 });
    else if (key.downArrow) dispatch({ type: 'move', delta: 1 });
    else if (input.toLowerCase() === 'q') {
      onExit?.();
      exit();
    } else {
      const entry = selectedQueueEntry(state);
      if (entry === undefined) return;
      if (key.return) beginTravel(entry);
      else if (input.toLowerCase() === 'r' && entry.status === 'failed') beginTravel(entry);
      else if (input.toLowerCase() === 'd') dispatch({ type: 'dismiss', listingId: entry.alert.listingId });
    }
  });

  return (
    <Box flexDirection="column">
      <Text bold>{fold('EXILIUM SNIPE')}</Text>
      <Text dimColor>{fold(`${glyphs.upDown} select ${glyphs.sep} ${glyphs.enterKey} Travel to Hideout ${glyphs.sep} r retry ${glyphs.sep} d dismiss ${glyphs.sep} q quit`)}</Text>
      {state.entries.length === 0
        ? <Text dimColor>No snipe alerts yet</Text>
        : state.entries.map((entry) => (
          <Text key={entry.alert.listingId} inverse={entry.alert.listingId === state.selectedListingId}>
            {rowText(entry, entry.alert.listingId === state.selectedListingId, clock())}
          </Text>
        ))}
    </Box>
  );
}

export interface SnipeConsoleOptions {
  readonly onTravel: (alert: SnipeAlert) => Promise<TravelResult>;
  readonly onExit?: () => void;
  readonly now?: () => number;
}

export interface SnipeConsoleHandle {
  addAlert(alert: SnipeAlert): void;
  waitUntilExit(): Promise<unknown>;
  close(): void;
}

export function renderSnipeConsole(
  options: SnipeConsoleOptions,
  renderOptions?: RenderOptions,
): SnipeConsoleHandle {
  let alerts: readonly SnipeAlert[] = [];
  const props = {
    onTravel: options.onTravel,
    ...(options.onExit === undefined ? {} : { onExit: options.onExit }),
    ...(options.now === undefined ? {} : { now: options.now }),
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
