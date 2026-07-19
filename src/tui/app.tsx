import React, { useEffect, useMemo, useState } from 'react';
import { Box, Text, useApp, useInput, useStdin } from 'ink';
import type { Game, Opportunity } from '../domain/types.js';
import { assessFreshness } from '../domain/freshness.js';
import type { ArbRow, DetailedMover, ExiliumService } from '../mcp/service.js';
import type { WatchEvent } from '../storage/watch-repository.js';
import { renderSparkline } from './sparkline.js';
import { draftTradePlan } from '../signals/trade-plan.js';

type View = 'movers' | 'opps' | 'arb' | 'watches';

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
}

const GOLD = '#d4a017';
const DIM = 'gray';

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

function Tabs({ view, category }: { readonly view: View; readonly category: string }): React.JSX.Element {
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
      <Text color={DIM}>  ↑↓ select · ←→ category · r ingest · q quit</Text>
    </Box>
  );
}

function Row({ cells, widths, selected }: {
  readonly cells: readonly string[]; readonly widths: readonly number[]; readonly selected: boolean;
}): React.JSX.Element {
  const line = cells.map((c, i) => c.slice(0, widths[i]).padEnd(widths[i] ?? 0)).join(' ');
  return <Text inverse={selected} wrap="truncate">{line}</Text>;
}

const MOVER_WIDTHS = [34, 15, 12, 9, 12] as const;
const OPP_WIDTHS = [24, 30, 7, 5, 60] as const;
const ARB_WIDTHS = [30, 12, 11, 11, 8, 6, 10] as const;

function MoversPane({ movers, selected, primary }: {
  readonly movers: readonly DetailedMover[]; readonly selected: number; readonly primary: string;
}): React.JSX.Element {
  const sel = movers[selected];
  return (
    <Box flexDirection="column">
      <Row cells={['ITEM', 'CATEGORY', `PRICE (${primary})`, 'CHANGE', 'VOLUME']} widths={MOVER_WIDTHS} selected={false} />
      {movers.map((m, i) => (
        <Row key={m.itemId} selected={i === selected} widths={MOVER_WIDTHS}
          cells={[m.name, m.category, m.primaryValue.toPrecision(4), `${m.totalChange.toFixed(1)}%`, Math.round(m.volumePrimaryValue).toLocaleString('en-US')]} />
      ))}
      {sel !== undefined && (
        <Box marginTop={1} flexDirection="column">
          <Text color={GOLD} bold>{sel.name}</Text>
          <Text>7d trend <Text color="cyan">{renderSparkline(sel.sparkline)}</Text>  latest {sel.totalChange.toFixed(1)}%</Text>
        </Box>
      )}
    </Box>
  );
}

function OppsPane({ opps, selected }: { readonly opps: readonly Opportunity[]; readonly selected: number }): React.JSX.Element {
  if (opps.length === 0) return <Text color={DIM}>No opportunities at current thresholds.</Text>;
  const sel = opps[selected];
  const plan = sel === undefined ? null : draftTradePlan(sel);
  return (
    <Box flexDirection="column">
      <Row cells={['DETECTOR', 'ITEM', 'EDGE', 'CONF', 'RATIONALE']} widths={OPP_WIDTHS} selected={false} />
      {opps.map((o, i) => (
        <Row key={o.id} selected={i === selected} widths={OPP_WIDTHS}
          cells={[`${o.kind}${o.experimental ? ' ⚠' : ''}`, o.itemName, `${(o.edge * 100).toFixed(1)}%`, `${(o.confidence * 100).toFixed(0)}%`, o.rationale]} />
      ))}
      {plan !== null && (
        <Box marginTop={1} flexDirection="column">
          <Text color={GOLD} bold>{plan.summary}</Text>
          {plan.steps.map((s) => (
            <Text key={s.order} wrap="truncate-end">{`  ${s.order}. ${s.instruction}`}</Text>
          ))}
          <Text color={DIM} wrap="truncate-end">{plan.humanExecutionNote}</Text>
        </Box>
      )}
    </Box>
  );
}

function ArbPane({ rows, selected, primary }: {
  readonly rows: readonly ArbRow[]; readonly selected: number; readonly primary: string;
}): React.JSX.Element {
  if (rows.length === 0) return <Text color={DIM}>No cross-rate data yet.</Text>;
  return (
    <Box flexDirection="column">
      <Row cells={['ITEM', 'CATEGORY', `Listed ${primary}`, `Implied ${primary}`, 'VIA', 'GAP', 'VOLUME']} widths={ARB_WIDTHS} selected={false} />
      {rows.map((r, i) => (
        <Row key={r.itemId} selected={i === selected} widths={ARB_WIDTHS}
          cells={[r.itemName, r.category, r.listed.toPrecision(4), r.implied.toPrecision(4), r.quoteCurrency, `${r.divergencePct.toFixed(1)}%`, Math.round(r.volumePrimaryValue).toLocaleString('en-US')]} />
      ))}
    </Box>
  );
}

