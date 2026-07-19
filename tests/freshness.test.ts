import { describe, expect, test } from 'vitest';
import { assessFreshness } from '../src/domain/freshness.js';

const NOW = Date.parse('2026-07-18T18:00:00Z');

describe('assessFreshness', () => {
  test('classifies recent data as live with a compact age label', () => {
    const f = assessFreshness('2026-07-18T17:58:30Z', NOW);
    expect(f).not.toBeNull();
    expect(f!.level).toBe('live');
    expect(f!.label).toBe('1m ago');
  });

  test('classifies 10-30 minute old data as stale', () => {
    expect(assessFreshness('2026-07-18T17:45:00Z', NOW)!.level).toBe('stale');
  });

  test('classifies older data as old with hour labels', () => {
    const f = assessFreshness('2026-07-18T15:00:00Z', NOW);
    expect(f!.level).toBe('old');
    expect(f!.label).toBe('3h ago');
  });

  test('sub-minute data reads as "just now"', () => {
    expect(assessFreshness('2026-07-18T17:59:50Z', NOW)!.label).toBe('just now');
  });

  test('returns null for null input', () => {
    expect(assessFreshness(null, NOW)).toBeNull();
  });
});
