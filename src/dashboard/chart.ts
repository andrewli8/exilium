import type { PricePoint } from '../storage/snapshot-repository.js';

export interface ChartOptions {
  readonly width: number;
  readonly height: number;
}

const PAD = 6;
const GOLD = '#d4a017';
const GRID = '#30363d';

/** Pure SVG line chart of stored price history. Self-contained markup —
 * no external assets, safe to inline in the dashboard. */
export function renderPriceChart(points: readonly PricePoint[], opts: ChartOptions): string {
  if (points.length < 2) {
    return `<div class="chart-empty">history accumulating — ${points.length}/2 snapshots so far</div>`;
  }
  const { width, height } = opts;
  const values = points.map((p) => p.primaryValue);
  const min = Math.min(...values);
  const max = Math.max(...values);
  const range = max - min || max || 1; // flat series: avoid divide-by-zero
  const x = (i: number): number => PAD + (i / (points.length - 1)) * (width - 2 * PAD);
  const y = (v: number): number => PAD + (1 - (v - min) / range) * (height - 2 * PAD);
  const coords = values.map((v, i) => `${x(i).toFixed(1)},${y(v).toFixed(1)}`).join(' ');
  const last = values[values.length - 1]!;
  const fmt = (v: number): string => v.toPrecision(4);
  return `<svg viewBox="0 0 ${width} ${height}" xmlns="http://www.w3.org/2000/svg" role="img">
<line x1="${PAD}" y1="${(height / 2).toFixed(1)}" x2="${width - PAD}" y2="${(height / 2).toFixed(1)}" stroke="${GRID}" stroke-dasharray="2,4" stroke-width="1"/>
<polyline fill="none" stroke="${GOLD}" stroke-width="1.5" points="${coords}"/>
<circle cx="${x(points.length - 1).toFixed(1)}" cy="${y(last).toFixed(1)}" r="2.5" fill="${GOLD}"/>
<text x="${width - PAD}" y="${PAD + 8}" text-anchor="end" font-size="9" fill="#8b95a4">${fmt(max)}</text>
<text x="${width - PAD}" y="${height - PAD}" text-anchor="end" font-size="9" fill="#8b95a4">${fmt(min)}</text>
</svg>`;
}
