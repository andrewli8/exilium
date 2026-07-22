import { describe, expect, test } from 'vitest';
import { formatDelta } from '../src/domain/format-price.js';

describe('formatDelta', () => {
  test('moderate moves stay as a signed percent', () => {
    expect(formatDelta(12.3)).toBe('+12.3%');
    expect(formatDelta(-30)).toBe('-30.0%');
    expect(formatDelta(0)).toBe('0.0%');
    expect(formatDelta(99)).toBe('+99.0%');
  });

  test('a doubling or more is shown as a clean multiplier', () => {
    expect(formatDelta(100)).toBe('2×');
    expect(formatDelta(150)).toBe('2.5×');
    expect(formatDelta(4900)).toBe('50×'); // the absurd "+4900%" case
    expect(formatDelta(900)).toBe('10×');
  });

  test('a halving or more is shown as a division', () => {
    expect(formatDelta(-50)).toBe('÷2');
    expect(formatDelta(-95)).toBe('÷20');
    expect(formatDelta(-80)).toBe('÷5');
  });

  test('a total wipe (-100%) falls back to percent, not a divide-by-zero', () => {
    expect(formatDelta(-100)).toBe('-100.0%');
  });
});
