import React, { useEffect, useMemo, useState } from 'react';
import { Box, Text, useApp, useInput, useStdin } from 'ink';
import type { Game, Opportunity } from '../domain/types.js';
import { assessFreshness } from '../domain/freshness.js';
import type { ArbRow, DetailedMover, ExiliumService } from '../mcp/service.js';
import type { WatchEvent } from '../storage/watch-repository.js';
import { draftTradePlan } from '../signals/trade-plan.js';
import { buildTradeSearchUrl } from '../trade/trade-url.js';
import { formatNumber, formatPriceUnits } from '../domain/format-price.js';
import { matchesSearch } from './search.js';
import { renderSparkline } from './sparkline.js';

type View = 'movers' | 'opps' | 'arb' | 'watches';
type InputMode = 'normal' | 'search' | 'sort' | 'category' | 'watch' | 'league';

export interface TuiProps {
  readonly service: ExiliumService;
  readonly game: Game;
  readonly league: string;
  /** Seconds between data re-reads from the local store. */
  readonly refreshSec: number;
  /** Optional: triggers a live ingest when the user presses "r". */
  readonly onIngest?: (() => Promise<void>) | undefined;
  /** Optional: auto-run onIngest every N seconds (live-companion mode). */
  readonly autoIngestSec?: number | undefined;
  /** Opens a URL in the browser; injectable for tests. */
  readonly onOpenLink?: ((url: string) => void) | undefined;
}

const GOLD = '#d4a017';
const DIM = 'gray';
const VIEWPORT = 15;

interface Column<T> {
  readonly label: string;
  readonly width: number;
  readonly sortValue: (row: T) => string | number;
}

interface WatchTarget {
  readonly kind: 'price' | 'opportunity';
  readonly itemId: string;
  readonly name: string;
  /** Current price for price watches; current edge % for opportunity watches. */
  readonly reference: number;
}

interface TableModel<T> {
  readonly columns: readonly Column<T>[];
  readonly cells: (row: T) => readonly string[];
  readonly searchText: (row: T) => string;
  /** Item identity for the Enter → trade-link action; null disables it.
   * Category drives the name-vs-type field choice on the trade site. */
  readonly itemName: (row: T) => { name: string; category: string } | null;
  /** Target for the w → create-watch action; null disables it. */
  readonly watchTarget: (row: T) => WatchTarget | null;
}

const fmtChange24 = (m: DetailedMover): string =>
  m.change24h === null ? `7d ${m.totalChange.toFixed(1)}%` : `${m.change24h.toFixed(1)}%`;

interface PriceCtx {
  readonly primaryCurrency: string;
  readonly divinePerPrimary: number | null;
}

const fmtPrice = (v: number, ctx: PriceCtx): string => {
  const { text, unit } = formatPriceUnits(v, ctx.primaryCurrency, ctx.divinePerPrimary);
  return `${text} ${unit}`;
};

const buildMoversModel = (ctx: PriceCtx): TableModel<DetailedMover> => ({
  columns: [
    { label: 'ITEM', width: 32, sortValue: (m) => m.name.toLowerCase() },
    { label: 'CATEGORY', width: 14, sortValue: (m) => m.category },
    { label: 'PRICE', width: 11, sortValue: (m) => m.primaryValue },
    { label: '24H%', width: 10, sortValue: (m) => m.change24h ?? m.totalChange },
    { label: '7D%', width: 9, sortValue: (m) => m.totalChange },
    { label: 'VOLUME', width: 11, sortValue: (m) => m.volumePrimaryValue },
  ],
  cells: (m) => [
    m.name,
    m.category,
    fmtPrice(m.primaryValue, ctx),
    fmtChange24(m),
    `${m.totalChange.toFixed(1)}%`,
    Math.round(m.volumePrimaryValue).toLocaleString('en-US'),
  ],
  searchText: (m) => `${m.name} ${m.category}`,
  itemName: (m) => ({ name: m.name, category: m.category }),
  watchTarget: (m) => ({ kind: 'price', itemId: m.itemId, name: m.name, reference: m.primaryValue }),
});

