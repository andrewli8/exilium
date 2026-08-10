import React, { useState } from 'react';
import { Box, Text, useInput } from 'ink';
import type { CatalogEntry } from './catalog.js';
import { parseTradeUrl } from '../trade/live-search.js';
import { fold, glyphs } from '../tui/glyphs.js';

type Mode = 'list' | 'import' | 'edit' | 'confirm-delete';

/** Visible list rows; the cursor scrolls the window through longer lists. */
const MAX_LIST_ROWS = 14;

type Row =
  | { readonly kind: 'folder'; readonly group: string; readonly indices: readonly number[] }
  | { readonly kind: 'entry'; readonly index: number };

export interface SnipeConfigureOverlayProps {
  readonly entries: readonly CatalogEntry[];
  readonly onSave: (entries: readonly CatalogEntry[]) => Promise<readonly CatalogEntry[]>;
  readonly onStart: (enabledKeys: readonly string[]) => Promise<void>;
  readonly onClose: () => void;
  readonly onImport?: (source: string) => Promise<readonly CatalogEntry[]>;
  /** Delete one folder group (Backspace on its row, after confirmation). */
  readonly onDeleteFolder?: (group: string) => Promise<readonly CatalogEntry[]>;
}

function tradeUrl(entry: CatalogEntry): string {
  const league = encodeURIComponent(entry.league ?? 'Allflame');
  return entry.realm === 'trade2'
    ? `https://www.pathofexile.com/trade2/search/poe2/${league}/${entry.searchId}`
    : `https://www.pathofexile.com/trade/search/${league}/${entry.searchId}`;
}

/** Folder rows appear as soon as any entry carries a Better Trading folder
 * title; plain URL lists with no groups keep the flat view. */
function buildRows(drafts: readonly CatalogEntry[], expanded: ReadonlySet<string>): readonly Row[] {
  if (!drafts.some((draft) => draft.group !== undefined)) {
    return drafts.map((_, index) => ({ kind: 'entry', index }));
  }
  const order: string[] = [];
  const byGroup = new Map<string, number[]>();
  drafts.forEach((draft, index) => {
    const group = draft.group ?? 'Ungrouped';
    const indices = byGroup.get(group);
    if (indices === undefined) {
      byGroup.set(group, [index]);
      order.push(group);
    } else {
      indices.push(index);
    }
  });
  const rows: Row[] = [];
  for (const group of order) {
    const indices = byGroup.get(group)!;
    rows.push({ kind: 'folder', group, indices });
    if (expanded.has(group)) for (const index of indices) rows.push({ kind: 'entry', index });
  }
  return rows;
}

function entryDisplayLabel(entry: CatalogEntry): string {
  // Inside a folder the leading "<folder> · " is redundant — strip it even
  // when the group name is directory-derived and differs from the payload
  // title (e.g. group "valdos-2", label "valdos · mageblood").
  if (entry.group === undefined) return entry.label;
  const separator = entry.label.indexOf(' · ');
  return separator > 0 ? entry.label.slice(separator + 3) : entry.label;
}

