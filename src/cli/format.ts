import type { Opportunity, PriceQuote } from '../domain/types.js';
import type { ArbRow, CategorySummary, DetailedMover, MarketSummary } from '../mcp/service.js';
import type { JournalEntry, JournalSummary } from '../storage/journal-repository.js';

function table(headers: readonly string[], rows: readonly (readonly string[])[]): string {
  const widths = headers.map((h, i) => Math.max(h.length, ...rows.map((r) => (r[i] ?? '').length)));
  const line = (cells: readonly string[]) => cells.map((c, i) => c.padEnd(widths[i] ?? 0)).join('  ');
  return [line(headers), line(widths.map((w) => '-'.repeat(w))), ...rows.map(line)].join('\n');
}

export function formatPriceQuote(q: PriceQuote): string {
  const conversions = Object.entries(q.conversions)
    .map(([currency, value]) => `${value.toPrecision(4)} ${currency}`)
    .join(', ');
  return [
    `${q.name} (${q.game}/${q.league})`,
    `  ${q.primaryValue.toPrecision(6)} ${q.primaryCurrency}${conversions === '' ? '' : `  (= ${conversions})`}`,
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
    ms.map((m) => [m.name, m.category, m.primaryValue.toPrecision(4), `${m.totalChange.toFixed(1)}%`, Math.round(m.volumePrimaryValue).toLocaleString('en-US')]);
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
    items.map((i) => [i.name, i.primaryValue.toPrecision(4), `${i.totalChange.toFixed(1)}%`, Math.round(i.volumePrimaryValue).toLocaleString('en-US')]),
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
      r.listed.toPrecision(4),
      r.implied.toPrecision(4),
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
  return `${rows}\n\n${summary.total} recorded · fill rate ${(summary.fillRate * 100).toFixed(0)}% (filled ${c.filled}, partial ${c.partial}, no-fill ${c['no-fill']}, skipped ${c.skipped})`;
}
