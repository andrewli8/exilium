import React, { useState } from 'react';
import { Box, Text, useInput } from 'ink';
import type { CatalogEntry } from './catalog.js';
import { parseTradeUrl } from '../trade/live-search.js';
import { fold, glyphs } from '../tui/glyphs.js';

type Mode = 'list' | 'import' | 'edit';

export interface SnipeConfigureOverlayProps {
  readonly entries: readonly CatalogEntry[];
  readonly onSave: (entries: readonly CatalogEntry[]) => Promise<readonly CatalogEntry[]>;
  readonly onStart: (enabledKeys: readonly string[]) => Promise<void>;
  readonly onClose: () => void;
  readonly onImport?: (source: string) => Promise<readonly CatalogEntry[]>;
}

function tradeUrl(entry: CatalogEntry): string {
  const league = encodeURIComponent(entry.league ?? 'Allflame');
  return entry.realm === 'trade2'
    ? `https://www.pathofexile.com/trade2/search/poe2/${league}/${entry.searchId}`
    : `https://www.pathofexile.com/trade/search/${league}/${entry.searchId}`;
}

export function SnipeConfigureOverlay({ entries, onSave, onStart, onClose, onImport }: SnipeConfigureOverlayProps) {
  const [drafts, setDrafts] = useState<readonly CatalogEntry[]>(entries);
  const [cursor, setCursor] = useState(0);
  const [mode, setMode] = useState<Mode>('list');
  const [input, setInput] = useState('');
  const [editField, setEditField] = useState(0);
  const [editValues, setEditValues] = useState<readonly [string, string, string]>(['', '', '']);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

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
        const selected = drafts[cursor];
        if (selected === undefined) { setMode('list'); return; }
        try {
          const parsed = parseTradeUrl(editValues[1]);
          const floor = editValues[2].trim() === '' ? undefined : Number(editValues[2]);
          if (editValues[0].trim() === '') throw new Error('Label cannot be empty');
          if (floor !== undefined && (!Number.isFinite(floor) || floor < 0)) throw new Error('Floor must be a non-negative number or blank');
          setDrafts((current) => current.map((entry, index) => {
            if (index !== cursor) return entry;
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

    if (key.escape) { void save(false); return; }
    if (key.upArrow) { setCursor((index) => Math.max(0, index - 1)); return; }
    if (key.downArrow) { setCursor((index) => Math.min(Math.max(0, drafts.length - 1), index + 1)); return; }
    if (value === ' ') {
      setDrafts((current) => current.map((entry, index) => index === cursor ? { ...entry, enabled: !entry.enabled } : entry));
      return;
    }
    if (value.toLowerCase() === 'a') {
      const enable = drafts.some((entry) => !entry.enabled);
      setDrafts((current) => current.map((entry) => ({ ...entry, enabled: enable })));
      return;
    }
    if (value.toLowerCase() === 'i') { setMode('import'); setInput(''); setError(null); return; }
    if (value.toLowerCase() === 'e') {
      const selected = drafts[cursor];
      if (selected === undefined) return;
      setEditValues([selected.label, tradeUrl(selected), selected.minMarginPct?.toString() ?? '']);
      setEditField(0);
      setMode('edit');
      setError(null);
      return;
    }
    if (key.return) void save(true);
  });

  return (
    <Box flexDirection="column" borderStyle={glyphs.border} borderColor="yellow" paddingX={1}>
      <Text bold color="yellow">CONFIGURE SNIPES</Text>
      {mode === 'list' && <>
        <Text dimColor>{fold(`${glyphs.upDown} move ${glyphs.sep} Space toggle ${glyphs.sep} a all ${glyphs.sep} e edit ${glyphs.sep} i import ${glyphs.sep} Enter save/start ${glyphs.sep} Esc save`)}</Text>
        {drafts.map((entry, index) => (
          <Text key={entry.key} inverse={index === cursor}>
            {index === cursor ? glyphs.select : ' '} {entry.enabled ? '[x]' : '[ ]'} {fold(entry.label)} <Text dimColor>{` ${entry.searchId} ${entry.minMarginPct === undefined ? 'default floor' : `floor ${entry.minMarginPct}%`}`}</Text>
          </Text>
        ))}
        {drafts.length === 0 && <Text dimColor>No snipes configured — press i to import Better Trading.</Text>}
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