const OPPS_MODEL: TableModel<Opportunity> = {
  columns: [
    { label: 'DETECTOR', width: 23, sortValue: (o) => o.kind },
    { label: 'ITEM', width: 28, sortValue: (o) => o.itemName.toLowerCase() },
    { label: 'EDGE', width: 7, sortValue: (o) => o.edge },
    { label: 'CONF', width: 5, sortValue: (o) => o.confidence },
    { label: 'RATIONALE', width: 58, sortValue: (o) => o.rationale },
  ],
  cells: (o) => [
    `${o.kind}${o.experimental ? ' ⚠' : ''}`,
    o.itemName,
    `${(o.edge * 100).toFixed(1)}%`,
    `${(o.confidence * 100).toFixed(0)}%`,
    o.rationale,
  ],
  searchText: (o) => `${o.itemName} ${o.kind} ${o.rationale}`,
  itemName: (o) => ({ name: o.itemName, category: o.category }),
  watchTarget: (o) => ({ kind: 'opportunity', itemId: o.itemId, name: o.itemName, reference: o.edge * 100 }),
};

const buildArbModel = (ctx: PriceCtx): TableModel<ArbRow> => ({
  columns: [
    { label: 'ITEM', width: 28, sortValue: (r) => r.itemName.toLowerCase() },
    { label: 'CATEGORY', width: 12, sortValue: (r) => r.category },
    { label: 'LISTED', width: 10, sortValue: (r) => r.listed },
    { label: 'IMPLIED', width: 10, sortValue: (r) => r.implied },
    { label: 'VIA', width: 8, sortValue: (r) => r.quoteCurrency },
    { label: 'GAP', width: 6, sortValue: (r) => r.divergencePct },
    { label: 'VOLUME', width: 10, sortValue: (r) => r.volumePrimaryValue },
  ],
  cells: (r) => [
    r.itemName,
    r.category,
    fmtPrice(r.listed, ctx),
    fmtPrice(r.implied, ctx),
    r.quoteCurrency,
    `${r.divergencePct.toFixed(1)}%`,
    Math.round(r.volumePrimaryValue).toLocaleString('en-US'),
  ],
  searchText: (r) => `${r.itemName} ${r.category}`,
  itemName: (r) => ({ name: r.itemName, category: r.category }),
  watchTarget: (r) => ({ kind: 'price', itemId: r.itemId, name: r.itemName, reference: r.listed }),
});

const WATCH_MODEL: TableModel<WatchEvent> = {
  columns: [
    { label: 'FIRED AT', width: 22, sortValue: (e) => e.firedAt },
    { label: 'WATCH', width: 20, sortValue: (e) => e.watchId },
    { label: 'EVENT', width: 60, sortValue: (e) => e.seq },
  ],
  cells: (e) => {
    const p = e.payload as { itemName?: string; value?: number; edge?: number; totalChange?: number };
    const bits = [
      p.itemName ?? '',
      p.value !== undefined ? `value ${p.value}` : '',
      p.edge !== undefined ? `edge ${(p.edge * 100).toFixed(1)}%` : '',
      p.totalChange !== undefined ? `change ${p.totalChange.toFixed(1)}%` : '',
    ].filter((b) => b !== '');
    return [e.firedAt, e.watchId, bits.join(' · ')];
  },
  searchText: (e) => `${e.watchId} ${JSON.stringify(e.payload)}`,
  itemName: (e) => {
    const p = e.payload as { itemName?: string; category?: string };
    return p.itemName === undefined ? null : { name: p.itemName, category: p.category ?? '' };
  },
  watchTarget: () => null,
};

function applySearchAndSort<T>(
  rows: readonly T[],
  model: TableModel<T>,
  search: string,
  sortCol: number | null,
  sortDir: 'asc' | 'desc',
): readonly T[] {
  const filtered = search.trim() === '' ? rows : rows.filter((r) => matchesSearch(model.searchText(r), search));
  if (sortCol === null) return filtered;
  const col = model.columns[sortCol];
  if (col === undefined) return filtered;
  return [...filtered].sort((a, b) => {
    const va = col.sortValue(a);
    const vb = col.sortValue(b);
    const cmp = typeof va === 'number' && typeof vb === 'number' ? va - vb : String(va).localeCompare(String(vb));
    return sortDir === 'asc' ? cmp : -cmp;
  });
}

