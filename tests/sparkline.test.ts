import { describe, expect, test } from 'vitest';
import { renderSparkline } from '../src/tui/sparkline.js';

describe('renderSparkline', () => {
  test('maps low values to low blocks and high values to high blocks', () => {
    const out = renderSparkline([0, 50, 100]);
    expect(out).toHaveLength(3);
    expect(out[0]).toBe('▁');
    expect(out[2]).toBe('█');
  });

  test('renders a flat series as mid blocks, not a crash', () => {
    const out = renderSparkline([5, 5, 5]);
    expect(out).toHaveLength(3);
    expect(new Set(out.split('')).size).toBe(1);
  });

  test('returns empty string for empty input', () => {
    expect(renderSparkline([])).toBe('');
  });

  test('negative-to-positive ranges span the full block scale', () => {
    const out = renderSparkline([-10, 0, 10]);
    expect(out[0]).toBe('▁');
    expect(out[2]).toBe('█');
  });
});
