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

/** Human number formatting that NEVER uses scientific notation: thousands
 * separators for big values, a couple of significant decimals otherwise. */
export function formatNumber(v: number): string {
  const abs = Math.abs(v);
  if (abs === 0) return '0';
  if (abs >= 1000) return Math.round(v).toLocaleString('en-US');
  if (abs >= 1) return trimZeros(v.toFixed(2));
  // Sub-1: enough decimals to keep ~2 significant figures, decimal always.
  const decimals = Math.min(8, 2 - Math.floor(Math.log10(abs)));
  return trimZeros(v.toFixed(decimals));
}

function trimZeros(s: string): string {
  return s.includes('.') ? s.replace(/\.?0+$/, '') : s;
}

function trim(v: number): string {
  return formatNumber(v);
}
