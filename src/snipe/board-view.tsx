import React, { useState, useSyncExternalStore } from 'react';
import { Box, Text, useInput } from 'ink';
import type { SnipeStore } from './store.js';
import type { TravelResult } from './travel.js';
import { fold, glyphs } from '../tui/glyphs.js';

export interface SnipeBoardViewProps {
  readonly store: SnipeStore;
  readonly onTravel: (listingId: string) => Promise<TravelResult>;
  readonly active?: boolean;
  readonly embedded?: boolean;
  readonly onExit?: () => void;
}

function age(value: string | null, now = Date.now()): string {
  if (value === null) return '-';
  const seconds = Math.max(0, Math.floor((now - Date.parse(value)) / 1_000));
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  return minutes < 60 ? `${minutes}m` : `${Math.floor(minutes / 60)}h`;
}

function shortFailure(detail: string): string {
  if (/Could not attach|connectOverCDP|Browser\.setDownloadBehavior|Chrome unavailable/i.test(detail)) {
    return 'Chrome unavailable — run exilium chrome, then press Enter again';
  }
  const firstLine = detail.split('\n', 1)[0]!.trim();
  return firstLine.length <= 100 ? firstLine : `${firstLine.slice(0, 97)}…`;
}

export function SnipeBoardView({ store, onTravel, active = true, embedded = false, onExit }: SnipeBoardViewProps) {
  const snapshot = useSyncExternalStore(store.subscribe, store.snapshot, store.snapshot);
  const [notice, setNotice] = useState<string | null>(null);
  const [floorInput, setFloorInput] = useState<string | null>(null);
  const selected = snapshot.board.groups.find((group) => group.targetId === snapshot.queue.selectedTargetId);

  useInput((input, key) => {
    if (!active) return;
    if (floorInput !== null) {
      if (key.escape) setFloorInput(null);
      else if (key.return) {
        const parsed = Number(floorInput);
        if (floorInput !== '' && Number.isFinite(parsed) && parsed >= 0) store.setFloor(parsed);
        setFloorInput(null);
      } else if (key.delete) setFloorInput('');
      else if (key.backspace) setFloorInput((value) => value?.slice(0, -1) ?? null);
      else if (/^[0-9.]$/.test(input)) setFloorInput((value) => `${value ?? ''}${input}`);
      return;
    }
    if (input.toLowerCase() === 'q' && !embedded) onExit?.();
    else if (key.upArrow) store.dispatch({ type: 'move', delta: -1, minMarginPct: snapshot.floor });
    else if (key.downArrow) store.dispatch({ type: 'move', delta: 1, minMarginPct: snapshot.floor });
    else if (key.return && key.shift) {
      if (selected?.best === null && selected.hiddenCount > 0 && !snapshot.queue.showHidden) {
        store.dispatch({ type: 'toggle-hidden', minMarginPct: snapshot.floor });
      }
      store.dispatch({ type: 'open-detail', minMarginPct: snapshot.floor });
    }
    else if ((key.escape || (key.tab && key.shift)) && snapshot.queue.view === 'detail') store.dispatch({ type: 'board' });
    else if (input.toLowerCase() === 'u') store.dispatch({ type: 'toggle-hidden', minMarginPct: snapshot.floor });
    else if (input.toLowerCase() === 'f') setFloorInput('');
    else if (key.return) {
      const listing = snapshot.queue.view === 'detail'
        ? selected?.entries.find((entry) => entry.alert.listingId === snapshot.queue.selectedListingId) ?? selected?.best
        : selected?.best;
      if (listing === null || listing === undefined) {
        setNotice(`No candidate meets +${snapshot.floor}% for ${selected?.targetLabel ?? 'this search'} — press u to inspect hidden listings`);
        return;
      }
      setNotice(null);
      void onTravel(listing.alert.listingId);
    }
  }, { isActive: active });

  const states = new Map(snapshot.searches.map((search) => [search.target.key, search]));
  const seeding = snapshot.searches.some((search) => search.state === 'seeding' || search.state === 'cooldown' || search.state === 'rate-limited');
  const limiterStatus = snapshot.status !== null && /^(?:COOLDOWN|RATE LIMITED)\b/.test(snapshot.status)
    ? snapshot.status
    : null;
  const headerStatus = limiterStatus ?? (seeding
    ? `SEEDING ${snapshot.progress.seeded}/${snapshot.progress.total}`
    : `${snapshot.searches.filter((search) => search.state === 'live').length} LIVE`);
  const selectedEntry = snapshot.queue.view === 'detail'
    ? selected?.entries.find((entry) => entry.alert.listingId === snapshot.queue.selectedListingId) ?? selected?.best
    : selected?.best;
  const failure = selectedEntry?.status === 'failed' && selectedEntry.detail !== null
    ? shortFailure(selectedEntry.detail)
    : null;

  return (
    <Box flexDirection="column">
      {!embedded && <Text bold>EXILIUM SNIPES</Text>}
      <Text color="cyan">{fold(`${headerStatus} ${glyphs.sep} Floor +${snapshot.floor}% ${glyphs.sep} Chrome on demand`)}</Text>
      {snapshot.queue.view === 'board' ? <>
        <Text dimColor>{'  STATE         SEARCH                    BEST       PROFIT     AGE  OTHER'}</Text>
        {snapshot.board.groups.map((group) => {
          const search = states.get(group.targetId);
          const best = group.best;
          const state = (search?.state ?? 'stopped').toUpperCase().replace('-', ' ');
          const other = group.hiddenCount === 0 ? '' : `${group.hiddenCount} hidden`;
          const line = `${group.targetId === snapshot.queue.selectedTargetId ? glyphs.select : ' '} ${state.padEnd(13)} ${fold(group.targetLabel).slice(0, 24).padEnd(24)} ${(best?.alert.priceText ?? 'NO MATCH').slice(0, 10).padStart(10)} ${(best?.alert.marginPct === null || best === null ? '-' : `${best.alert.marginPct >= 0 ? '+' : ''}${best.alert.marginPct.toFixed(1)}%`).padStart(10)} ${age(best?.alert.listedAt ?? null).padStart(7)}  ${other}`;
          return <Text key={group.targetId} inverse={group.targetId === snapshot.queue.selectedTargetId}>{line}</Text>;
        })}
        <Text dimColor>{fold(`${snapshot.board.qualifyingCount} qualifying ${glyphs.sep} ${snapshot.board.belowFloorCount} below floor ${glyphs.sep} ${snapshot.board.unknownCount} unknown`)}</Text>
        <Text dimColor>{fold(`${glyphs.upDown} searches ${glyphs.sep} Enter travel best ${glyphs.sep} Shift+Enter inspect ${glyphs.sep} u hidden ${glyphs.sep} f floor ${glyphs.sep} c configure`)}</Text>
      </> : <>
        <Text bold>{fold(selected?.targetLabel ?? 'SNIPE DETAILS')}</Text>
        {selected?.entries.map((entry) => (
          <Text key={entry.alert.listingId} inverse={entry.alert.listingId === snapshot.queue.selectedListingId}>
            {`${entry.alert.itemName.slice(0, 34).padEnd(34)} ${entry.alert.priceText.padStart(12)} ${(entry.alert.marginPct === null ? '-' : `${entry.alert.marginPct.toFixed(1)}%`).padStart(8)} ${age(entry.alert.listedAt).padStart(6)}`}
          </Text>
        ))}
        {(selected?.entries.length ?? 0) === 0 && <Text dimColor>No listings for this search — press u on the board to reveal hidden listings.</Text>}
        <Text dimColor>Enter travel · Esc board</Text>
      </>}
      {(failure ?? notice ?? snapshot.status ?? snapshot.queue.notice) !== null && <Text color={failure === null ? 'yellow' : 'red'}>{fold((failure ?? notice ?? snapshot.status ?? snapshot.queue.notice)!)}</Text>}
      {floorInput !== null && <Text color="yellow">{`Set session floor: ${floorInput}▌% · Enter apply · Esc cancel`}</Text>}
    </Box>
  );
}
