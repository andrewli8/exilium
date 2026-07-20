export interface PriceDisplay {
  readonly text: string;
  /** 'c' for chaos, 'div' for divine. */
  readonly unit: 'c' | 'div' | string;
}

/** Display a primary-currency price in trader units: chaos prices worth a
 * divine or more convert to divines (nobody says "144,000 chaos" for a
 * Mageblood), using the live rate from the snapshot core. */
export function formatPriceUnits(
  valueInPrimary: number,
  primaryCurrency: string,
  divinePerPrimary: number | null,
): PriceDisplay {
  if (primaryCurrency === 'divine') {
    return { text: trim(valueInPrimary), unit: 'div' };
  }
  if (primaryCurrency === 'chaos') {
    const inDivine = divinePerPrimary === null ? null : valueInPrimary * divinePerPrimary;
    if (inDivine !== null && inDivine >= 1) {
      return { text: trim(inDivine), unit: 'div' };
    }
    return { text: Math.round(valueInPrimary).toLocaleString('en-US'), unit: 'c' };
  }
  return { text: trim(valueInPrimary), unit: primaryCurrency };
}

function trim(v: number): string {
  if (v >= 100) return String(Math.round(v));
  if (v >= 10) return v.toFixed(1);
  if (v >= 1) return v.toFixed(2);
  return v.toPrecision(3);
}
