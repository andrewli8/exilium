import React, { useEffect, useState, useSyncExternalStore } from 'react';
import { Box, Text, useInput } from 'ink';
import type { SnipeStore } from './store.js';
import type { TravelResult } from './travel.js';
import type { ListingRow } from './board.js';
import { formatNumber } from '../domain/format-price.js';
import { fold, glyphs } from '../tui/glyphs.js';

export interface SnipeBoardViewProps {
  readonly store: SnipeStore;
  readonly onTravel: (listingId: string) => Promise<TravelResult>;
  readonly active?: boolean;
  readonly embedded?: boolean;
  readonly onExit?: () => void;
}

const MAX_TABLE_ROWS = 12;

function age(value: string | null, now = Date.now()): string {
  if (value === null) return '-';
  const seconds = Math.max(0, Math.floor((now - Date.parse(value)) / 1_000));
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  return minutes < 60 ? `${minutes}m` : `${Math.floor(minutes / 60)}h`;
}

function profitText(row: ListingRow): string {
  const chaos = row.entry.alert.marginChaos;
  if (chaos === null) return '?';
  return `${chaos >= 0 ? '+' : '-'}${formatNumber(Math.abs(chaos))}c`;
}

function rowText(row: ListingRow, now: number): string {
  const alert = row.entry.alert;
  const price = fold(alert.priceText).slice(0, 11).padEnd(11);
  const profit = profitText(row).slice(0, 9).padEnd(9);
  const time = age(alert.listedAt ?? row.entry.receivedAt, now).padEnd(5);
  const reward = fold(alert.itemName).slice(0, 34);
  const status = row.entry.status === 'traveling' ? '  TRAVELING' : row.entry.status === 'failed' ? '  FAILED' : '';
  return `${price} ${profit} ${time} ${reward}${status}`;
}

function shortFailure(detail: string): string {
  if (/Could not attach|connectOverCDP|Browser\.setDownloadBehavior|Chrome unavailable|connection is closed/i.test(detail)) {
    return 'Chrome unavailable — run exilium chrome, then press Enter again';
  }
  const firstLine = detail.split('\n', 1)[0]!.trim();
  return firstLine.length <= 100 ? firstLine : `${firstLine.slice(0, 97)}…`;
}

