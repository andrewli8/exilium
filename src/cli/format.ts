import type { Opportunity, PriceQuote } from '../domain/types.js';
import type { ArbRow, CategorySummary, DetailedMover, MarketSummary } from '../mcp/service.js';
import type { JournalEntry, JournalSummary } from '../storage/journal-repository.js';
import { formatNumber } from '../domain/format-price.js';
import type { PricedListing } from '../trade/price-check.js';
import type { ParsedItem } from '../trade/parse-item.js';
import type { Watch, WatchEvent } from '../storage/watch-repository.js';

function table(headers: readonly string[], rows: readonly (readonly string[])[]): string {
  const widths = headers.map((h, i) => Math.max(h.length, ...rows.map((r) => (r[i] ?? '').length)));
  const line = (cells: readonly string[]) => cells.map((c, i) => c.padEnd(widths[i] ?? 0)).join('  ');
  return [line(headers), line(widths.map((w) => '-'.repeat(w))), ...rows.map(line)].join('\n');
}

export function formatPriceQuote(q: PriceQuote): string {
  const conversions = Object.entries(q.conversions)
    .map(([currency, value]) => `${formatNumber(value)} ${currency}`)
    .join(', ');
  return [
    `${q.name} (${q.game}/${q.league})`,
    `  ${formatNumber(q.primaryValue)} ${q.primaryCurrency}${conversions === '' ? '' : `  (= ${conversions})`}`,
    `  confidence ${(q.confidence * 100).toFixed(0)}% · as of ${q.asOf}`,
  ].join('\n');
}

export function formatOpportunityTable(opps: readonly Opportunity[]): string {
  if (opps.length === 0) return 'No opportunities at the current thresholds. Try --min-edge 0 or re-ingest.';
  return table(
    ['Detector', 'Item', 'Edge', 'Conf', 'Rationale'],
    opps.map((o) => [
      `${o.kind}${o.experimental ? ' ⚠️' : ''}`,
      o.itemName,
      `${(o.edge * 100).toFixed(1)}%`,
      `${(o.confidence * 100).toFixed(0)}%`,
      o.rationale,
    ]),
  );
}

export function formatSnapshotTable(s: MarketSummary): string {
  if (s.asOf === null) return 'No data ingested yet — run `exilium ingest` first.';
  const rows = (ms: typeof s.topMovers) =>
    ms.map((m) => [m.name, m.category, formatNumber(m.primaryValue), `${m.totalChange.toFixed(1)}%`, Math.round(m.volumePrimaryValue).toLocaleString('en-US')]);
  const headers = ['Item', 'Category', `Price (${s.primaryCurrency})`, 'Change', `Volume (${s.primaryCurrency})`];
  return [
    `${s.game}/${s.league} · ${s.categories} categories · as of ${s.asOf}`,
    '',
    'Top movers:',
    table(headers, rows(s.topMovers)),
    '',
    'Top volume:',
    table(headers, rows(s.topVolume)),
  ].join('\n');
}

export function formatCategoryTable(categories: readonly CategorySummary[], primaryCurrency: string): string {
  if (categories.length === 0) return 'No data ingested yet — run `exilium ingest` first.';
  return table(
    ['Category', 'Markets', `Volume (${primaryCurrency})`],
    categories.map((c) => [c.category, String(c.markets), Math.round(c.volumePrimaryValue).toLocaleString('en-US')]),
  );
}

export function formatItemTable(items: readonly DetailedMover[], primaryCurrency: string): string {
  if (items.length === 0) return 'No markets in this category.';
  return table(
    ['Item', `Price (${primaryCurrency})`, '7d change', `Volume (${primaryCurrency})`],
    items.map((i) => [i.name, formatNumber(i.primaryValue), `${i.totalChange.toFixed(1)}%`, Math.round(i.volumePrimaryValue).toLocaleString('en-US')]),
  );
}

