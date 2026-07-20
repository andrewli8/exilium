import { describe, expect, test } from 'vitest';
import { formatPriceUnits } from '../src/domain/format-price.js';

describe('formatPriceUnits', () => {
  const divPerChaos = 1 / 720; // 720c per divine

  test('small chaos prices stay in chaos', () => {
    expect(formatPriceUnits(583.4, 'chaos', divPerChaos)).toEqual({ text: '583', unit: 'c' });
  });

  test('prices worth a divine or more convert to divines', () => {
    expect(formatPriceUnits(1838, 'chaos', divPerChaos)).toEqual({ text: '2.55', unit: 'div' });
    expect(formatPriceUnits(1070320, 'chaos', divPerChaos)).toEqual({ text: '1,487', unit: 'div' });
  });

  test('divine-primary values (poe2) keep the div unit untouched', () => {
    expect(formatPriceUnits(0.13, 'divine', null)).toEqual({ text: '0.13', unit: 'div' });
  });

  test('no divine rate means no conversion', () => {
    expect(formatPriceUnits(5000, 'chaos', null)).toEqual({ text: '5,000', unit: 'c' });
  });
});