export function SnipeBoardView({ store, onTravel, active = true, embedded = false, onExit }: SnipeBoardViewProps) {
  const snapshot = useSyncExternalStore(store.subscribe, store.snapshot, store.snapshot);
  const [notice, setNotice] = useState<string | null>(null);
  const [floorInput, setFloorInput] = useState<string | null>(null);
  useEffect(() => {
    store.setKeyboardCapture(floorInput !== null);
    return () => store.setKeyboardCapture(false);
  }, [floorInput, store]);
  const rows = snapshot.table.rows;
  const selectedRow = rows.find((row) => row.entry.alert.listingId === snapshot.queue.selectedListingId) ?? rows[0];
  const selectedGroup = snapshot.board.groups.find((group) => group.targetId === snapshot.queue.selectedTargetId);

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
      else if (/^[0-9.]+$/.test(input)) setFloorInput((value) => `${value ?? ''}${input}`);
      return;
    }
    if (input.toLowerCase() === 'q' && !embedded) onExit?.();
    else if (key.upArrow) store.dispatch({ type: 'move', delta: -1, minMarginPct: snapshot.floor });
    else if (key.downArrow) store.dispatch({ type: 'move', delta: 1, minMarginPct: snapshot.floor });
    else if (key.return && key.shift) {
      if (selectedGroup?.best === null && selectedGroup.hiddenCount > 0 && !snapshot.queue.showHidden) {
        store.dispatch({ type: 'toggle-hidden', minMarginPct: snapshot.floor });
      }
      store.dispatch({ type: 'open-detail', minMarginPct: snapshot.floor });
    }
    else if ((key.escape || (key.tab && key.shift)) && snapshot.queue.view === 'detail') store.dispatch({ type: 'board' });
    else if (input.toLowerCase() === 'u') store.dispatch({ type: 'toggle-hidden', minMarginPct: snapshot.floor });
    else if (input.toLowerCase() === 't' || input.toLowerCase() === 'f') setFloorInput('');
    else if (key.return) {
      const listing = snapshot.queue.view === 'detail'
        ? selectedGroup?.entries.find((entry) => entry.alert.listingId === snapshot.queue.selectedListingId) ?? selectedGroup?.best
        : selectedRow?.entry;
      if (listing === null || listing === undefined) {
        setNotice('No listings yet — live searches will fill this table the moment something is posted');
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
  const detailEntry = snapshot.queue.view === 'detail'
    ? selectedGroup?.entries.find((entry) => entry.alert.listingId === snapshot.queue.selectedListingId) ?? selectedGroup?.best
    : selectedRow?.entry;
  const failure = detailEntry?.status === 'failed' && detailEntry.detail !== null
    ? shortFailure(detailEntry.detail)
    : null;
  const travelSent = snapshot.queue.notice === 'Travel sent' ? snapshot.queue.notice : null;
  const otherNotice = failure ?? notice ?? snapshot.status ?? (travelSent === null ? snapshot.queue.notice : null);

  const selectedIndex = Math.max(0, rows.findIndex((row) => row.entry.alert.listingId === selectedRow?.entry.alert.listingId));
  const windowStart = Math.min(
    Math.max(0, selectedIndex - MAX_TABLE_ROWS + 1),
    Math.max(0, rows.length - MAX_TABLE_ROWS),
  );
  const visibleRows = rows.slice(windowStart, windowStart + MAX_TABLE_ROWS);
  const hiddenAbove = windowStart;
  const hiddenBelow = Math.max(0, rows.length - windowStart - MAX_TABLE_ROWS);

  return (
    <Box flexDirection="column">
      {!embedded && <Text bold>EXILIUM SNIPES</Text>}
      {travelSent !== null && <Text color="green">{travelSent}</Text>}
      {failure !== null && <Text color="red">{fold(failure)}</Text>}
      {failure === null && otherNotice !== null && <Text color="yellow">{fold(otherNotice)}</Text>}
      <Text color="cyan">{fold(`${headerStatus} ${glyphs.sep} Chrome on demand`)}</Text>
      <Text dimColor>{fold(`Threshold: +${snapshot.floor}% profit ${glyphs.sep} press t to change`)}</Text>
      {snapshot.queue.view === 'board' ? <>
        {rows.length === 0 ? <>
          <Text dimColor>{fold(`Watching ${snapshot.searches.length} search${snapshot.searches.length === 1 ? '' : 'es'} — waiting for listings`)}</Text>
          {snapshot.searches.map((search) => (
            <Text key={search.target.key} dimColor>
              {`  ${(states.get(search.target.key)?.state ?? 'stopped').toUpperCase().replace('-', ' ').padEnd(13)} ${fold(search.target.label)}`}
            </Text>
          ))}
        </> : <>
          <Text dimColor>{'  PRICE       PROFIT    TIME  REWARD'}</Text>
          {hiddenAbove > 0 && <Text dimColor>{`  ↑ ${hiddenAbove} newer hidden`}</Text>}
          {visibleRows.map((row) => {
            const isSelected = row.entry.alert.listingId === selectedRow?.entry.alert.listingId;
            const line = `${isSelected ? glyphs.select : ' '} ${rowText(row, Date.now())}`;
            if (row.entry.status === 'failed') return <Text key={row.entry.alert.listingId} inverse={isSelected} color="red">{line}</Text>;
            if (!row.qualifies) return <Text key={row.entry.alert.listingId} inverse={isSelected} dimColor>{line}</Text>;
            return <Text key={row.entry.alert.listingId} inverse={isSelected} bold>{line}</Text>;
          })}
          {hiddenBelow > 0 && <Text dimColor>{`  ↓ ${hiddenBelow} older hidden`}</Text>}
          <Text dimColor>{fold(`${snapshot.table.qualifyingCount} above threshold ${glyphs.sep} ${snapshot.table.belowFloorCount} below ${glyphs.sep} ${snapshot.table.unknownCount} unknown`)}</Text>
        </>}
        <Text dimColor>{fold(`${glyphs.upDown} select ${glyphs.sep} Enter travel ${glyphs.sep} Shift+Enter inspect ${glyphs.sep} t threshold ${glyphs.sep} c configure`)}</Text>
      </> : <>
        <Text bold>{fold(selectedGroup?.targetLabel ?? 'SNIPE DETAILS')}</Text>
        {selectedGroup?.entries.map((entry) => (
          <Text key={entry.alert.listingId} inverse={entry.alert.listingId === snapshot.queue.selectedListingId}>
            {`${entry.alert.itemName.slice(0, 34).padEnd(34)} ${entry.alert.priceText.padStart(12)} ${(entry.alert.marginPct === null ? '-' : `${entry.alert.marginPct.toFixed(1)}%`).padStart(8)} ${age(entry.alert.listedAt).padStart(6)}`}
          </Text>
        ))}
        {(selectedGroup?.entries.length ?? 0) === 0 && <Text dimColor>No listings for this search — press u on the board to reveal hidden listings.</Text>}
        <Text dimColor>Enter travel · Esc board</Text>
      </>}
      {floorInput !== null && <Text color="yellow">{`Set threshold: ${floorInput}▌% · Enter apply · Esc cancel`}</Text>}
    </Box>
  );
}
