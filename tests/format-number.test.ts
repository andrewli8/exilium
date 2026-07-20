import { describe, expect, test } from 'vitest';
import { formatNumber } from '../src/domain/format-price.js';

describe('formatNumber', () => {
  test('never uses scientific notation for large values', () => {
    expect(formatNumber(1070320)).toBe('1,070,320');
    expect(formatNumber(3399070)).toBe('3,399,070');
    expect(formatNumber(10048781)).toBe('10,048,781');
  });

  test('mid-range values keep a couple of significant decimals, trimmed', () => {
    expect(formatNumber(720)).toBe('720');
    expect(formatNumber(1.008)).toBe('1.01');
    expect(formatNumber(1499)).toBe('1,499');
    expect(formatNumber(52.75)).toBe('52.75');
  });

  test('small values stay decimal with enough precision', () => {
    expect(formatNumber(0.13)).toBe('0.13');
    expect(formatNumber(0.0014)).toBe('0.0014');
    expect(formatNumber(0.00042)).toBe('0.00042');
  });

  test('zero and negatives', () => {
    expect(formatNumber(0)).toBe('0');
    expect(formatNumber(-1500000)).toBe('-1,500,000');
  });
})
