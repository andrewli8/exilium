import { assessFreshness } from '../domain/freshness.js';
import { renderPriceChart } from './chart.js';
import type { PricePoint } from '../storage/snapshot-repository.js';
import type { MarketSummary, MoverSummary, OpportunitiesResult } from '../mcp/service.js';
import type { Opportunity } from '../domain/types.js';

function esc(s: string): string {
  return s.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;').replaceAll('"', '&quot;');
}

function moverRows(movers: readonly MoverSummary[]): string {
  return movers
    .map(
      (m) => `<tr><td>${esc(m.name)}</td><td>${esc(m.category)}</td><td>${m.primaryValue.toPrecision(4)}</td><td>${m.totalChange.toFixed(1)}%</td><td>${Math.round(m.volumePrimaryValue).toLocaleString('en-US')}</td></tr>`,
    )
    .join('');
}

function oppRows(opps: readonly Opportunity[]): string {
  return opps
    .map(
      (o) => `<tr><td>${esc(o.kind)}${o.experimental ? ' ⚠️' : ''}</td><td>${esc(o.itemName)}</td><td>${(o.edge * 100).toFixed(1)}%</td><td>${(o.confidence * 100).toFixed(0)}%</td><td>${esc(o.rationale)}</td></tr>`,
    )
    .join('');
}

const STYLE = `body{font-family:ui-monospace,monospace;background:#0d1117;color:#e6edf3;margin:2rem}
table{border-collapse:collapse;width:100%;margin-bottom:2rem}
td,th{border:1px solid #30363d;padding:.4rem .6rem;text-align:left;font-size:.85rem}
th{background:#161b22}h1,h2{color:#d4a017}small{color:#8b949e}`;

export interface PairChartData {
  readonly itemId: string;
  readonly name: string;
  readonly points: readonly PricePoint[];
}

export interface RenderOptions {
  readonly nowMs: number;
  /** Page self-reloads on this cadence (reads the local store — cheap). */
  readonly reloadSec: number;
}

const FRESH_COLORS = { live: '#4cc38a', stale: '#e0a63f', old: '#e5534b' } as const;

/** Pure HTML renderer for the lean live dashboard (PRD: UI stays minimal). */
export function renderDashboard(
  summary: MarketSummary,
  opps: OpportunitiesResult,
  opts: RenderOptions = { nowMs: Date.now(), reloadSec: 30 },
  charts: readonly PairChartData[] = [],
): string {
  if (summary.asOf === null) {
    return `<html><head><style>${STYLE}</style></head><body><h1>Exilium</h1><p>No data ingested yet — run <code>npm run ingest</code> first.</p></body></html>`;
  }
  const fresh = assessFreshness(summary.asOf, opts.nowMs);
  const badge = fresh === null ? '' : `<span style="color:${FRESH_COLORS[fresh.level]}">●</span> ${esc(fresh.label)}`;
  return `<html><head><title>Exilium — ${esc(summary.league)}</title><style>${STYLE}</style>
<script>setTimeout(function () { location.reload(); }, ${opts.reloadSec * 1000});</script></head><body>
<h1>Exilium <small>· ${esc(summary.game)} · ${esc(summary.league)} · ${badge} · prices in ${esc(summary.primaryCurrency)} · reloads every ${opts.reloadSec}s · humans execute all trades</small></h1>
<h2>Opportunities</h2>
<table><tr><th>Detector</th><th>Item</th><th>Edge</th><th>Confidence</th><th>Rationale</th></tr>${oppRows(opps.opportunities)}</table>
${charts.length === 0 ? '' : `<h2>Price History <small>(local snapshots, in ${esc(summary.primaryCurrency)})</small></h2>
<div style="display:grid;grid-template-columns:repeat(auto-fit,minmax(280px,1fr));gap:1rem;margin-bottom:2rem">
${charts.map((c) => `<div><div style="font-size:.8rem;color:#8b949e;margin-bottom:.2rem">${esc(c.name)}</div>${renderPriceChart(c.points, { width: 300, height: 80 })}</div>`).join('')}
</div>`}
<h2>Top Movers</h2>
<table><tr><th>Item</th><th>Category</th><th>Price</th><th>Change</th><th>Volume</th></tr>${moverRows(summary.topMovers)}</table>
<h2>Top Volume</h2>
<table><tr><th>Item</th><th>Category</th><th>Price</th><th>Change</th><th>Volume</th></tr>${moverRows(summary.topVolume)}</table>
</body></html>`;
}