function HeaderRow<T>({ model, sortCol, sortDir, sortMode }: {
  readonly model: TableModel<T>;
  readonly sortCol: number | null;
  readonly sortDir: 'asc' | 'desc';
  readonly sortMode: boolean;
}): React.JSX.Element {
  return (
    <Box>
      {model.columns.map((c, i) => {
        const marker = sortCol === i ? (sortDir === 'asc' ? '▲' : '▼') : '';
        const label = `${c.label}${marker}`.slice(0, c.width).padEnd(c.width);
        return (
          <Text key={c.label} inverse={sortMode && sortCol === i} color={sortCol === i ? GOLD : 'white'} bold={sortCol === i}>
            {label}{' '}
          </Text>
        );
      })}
    </Box>
  );
}

function DataRow<T>({ model, row, selected }: {
  readonly model: TableModel<T>;
  readonly row: T;
  readonly selected: boolean;
}): React.JSX.Element {
  const cells = model.cells(row);
  const line = model.columns.map((c, i) => (cells[i] ?? '').slice(0, c.width).padEnd(c.width)).join(' ');
  return <Text inverse={selected} wrap="truncate">{line}</Text>;
}

const FRESH_COLORS = { live: 'green', stale: 'yellow', old: 'red' } as const;

function Header({ game, league, primary, asOf, ingesting }: {
  readonly game: string; readonly league: string; readonly primary: string;
  readonly asOf: string | null; readonly ingesting: boolean;
}): React.JSX.Element {
  const fresh = assessFreshness(asOf, Date.now());
  return (
    <Box justifyContent="space-between">
      <Text bold color={GOLD}>{' EXILIUM '}<Text color="white">· {game}/{league} · prices in {primary}</Text></Text>
      <Text color={DIM}>
        {ingesting ? 'ingesting… ' : ''}
        {fresh === null ? 'no data ' : <Text><Text color={FRESH_COLORS[fresh.level]}>●</Text> {fresh.label} </Text>}
      </Text>
    </Box>
  );
}

function Tabs({ view, category, hint }: {
  readonly view: View; readonly category: string; readonly hint: string;
}): React.JSX.Element {
  const tab = (key: string, name: string, active: boolean) => (
    <Text key={name} inverse={active} color={active ? GOLD : DIM}>{` ${key}:${name} `}</Text>
  );
  return (
    <Box gap={1}>
      {tab('1', 'MOVERS', view === 'movers')}
      {tab('2', 'OPPORTUNITIES', view === 'opps')}
      {tab('3', 'ARBITRAGE', view === 'arb')}
      {tab('4', 'WATCHES', view === 'watches')}
      <Text color={GOLD}>{` [${category}]`}</Text>
      <Text color={DIM}>  {hint}</Text>
    </Box>
  );
}

/** Bloomberg-style terminal UI over the local snapshot store. Reads cached
 * data only; "r" triggers a live ingest via the injected callback. */