export function formatArbTable(rows: readonly ArbRow[], primaryCurrency: string): string {
  if (rows.length === 0) return 'No cross-rate divergences found. The exchange is keeping rates consistent right now.';
  const sorted = [...rows].sort((a, b) => b.divergencePct - a.divergencePct);
  return table(
    ['Item', 'Category', `Listed (${primaryCurrency})`, `Implied (${primaryCurrency})`, 'Via', 'Gap', 'Volume'],
    sorted.map((r) => [
      r.itemName,
      r.category,
      formatNumber(r.listed),
      formatNumber(r.implied),
      r.quoteCurrency,
      `${r.divergencePct.toFixed(1)}%`,
      Math.round(r.volumePrimaryValue).toLocaleString('en-US'),
    ]),
  );
}

export function formatJournal(entries: readonly JournalEntry[], summary: JournalSummary): string {
  if (entries.length === 0) {
    return 'No outcomes recorded yet. After acting on a trade plan, run:\n  exilium journal add <opportunity_id> <filled|partial|no-fill|skipped> [note]';
  }
  const rows = table(
    ['When', 'Item', 'Outcome', 'Expected edge', 'Note'],
    entries.map((e) => [e.recordedAt, e.itemName, e.outcome, `${e.expectedEdgePct.toFixed(1)}%`, e.note ?? '']),
  );
  const c = summary.counts;
  const perDetector = Object.entries(summary.perDetector)
    .map(([d, s]) => `  ${d}: ${(s.fillRate * 100).toFixed(0)}% fill over ${s.total}`)
    .join('\n');
  return `${rows}\n\n${summary.total} recorded · fill rate ${(summary.fillRate * 100).toFixed(0)}% (filled ${c.filled}, partial ${c.partial}, no-fill ${c['no-fill']}, skipped ${c.skipped})${perDetector === '' ? '' : `\nBy detector:\n${perDetector}`}`;
}

export function formatWatchTable(watches: readonly Watch[]): string {
  if (watches.length === 0) {
    return 'No watches yet. Create one with:\n  exilium watches add --kind price_above --item divine --threshold 750';
  }
  return table(
    ['Id', 'Game/League', 'Kind', 'Target', 'Threshold', 'Mode', 'Webhook'],
    watches.map((w) => [
      w.id,
      `${w.game}/${w.league}`,
      w.kind,
      w.itemId ?? w.category ?? 'any',
      String(w.threshold),
      w.mode,
      w.webhookUrl === null ? '' : 'yes',
    ]),
  );
}

export function formatWatchEvents(events: readonly WatchEvent[]): string {
  if (events.length === 0) return 'No watch events fired yet.';
  const sorted = [...events].sort((a, b) => b.seq - a.seq);
  return table(
    ['When', 'Watch', 'Event'],
    sorted.map((e) => {
      const p = e.payload as { itemName?: string; value?: number; edge?: number; totalChange?: number };
      const bits = [p.itemName ?? '', p.value !== undefined ? `value ${p.value}` : '', p.edge !== undefined ? `edge ${(p.edge * 100).toFixed(1)}%` : '', p.totalChange !== undefined ? `change ${p.totalChange.toFixed(1)}%` : ''];
      return [e.firedAt, e.watchId, bits.filter((b) => b !== '').join(' · ')];
    }),
  );
}

export function formatPriceCheck(item: ParsedItem, listings: readonly PricedListing[]): string {
  const head = `${item.name}${item.baseType !== undefined && item.baseType !== item.name ? ` · ${item.baseType}` : ''} (${item.rarity})`;
  if (listings.length === 0) {
    return `${head}\n\nNo priced listings matched this exact item. It may be rare enough to have no comparable listings, or the filters are too tight. Press Enter to open the search and loosen it.`;
  }
  const rows = table(
    ['#', 'Price', 'Seller'],
    listings.map((l, i) => [String(i + 1), `${formatNumber(l.amount)} ${l.currency}`, l.seller]),
  );
  const amounts = listings.map((l) => l.amount);
  const inDiv = listings.filter((l) => l.currency === 'divine').map((l) => l.amount);
  const span = inDiv.length >= 2 ? `\nRange: ${formatNumber(Math.min(...inDiv))}–${formatNumber(Math.max(...inDiv))} divine across ${inDiv.length} listings` : '';
  const lo = Math.min(...amounts);
  return `${head}\n\n${rows}${span}\n\nCheapest: ${formatNumber(lo)} ${listings[0]!.currency}. Press Enter to open the full search in your browser.`;
}