const WATCH_WIDTHS = [22, 20, 60] as const;

function WatchesPane({ events, selected }: {
  readonly events: readonly WatchEvent[]; readonly selected: number;
}): React.JSX.Element {
  if (events.length === 0) return <Text color={DIM}>No watch events fired yet. Create watches with `exilium watches add` or via MCP.</Text>;
  return (
    <Box flexDirection="column">
      <Row cells={['FIRED AT', 'WATCH', 'EVENT']} widths={WATCH_WIDTHS} selected={false} />
      {events.map((e, i) => {
        const p = e.payload as { itemName?: string; value?: number; edge?: number; totalChange?: number };
        const bits = [
          p.itemName ?? '',
          p.value !== undefined ? `value ${p.value}` : '',
          p.edge !== undefined ? `edge ${(p.edge * 100).toFixed(1)}%` : '',
          p.totalChange !== undefined ? `change ${p.totalChange.toFixed(1)}%` : '',
        ].filter((b) => b !== '');
        return <Row key={e.seq} selected={i === selected} widths={WATCH_WIDTHS} cells={[e.firedAt, e.watchId, bits.join(' · ')]} />;
      })}
    </Box>
  );
}

const PAGE = 15;

/** Bloomberg-style terminal UI over the local snapshot store. Reads cached
 * data only; "r" triggers a live ingest via the injected callback. */
export function ExiliumTui({ service, game, league, refreshSec, onIngest, autoIngestSec }: TuiProps): React.JSX.Element {
  const { exit } = useApp();
  const { isRawModeSupported } = useStdin();
  const [view, setView] = useState<View>('movers');
  const [selected, setSelected] = useState(0);
  const [categoryIdx, setCategoryIdx] = useState(0);
  const [tick, setTick] = useState(0);
  const [ingesting, setIngesting] = useState(false);

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

  const data = useMemo(() => {
    const summary = service.marketSnapshot(game, league);
    const categories = ['All', ...service.categoryList(game, league).map((c) => c.category)];
    const category = categories[categoryIdx % categories.length] ?? 'All';
    const filter = category === 'All' ? undefined : category;
    const movers = service.moversDetailed(game, league, PAGE, filter);
    const opps = service.opportunities(game, league, true, 0, filter).opportunities.slice(0, PAGE);
    const arb = service.arbitrage(game, league, 0, filter).slice(0, PAGE);
    let watchEvents: readonly WatchEvent[] = [];
    try {
      watchEvents = service.recentWatchEvents(PAGE);
    } catch {
      // watches not enabled for this service instance — pane shows empty state
    }
    return { summary, categories, category, movers, opps, arb, watchEvents };
  }, [service, game, league, tick, ingesting, categoryIdx]);

  const rowCount =
    view === 'movers' ? data.movers.length : view === 'opps' ? data.opps.length : view === 'arb' ? data.arb.length : data.watchEvents.length;

  useInput((input, key) => {
    if (input === 'q' || (key.ctrl && input === 'c')) exit();
    if (input === '1') { setView('movers'); setSelected(0); }
    if (input === '2') { setView('opps'); setSelected(0); }
    if (input === '3') { setView('arb'); setSelected(0); }
    if (input === '4') { setView('watches'); setSelected(0); }
    if (key.downArrow) setSelected((s) => Math.min(rowCount - 1, s + 1));
    if (key.upArrow) setSelected((s) => Math.max(0, s - 1));
    if (key.rightArrow) { setCategoryIdx((c) => c + 1); setSelected(0); }
    if (key.leftArrow) { setCategoryIdx((c) => Math.max(0, c - 1)); setSelected(0); }
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
        <Header game={game} league={league} primary={data.summary.primaryCurrency} asOf={null} ingesting={ingesting} />
        <Text color={DIM}>No data ingested yet — press r to ingest now, or run `exilium ingest`.</Text>
      </Box>
    );
  }

  return (
    <Box flexDirection="column" paddingX={1}>
      <Header game={game} league={league} primary={data.summary.primaryCurrency} asOf={data.summary.asOf} ingesting={ingesting} />
      <Tabs view={view} category={data.category} />
      <Box marginTop={1}>
        {view === 'movers' && <MoversPane movers={data.movers} selected={selected} primary={data.summary.primaryCurrency} />}
        {view === 'opps' && <OppsPane opps={data.opps} selected={selected} />}
        {view === 'arb' && <ArbPane rows={data.arb} selected={selected} primary={data.summary.primaryCurrency} />}
        {view === 'watches' && <WatchesPane events={data.watchEvents} selected={selected} />}
      </Box>
      <Box marginTop={1}>
        <Text color={DIM}>humans execute all trades · data via poe.ninja · {data.summary.categories} categories</Text>
      </Box>
    </Box>
  );
}