export function ExiliumTui({ service, game, league, refreshSec, onIngest, autoIngestSec, onOpenLink }: TuiProps): React.JSX.Element {
  const { exit } = useApp();
  const { isRawModeSupported } = useStdin();
  const [view, setView] = useState<View>('movers');
  const [selected, setSelected] = useState(0);
  const [categoryIdx, setCategoryIdx] = useState(0);
  const [tick, setTick] = useState(0);
  const [ingesting, setIngesting] = useState(false);
  const [inputMode, setInputMode] = useState<InputMode>('normal');
  const [search, setSearch] = useState('');
  const [sortCol, setSortCol] = useState<number | null>(null);
  const [sortDir, setSortDir] = useState<'asc' | 'desc'>('desc');
  const [catQuery, setCatQuery] = useState('');
  const [catPick, setCatPick] = useState(0);
  const [activeLeague, setActiveLeague] = useState(league);
  const [leagueQuery, setLeagueQuery] = useState('');
  const [leaguePick, setLeaguePick] = useState(0);
  const [watchTarget, setWatchTarget] = useState<WatchTarget | null>(null);
  const [watchInput, setWatchInput] = useState('');
  const [watchUnit, setWatchUnit] = useState<'primary' | 'divine'>('primary');
  const [statusMsg, setStatusMsg] = useState('');

  useEffect(() => {
    const t = setInterval(() => setTick((n) => n + 1), refreshSec * 1000);
    return () => clearInterval(t);
  }, [refreshSec]);

  useEffect(() => {
    if (onIngest === undefined || autoIngestSec === undefined) return;
    const t = setInterval(() => {
      setIngesting(true);
      onIngest()
        .catch(() => undefined)
        .finally(() => { setIngesting(false); setTick((n) => n + 1); });
    }, autoIngestSec * 1000);
    return () => clearInterval(t);
  }, [onIngest, autoIngestSec]);

  const availableLeagues = useMemo(() => {
    const seen = service.leagues().leagues.filter((l) => l.game === game).map((l) => l.league);
    return seen.includes(activeLeague) ? seen : [activeLeague, ...seen];
  }, [service, game, activeLeague, tick]);

  const data = useMemo(() => {
    const summary = service.marketSnapshot(game, activeLeague);
    const categories = ['All', ...service.categoryList(game, activeLeague).map((c) => c.category)];
    const category = categories[categoryIdx % categories.length] ?? 'All';
    const filter = category === 'All' ? undefined : category;
    const movers = service.moversDetailed(game, activeLeague, undefined, filter);
    const opps = service.opportunities(game, activeLeague, true, 0, filter).opportunities;
    const arb = service.arbitrage(game, activeLeague, 0, filter);
    let watchEvents: readonly WatchEvent[] = [];
    try {
      watchEvents = service.recentWatchEvents(200);
    } catch {
      // watches not enabled — pane shows empty state
    }
    return { summary, categories, category, movers, opps, arb, watchEvents };
  }, [service, game, activeLeague, tick, ingesting, categoryIdx]);

  const table = useMemo(() => {
    const ctx: PriceCtx = {
      primaryCurrency: data.summary.primaryCurrency,
      divinePerPrimary: data.summary.divinePerPrimary,
    };
    switch (view) {
      case 'movers': {
        const model = buildMoversModel(ctx);
        return { model: model as TableModel<unknown>, rows: applySearchAndSort(data.movers, model, search, sortCol, sortDir) as readonly unknown[] };
      }
      case 'opps':
        return { model: OPPS_MODEL as TableModel<unknown>, rows: applySearchAndSort(data.opps, OPPS_MODEL, search, sortCol, sortDir) as readonly unknown[] };
      case 'arb': {
        const model = buildArbModel(ctx);
        return { model: model as TableModel<unknown>, rows: applySearchAndSort(data.arb, model, search, sortCol, sortDir) as readonly unknown[] };
      }
      case 'watches':
        return { model: WATCH_MODEL as TableModel<unknown>, rows: applySearchAndSort(data.watchEvents, WATCH_MODEL, search, sortCol, sortDir) as readonly unknown[] };
    }
  }, [view, data, search, sortCol, sortDir]);

  const rowCount = table.rows.length;
  const clampedSelected = Math.min(selected, Math.max(0, rowCount - 1));
  const offset = Math.max(0, Math.min(clampedSelected - VIEWPORT + 1, Math.max(0, rowCount - VIEWPORT)));
  const visible = table.rows.slice(offset, offset + VIEWPORT);

  const switchView = (v: View): void => {
    setView(v);
    setSelected(0);
    setSortCol(null);
  };

  const moveSelection = (delta: number): void => {
    setSelected((s) => Math.max(0, Math.min(rowCount - 1, s + delta)));
  };

  useInput((input, key) => {
    // Row movement works in normal AND search mode — filtering must never
    // take scrolling away. Shift+arrow jumps 10.
    const handleMovement = (): boolean => {
      if (key.upArrow) { moveSelection(key.shift ? -10 : -1); return true; }
      if (key.downArrow) { moveSelection(key.shift ? 10 : 1); return true; }
      if (key.pageUp) { moveSelection(-VIEWPORT); return true; }
      if (key.pageDown) { moveSelection(VIEWPORT); return true; }
      return false;
    };

    if (inputMode === 'search') {
      if (handleMovement()) return;
      if (key.escape) { setSearch(''); setInputMode('normal'); return; }
      if (key.return) { setInputMode('normal'); return; }
      if (key.backspace || key.delete) { setSearch((s) => s.slice(0, -1)); return; }
      if (input !== '' && !key.ctrl && !key.meta) {
        setSearch((s) => s + input);
        setSelected(0);
      }
      return;
    }
    if (inputMode === 'watch') {
      if (key.escape) { setInputMode('normal'); setWatchTarget(null); return; }
      if (key.return) {
        const entered = Number(watchInput);
        const dpp = data.summary.divinePerPrimary;
        // Stored threshold is always in the primary currency (chaos on poe1).
        const threshold = watchUnit === 'divine' && dpp !== null && dpp > 0 ? entered / dpp : entered;
        if (watchTarget === null || Number.isNaN(threshold) || threshold <= 0) {
          setStatusMsg('watch not created — threshold must be a positive number');
          setInputMode('normal');
          setWatchTarget(null);
          return;
        }
        const kind =
          watchTarget.kind === 'opportunity'
            ? ('opportunity' as const)
            : threshold >= watchTarget.reference
              ? ('price_above' as const)
              : ('price_below' as const);
        try {
          service.createWatch({
            id: `tui:${kind}:${watchTarget.itemId}:${Math.round(threshold * 100)}`,
            game,
            league: activeLeague,
            kind,
            itemId: watchTarget.itemId,
            category: null,
            threshold,
            mode: 'once',
            webhookUrl: null,
            createdAt: new Date().toISOString(),
            active: true,
          });
          setStatusMsg(`watch created: ${watchTarget.name} ${kind === 'opportunity' ? `edge ≥ ${threshold}%` : kind === 'price_above' ? `≥ ${threshold}` : `≤ ${threshold}`}`);
        } catch (err) {
          setStatusMsg(`watch failed: ${err instanceof Error ? err.message : String(err)}`);
        }
        setInputMode('normal');
        setWatchTarget(null);
        return;
      }
      if (key.backspace || key.delete) { setWatchInput((s) => s.slice(0, -1)); return; }
      if (key.upArrow) { setWatchInput((s) => String(Math.round((Number(s) || 0) * 1.01 * 100) / 100)); return; }
      if (key.downArrow) { setWatchInput((s) => String(Math.round((Number(s) || 0) * 0.99 * 100) / 100)); return; }
      const dpp2 = data.summary.divinePerPrimary;
      if ((input === 'd' || input === 'D') && dpp2 !== null && watchUnit !== 'divine') {
        setWatchInput((s) => String(Math.round((Number(s) || 0) * dpp2 * 100) / 100));
        setWatchUnit('divine');
        return;
      }
      if ((input === 'c' || input === 'C') && dpp2 !== null && dpp2 > 0 && watchUnit !== 'primary') {
        setWatchInput((s) => String(Math.round((Number(s) || 0) / dpp2)));
        setWatchUnit('primary');
        return;
      }
      if (/^[0-9.]+$/.test(input)) setWatchInput((s) => s + input);
      return;
    }
    if (inputMode === 'league') {
      const matches = availableLeagues.filter((l) => l.toLowerCase().includes(leagueQuery.toLowerCase()));
      if (key.escape) { setInputMode('normal'); setLeagueQuery(''); return; }
      if (key.return) {
        const chosen = matches[Math.min(leaguePick, Math.max(0, matches.length - 1))];
        if (chosen !== undefined && chosen !== activeLeague) {
          setActiveLeague(chosen);
          setSelected(0);
          setCategoryIdx(0);
          setSearch('');
        }
        setInputMode('normal');
        setLeagueQuery('');
        return;
      }
      if (key.upArrow) { setLeaguePick((i) => Math.max(0, i - 1)); return; }
      if (key.downArrow) { setLeaguePick((i) => Math.min(Math.max(0, matches.length - 1), i + 1)); return; }
      if (key.backspace || key.delete) { setLeagueQuery((s) => s.slice(0, -1)); setLeaguePick(0); return; }
      if (input !== '' && !key.ctrl && !key.meta) { setLeagueQuery((s) => s + input); setLeaguePick(0); }
      return;
    }
    if (inputMode === 'category') {
      const matches = data.categories.filter((c) => c.toLowerCase().includes(catQuery.toLowerCase()));
      if (key.escape) { setInputMode('normal'); setCatQuery(''); return; }
      if (key.return) {
        const chosen = matches[Math.min(catPick, Math.max(0, matches.length - 1))];
        if (chosen !== undefined) {
          setCategoryIdx(data.categories.indexOf(chosen));
          setSelected(0);
        }
        setInputMode('normal');
        setCatQuery('');
        return;
      }
      if (key.upArrow) { setCatPick((i) => Math.max(0, i - 1)); return; }
      if (key.downArrow) { setCatPick((i) => Math.min(Math.max(0, matches.length - 1), i + 1)); return; }
      if (key.backspace || key.delete) { setCatQuery((s) => s.slice(0, -1)); setCatPick(0); return; }
      if (input !== '' && !key.ctrl && !key.meta) { setCatQuery((s) => s + input); setCatPick(0); }
      return;
    }
    if (inputMode === 'sort') {
      if (key.escape || key.return) { setInputMode('normal'); return; }
      // Up/down keep scrolling rows — sorting must never steal navigation.
      if (handleMovement()) return;
      // f ONLY toggles direction on the current column; it never advances.
      if (input === 'f') { setSortDir((d) => (d === 'desc' ? 'asc' : 'desc')); return; }
      if (key.rightArrow) { setSortCol((c) => ((c ?? -1) + 1) % table.model.columns.length); setSortDir('desc'); return; }
      if (key.leftArrow) { setSortCol((c) => ((c ?? 0) - 1 + table.model.columns.length) % table.model.columns.length); setSortDir('desc'); return; }
      return;
    }
    if (input === 'q' || (key.ctrl && input === 'c')) exit();
    if (input === '1') switchView('movers');
    if (input === '2') switchView('opps');
    if (input === '3') switchView('arb');
    if (input === '4') switchView('watches');
    if (input === 's') { setInputMode('search'); return; }
    if (input === 'f') { setInputMode('sort'); setSortCol((c) => c ?? 0); setSortDir('desc'); return; }
    if (handleMovement()) return;
    if (key.rightArrow) { moveSelection(VIEWPORT); return; }
    if (key.leftArrow) { moveSelection(-VIEWPORT); return; }
    if (input === 'c') { setInputMode('category'); setCatQuery(''); setCatPick(0); return; }
    if (input === 'l') { setInputMode('league'); setLeagueQuery(''); setLeaguePick(0); return; }
    if (input === 'w' && rowCount > 0) {
      const row = table.rows[clampedSelected];
      const target = row === undefined ? null : table.model.watchTarget(row);
      if (target !== null) {
        setWatchTarget(target);
        const dpp = data.summary.divinePerPrimary;
        // Denominate in divines when the item trades above 1 divine — nobody
        // knows a Mirror's chaos price, but they know its divine target.
        const useDiv = target.kind === 'price' && dpp !== null && target.reference * dpp >= 1;
        setWatchUnit(useDiv ? 'divine' : 'primary');
        const prefillPrimary = target.kind === 'price' ? target.reference * 1.05 : target.reference;
        const prefill = useDiv && dpp !== null ? prefillPrimary * dpp : prefillPrimary;
        setWatchInput(String(Math.round(prefill * 100) / 100));
        setStatusMsg('');
        setInputMode('watch');
      }
      return;
    }
    if (key.return && rowCount > 0) {
      const row = table.rows[clampedSelected];
      const target = row === undefined ? null : table.model.itemName(row);
      if (target !== null && onOpenLink !== undefined) onOpenLink(buildTradeSearchUrl(game, activeLeague, target.name, target.category));
      return;
    }
    if (input === 'r' && onIngest !== undefined && !ingesting) {
      setIngesting(true);
      onIngest()
        .catch(() => undefined)
        .finally(() => { setIngesting(false); setTick((n) => n + 1); });
    }
  }, { isActive: isRawModeSupported === true });

  if (data.summary.asOf === null) {
    return (
      <Box flexDirection="column" padding={1}>
        <Header game={game} league={activeLeague} primary={data.summary.primaryCurrency} asOf={null} ingesting={ingesting} />
        <Text color={DIM}>No data ingested yet — press r to ingest now, or run `exilium ingest`.</Text>
      </Box>
    );
  }

  const hint =
    inputMode === 'search'
      ? 'type to filter · ↑↓ scroll matches · ↵ keep · esc clear'
      : inputMode === 'sort'
        ? 'sort: f toggles ▼/▲ · ←→ column · ↑↓ scroll · esc done'
        : inputMode === 'category'
          ? 'category: type to filter · ↑↓ pick · ↵ apply · esc cancel'
          : inputMode === 'watch'
            ? 'watch: type threshold · ↵ create · esc cancel'
            : 's search · f sort · w watch · ↵ trade link · ↑↓ rows · ←→ page · c category · l league · r refresh · q quit';

  const selectedMover = view === 'movers' ? (table.rows[clampedSelected] as DetailedMover | undefined) : undefined;
  const selectedOpp = view === 'opps' ? (table.rows[clampedSelected] as Opportunity | undefined) : undefined;
  const plan = selectedOpp === undefined ? null : draftTradePlan(selectedOpp);

  return (
    <Box flexDirection="column" paddingX={1}>
      <Header game={game} league={activeLeague} primary={data.summary.primaryCurrency} asOf={data.summary.asOf} ingesting={ingesting} />
      <Tabs view={view} category={data.category} hint={hint} />
      {inputMode === 'watch' && watchTarget !== null && (() => {
        const dpp = data.summary.divinePerPrimary;
        const unitLabel = watchUnit === 'divine' ? 'div' : data.summary.primaryCurrency;
        // Compare like-for-like: convert both to primary.
        const enteredPrimary = watchUnit === 'divine' && dpp !== null && dpp > 0 ? (Number(watchInput) || 0) / dpp : Number(watchInput) || 0;
        const refInUnit = watchUnit === 'divine' && dpp !== null ? watchTarget.reference * dpp : watchTarget.reference;
        const other =
          watchTarget.kind !== 'price' || dpp === null || dpp <= 0
            ? null
            : watchUnit === 'divine'
              ? `≈ ${Math.round((Number(watchInput) || 0) / dpp).toLocaleString('en-US')} ${data.summary.primaryCurrency}`
              : `≈ ${formatNumber((Number(watchInput) || 0) * dpp)} div`;
        return (
          <Box flexDirection="column" borderStyle="round" borderColor={GOLD} paddingX={1}>
            <Text color={GOLD} bold>{`watch: ${watchTarget.name}`}</Text>
            {watchTarget.kind === 'price' ? (
              <Text>
                {`current ${formatNumber(refInUnit)} ${unitLabel} · threshold: ${watchInput} ${unitLabel}▌ ${other ?? ''}  → `}
                <Text color={enteredPrimary >= watchTarget.reference ? 'green' : 'red'} bold>
                  {enteredPrimary >= watchTarget.reference ? 'alert on rise' : 'alert on drop'}
                </Text>
              </Text>
            ) : (
              <Text>{`current edge ${watchTarget.reference.toFixed(1)}% · alert at edge ≥ ${watchInput}▌ %`}</Text>
            )}
            <Text color={DIM}>
              {watchTarget.kind === 'price' && dpp !== null ? 'd/c switch div↔chaos · ' : ''}
              type numbers · ↑↓ nudge ±1% · ↵ create · esc cancel — fires once, in pane 4 &amp; `exilium watches`
            </Text>
          </Box>
        );
      })()}
      {inputMode === 'league' && (() => {
        const LG_VIEW = 10;
        const matches = availableLeagues.filter((l) => l.toLowerCase().includes(leagueQuery.toLowerCase()));
        const pick = Math.min(leaguePick, Math.max(0, matches.length - 1));
        const off = Math.max(0, Math.min(pick - LG_VIEW + 1, Math.max(0, matches.length - LG_VIEW)));
        return (
          <Box flexDirection="column" borderStyle="round" borderColor={GOLD} paddingX={1}>
            <Text color={GOLD}>{`league: ${leagueQuery}▌`}<Text color={DIM}>{`  (${matches.length} with data — type to filter · ↑↓ pick · ↵ switch · esc cancel)`}</Text></Text>
            {matches.slice(off, off + LG_VIEW).map((l, i) => {
              const idx = off + i;
              return (
                <Text key={l} inverse={idx === pick} color={idx === pick ? GOLD : DIM} bold={idx === pick}>
                  {idx === pick ? `▶ ${l}` : `  ${l}`}
                </Text>
              );
            })}
            <Text color={DIM}>Switch to a league you have not ingested with `EXILIUM_LEAGUE=… exilium ingest`.</Text>
          </Box>
        );
      })()}
      {inputMode === 'category' && (() => {
        const CAT_VIEW = 10;
        const matches = data.categories.filter((c) => c.toLowerCase().includes(catQuery.toLowerCase()));
        const pick = Math.min(catPick, Math.max(0, matches.length - 1));
        const catOffset = Math.max(0, Math.min(pick - CAT_VIEW + 1, Math.max(0, matches.length - CAT_VIEW)));
        return (
          <Box flexDirection="column" borderStyle="round" borderColor={GOLD} paddingX={1}>
            <Text color={GOLD}>{`category: ${catQuery}▌`}<Text color={DIM}>{`  (${matches.length} — type to filter · ↑↓ pick · ↵ apply · esc cancel)`}</Text></Text>
            {matches.slice(catOffset, catOffset + CAT_VIEW).map((c, i) => {
              const idx = catOffset + i;
              return (
                <Text key={c} inverse={idx === pick} color={idx === pick ? GOLD : DIM} bold={idx === pick}>
                  {idx === pick ? `▶ ${c}` : `  ${c}`}
                </Text>
              );
            })}
            {matches.length > CAT_VIEW && <Text color={DIM}>{`  ${pick + 1}/${matches.length}`}</Text>}
          </Box>
        );
      })()}
      {(inputMode === 'search' || search !== '') && (
        <Text color={GOLD}>
          {`search: ${search}${inputMode === 'search' ? '▌' : ''}`}
          <Text color={DIM}>{`  (${rowCount} match${rowCount === 1 ? '' : 'es'})`}</Text>
        </Text>
      )}
      <Box marginTop={1} flexDirection="column">
        <HeaderRow model={table.model} sortCol={sortCol} sortDir={sortDir} sortMode={inputMode === 'sort'} />
        {visible.map((row, i) => (
          <DataRow key={offset + i} model={table.model} row={row} selected={offset + i === clampedSelected} />
        ))}
        {rowCount === 0 && <Text color={DIM}>Nothing matches.</Text>}
        {rowCount > 0 && (
          <Text color={DIM}>{`row ${clampedSelected + 1} of ${rowCount}${rowCount > VIEWPORT ? ' · ↑↓/PgUp/PgDn to scroll' : ''}`}</Text>
        )}
      </Box>
      {selectedMover !== undefined && (
        <Box marginTop={1} flexDirection="column">
          <Text color={GOLD} bold>{selectedMover.name}</Text>
          <Text>
            7d trend <Text color="cyan">{renderSparkline(selectedMover.sparkline)}</Text>
            {'  24h '}
            {selectedMover.change24h === null ? `n/a (7d ${selectedMover.totalChange.toFixed(1)}%)` : `${selectedMover.change24h.toFixed(1)}%`}
            {'  ↵ opens trade site'}
          </Text>
        </Box>
      )}
      {plan !== null && (
        <Box marginTop={1} flexDirection="column">
          <Text color={GOLD} bold>{plan.summary}</Text>
          {plan.steps.map((s) => (
            <Text key={s.order} wrap="truncate-end">{`  ${s.order}. ${s.instruction}`}</Text>
          ))}
          <Text color={DIM} wrap="truncate-end">{plan.humanExecutionNote}</Text>
        </Box>
      )}
      <Box marginTop={1}>
        <Text color={DIM}>
          {statusMsg !== '' ? <Text color={GOLD}>{statusMsg}  ·  </Text> : null}
          humans execute all trades · data via poe.ninja · {data.summary.categories} categories
        </Text>
      </Box>
    </Box>
  );
}
