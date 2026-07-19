import { describe, expect, test } from 'vitest';
import { renderPriceChart } from '../src/dashboard/chart.js';
import type { PricePoint } from '../src/storage/snapshot-repository.js';

function points(values: readonly number[]): readonly PricePoint[] {
  return values.map((v, i) => ({
    fetchedAt: `2026-07-18T${String(10 + i).padStart(2, '0')}:00:00Z`,
    primaryValue: v,
    volumePrimaryValue: 100,
  }));
}

describe('renderPriceChart', () => {
  test('renders an SVG polyline scaled to the value range', () => {
    const svg = renderPriceChart(points([10, 20, 15, 30]), { width: 300, height: 80 });
    expect(svg).toContain('<svg');
    expect(svg).toContain('polyline');
    expect(svg).toContain('viewBox="0 0 300 80"');
    // highest value (30) maps near the top (small y), lowest (10) near the bottom
    const coords = /points="([^"]+)"/.exec(svg)![1]!.split(' ').map((p) => p.split(',').map(Number));
    const ys = coords.map((c) => c[1]!);
    expect(Math.min(...ys)).toBeLessThan(Math.max(...ys));
    expect(ys[3]).toBeLessThan(ys[0]!);
  });

  test('marks the latest point and includes min/max labels', () => {
    const svg = renderPriceChart(points([10, 20, 15, 30]), { width: 300, height: 80 });
    expect(svg).toContain('<circle');
    expect(svg).toContain('30');
    expect(svg).toContain('10');
  });

  test('returns a placeholder message for fewer than 2 points', () => {
    expect(renderPriceChart(points([10]), { width: 300, height: 80 })).toMatch(/accumulating|not enough/i);
    expect(renderPriceChart([], { width: 300, height: 80 })).toMatch(/accumulating|not enough/i);
  });

  test('flat series renders without NaN coordinates', () => {
    const svg = renderPriceChart(points([5, 5, 5]), { width: 300, height: 80 });
    expect(svg).not.toContain('NaN');
  });
});