export function SnipeConfigureOverlay({ entries, onSave, onStart, onClose, onImport, onDeleteFolder }: SnipeConfigureOverlayProps) {
  const [drafts, setDrafts] = useState<readonly CatalogEntry[]>(entries);
  const [cursor, setCursor] = useState(0);
  const [expanded, setExpanded] = useState<ReadonlySet<string>>(new Set());
  const [mode, setMode] = useState<Mode>('list');
  const [input, setInput] = useState('');
  const [editField, setEditField] = useState(0);
  const [editTarget, setEditTarget] = useState<number | null>(null);
  const [editValues, setEditValues] = useState<readonly [string, string, string]>(['', '', '']);
  const [deleteGroup, setDeleteGroup] = useState<{ readonly group: string; readonly count: number } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const rows = buildRows(drafts, expanded);
  const selected = rows[Math.min(cursor, Math.max(0, rows.length - 1))];

  const save = async (start: boolean): Promise<void> => {
    if (busy) return;
    setBusy(true);
    setError(null);
    try {
      const saved = await onSave(drafts);
      setDrafts(saved);
      if (start) await onStart(saved.filter((entry) => entry.enabled).map((entry) => entry.key));
      onClose();
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason));
    } finally {
      setBusy(false);
    }
  };

  useInput((value, key) => {
    if (busy) return;
    if (mode === 'import') {
      if (key.escape) { setMode('list'); setInput(''); setError(null); return; }
      if (key.return) {
        if (onImport === undefined) { setError('Import is unavailable'); return; }
        setBusy(true);
        void onImport(input).then((next) => {
          setDrafts(next);
          setMode('list');
          setInput('');
          setError(null);
        }).catch((reason: unknown) => {
          setError(reason instanceof Error ? reason.message : String(reason));
        }).finally(() => setBusy(false));
        return;
      }
      if (key.delete) setInput('');
      else if (key.backspace) setInput((current) => current.slice(0, -1));
      else if (value !== '' && !key.ctrl && !key.meta) setInput((current) => current + value);
      return;
    }
    if (mode === 'edit') {
      if (key.escape) { setMode('list'); setError(null); return; }
      if (key.tab) { setEditField((field) => (field + (key.shift ? 2 : 1)) % 3); return; }
      if (key.return) {
        const index = editTarget;
        if (index === null || drafts[index] === undefined) { setMode('list'); return; }
        try {
          const parsed = parseTradeUrl(editValues[1]);
          const floor = editValues[2].trim() === '' ? undefined : Number(editValues[2]);
          if (editValues[0].trim() === '') throw new Error('Label cannot be empty');
          if (floor !== undefined && (!Number.isFinite(floor) || floor < 0)) throw new Error('Floor must be a non-negative number or blank');
          setDrafts((current) => current.map((entry, entryIndex) => {
            if (entryIndex !== index) return entry;
            const { minMarginPct: _oldFloor, ...withoutFloor } = entry;
            return {
              ...withoutFloor,
              key: `${parsed.realm}:${parsed.searchId}`,
              label: editValues[0].trim(),
              realm: parsed.realm,
              searchId: parsed.searchId,
              league: parsed.league,
              ...(floor === undefined ? {} : { minMarginPct: floor }),
            };
          }));
          setMode('list');
          setError(null);
        } catch (reason) {
          setError(reason instanceof Error ? reason.message : String(reason));
        }
        return;
      }
      setEditValues((current) => {
        const values = [...current] as [string, string, string];
        const existing = values[editField] ?? '';
        if (key.delete) values[editField] = '';
        else if (key.backspace) values[editField] = existing.slice(0, -1);
        else if (value !== '' && !key.ctrl && !key.meta) values[editField] = existing + value;
        return values;
      });
      return;
    }

    if (mode === 'confirm-delete') {
      if (key.escape || value.toLowerCase() === 'n') { setMode('list'); setDeleteGroup(null); return; }
      if (value.toLowerCase() === 'y') {
        const target = deleteGroup;
        if (target === null || onDeleteFolder === undefined) { setMode('list'); setDeleteGroup(null); return; }
        setBusy(true);
        void onDeleteFolder(target.group).then((next) => {
          setDrafts(next);
          setCursor(0);
          setMode('list');
          setDeleteGroup(null);
          setError(null);
        }).catch((reason: unknown) => {
          setError(reason instanceof Error ? reason.message : String(reason));
          setMode('list');
          setDeleteGroup(null);
        }).finally(() => setBusy(false));
      }
      return;
    }

    if (key.escape) { void save(false); return; }
    if ((key.backspace || key.delete) && selected?.kind === 'folder' && onDeleteFolder !== undefined) {
      setDeleteGroup({ group: selected.group, count: selected.indices.length });
      setMode('confirm-delete');
      setError(null);
      return;
    }
    if (key.upArrow) { setCursor((index) => Math.max(0, index - (key.shift ? 10 : 1))); return; }
    if (key.downArrow) { setCursor((index) => Math.min(Math.max(0, rows.length - 1), index + (key.shift ? 10 : 1))); return; }
    if (key.pageUp) { setCursor((index) => Math.max(0, index - MAX_LIST_ROWS)); return; }
    if (key.pageDown) { setCursor((index) => Math.min(Math.max(0, rows.length - 1), index + MAX_LIST_ROWS)); return; }
    if (key.rightArrow) {
      if (selected?.kind === 'folder') setExpanded((current) => new Set([...current, selected.group]));
      return;
    }
    if (key.leftArrow) {
      const group = selected?.kind === 'folder'
        ? selected.group
        : selected?.kind === 'entry' ? drafts[selected.index]?.group : undefined;
      if (group !== undefined) {
        setExpanded((current) => new Set([...current].filter((name) => name !== group)));
        const folderRow = rows.findIndex((row) => row.kind === 'folder' && row.group === group);
        if (folderRow >= 0) setCursor(folderRow);
      }
      return;
    }
    if (value === ' ') {
      if (selected?.kind === 'folder') {
        const enable = selected.indices.some((index) => drafts[index]?.enabled === false);
        const affected = new Set(selected.indices);
        setDrafts((current) => current.map((entry, index) => affected.has(index) ? { ...entry, enabled: enable } : entry));
      } else if (selected?.kind === 'entry') {
        const index = selected.index;
        setDrafts((current) => current.map((entry, entryIndex) => entryIndex === index ? { ...entry, enabled: !entry.enabled } : entry));
      }
      return;
    }
    if (value.toLowerCase() === 'a') {
      const enable = drafts.some((entry) => !entry.enabled);
      setDrafts((current) => current.map((entry) => ({ ...entry, enabled: enable })));
      return;
    }
    if (value.toLowerCase() === 'i') { setMode('import'); setInput(''); setError(null); return; }
    if (value.toLowerCase() === 'e') {
      if (selected?.kind !== 'entry') return;
      const entry = drafts[selected.index];
      if (entry === undefined) return;
      setEditTarget(selected.index);
      setEditValues([entry.label, tradeUrl(entry), entry.minMarginPct?.toString() ?? '']);
      setEditField(0);
      setMode('edit');
      setError(null);
      return;
    }
    if (key.return) void save(true);
  });

  const cursorIndex = Math.min(cursor, Math.max(0, rows.length - 1));
  const windowStart = Math.min(
    Math.max(0, cursorIndex - MAX_LIST_ROWS + 1),
    Math.max(0, rows.length - MAX_LIST_ROWS),
  );
  const visibleRows = rows.slice(windowStart, windowStart + MAX_LIST_ROWS);
  const hiddenAbove = windowStart;
  const hiddenBelow = Math.max(0, rows.length - windowStart - visibleRows.length);

  return (
    <Box flexDirection="column" borderStyle={glyphs.border} borderColor="yellow" paddingX={1}>
      <Text bold color="yellow">CONFIGURE SNIPES</Text>
      {mode === 'list' && <>
        <Text dimColor>{fold(`${glyphs.upDown} move ${glyphs.sep} Space toggle ${glyphs.sep} ${glyphs.leftRight} close/open folder ${glyphs.sep} ⌫ delete folder ${glyphs.sep} a all ${glyphs.sep} e edit ${glyphs.sep} i import ${glyphs.sep} Enter save/start ${glyphs.sep} Esc save`)}</Text>
        {hiddenAbove > 0 && <Text dimColor>{`  ↑ ${hiddenAbove} more above`}</Text>}
        {visibleRows.map((row, visibleIndex) => {
          const index = windowStart + visibleIndex;
          if (row.kind === 'folder') {
            const enabledCount = row.indices.filter((entryIndex) => drafts[entryIndex]?.enabled === true).length;
            const box = enabledCount === row.indices.length ? '[x]' : enabledCount === 0 ? '[ ]' : '[~]';
            const arrow = expanded.has(row.group) ? '▼' : '▶';
            return (
              <Text key={`folder:${row.group}`} inverse={index === cursorIndex} bold>
                {index === cursorIndex ? glyphs.select : ' '} {arrow} {box} {fold(row.group)} <Text dimColor>{` ${enabledCount}/${row.indices.length} enabled`}</Text>
              </Text>
            );
          }
          const entry = drafts[row.index];
          if (entry === undefined) return null;
          const indent = entry.group === undefined ? '' : '   ';
          return (
            <Text key={entry.key} inverse={index === cursorIndex}>
              {index === cursorIndex ? glyphs.select : ' '} {indent}{entry.enabled ? '[x]' : '[ ]'} {fold(entryDisplayLabel(entry))} <Text dimColor>{` ${entry.searchId} ${entry.minMarginPct === undefined ? 'default floor' : `floor ${entry.minMarginPct}%`}`}</Text>
            </Text>
          );
        })}
        {hiddenBelow > 0 && <Text dimColor>{`  ↓ ${hiddenBelow} more below`}</Text>}
        {drafts.length === 0 && <Text dimColor>No snipes configured — press i to import Better Trading.</Text>}
      </>}
      {mode === 'confirm-delete' && deleteGroup !== null && <>
        <Text color="red">{fold(`Delete folder "${deleteGroup.group}" (${deleteGroup.count} search${deleteGroup.count === 1 ? '' : 'es'})?`)}</Text>
        <Text dimColor>{fold('Deletes this folder and its files from disk; searches shared with other folders are disabled instead. y delete · n cancel')}</Text>
      </>}
      {mode === 'import' && <>
        <Text>Paste Better Trading export:</Text>
        <Text color="cyan">{fold(`${input}▌`)}</Text>
        <Text dimColor>Enter import · Esc cancel</Text>
      </>}
      {mode === 'edit' && <>
        {(['label', 'trade URL', 'floor %'] as const).map((label, index) => (
          <Text key={label} inverse={editField === index}>{`${label}: ${editValues[index]}${editField === index ? '▌' : ''}`}</Text>
        ))}
        <Text dimColor>Tab next field · Delete clear · Enter apply · Esc cancel</Text>
      </>}
      {busy && <Text color="yellow">Saving…</Text>}
      {error !== null && <Text color="red">{fold(error)}</Text>}
    </Box>
  );
}
