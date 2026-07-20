import { describe, expect, test } from 'vitest';
import { change24hFromHistory, change24hFromSparkline } from '../src/signals/change24h.js';

describe('change24hFromSparkline', () => {
  test('derives the last-day segment from cumulative daily points', () => {
    // Cumulative % vs window start: day6 +14.77, day7 +7.16 → last day ≈ -6.63%
    const c = change24hFromSparkline([0.97, 2.21, 8.12, 11.92, 12.86, 14.77, 7.16]);
    expect(c).toBeCloseTo(((1 + 0.0716) / (1 + 0.1477) - 1) * 100, 5);
  });

  test('needs at least two points', () => {
    expect(change24hFromSparkline([5])).toBeNull();
    expect(change24hFromSparkline([])).toBeNull();
  });
});

describe('change24hFromHistory', () => {
  const now = Date.parse('2026-07-20T12:00:00Z');
  test('uses the stored price closest to 24h ago within tolerance', () => {
    const c = change24hFromHistory(110, [
      { fetchedAt: '2026-07-19T11:30:00Z', primaryValue: 100, volumePrimaryValue: 1 },
      { fetchedAt: '2026-07-20T11:00:00Z', primaryValue: 108, volumePrimaryValue: 1 },
    ], now);
    expect(c).toBeCloseTo(10); // vs the ~24h-old point, not the 1h-old one
  });

  test('returns null when no point falls in the 18-30h window', () => {
    expect(change24hFromHistory(110, [
      { fetchedAt: '2026-07-20T11:00:00Z', primaryValue: 108, volumePrimaryValue: 1 },
    ], now)).toBeNull();
    expect(change24hFromHistory(110, [], now)).toBeNull();
  });
});
