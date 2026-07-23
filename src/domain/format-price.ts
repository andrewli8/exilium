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

/** Format a percentage change so large swings read as a multiplier instead of
 * an absurd percent. A price that went 50× is "50×", not "+4900%"; one that
 * fell to a twentieth is "÷20", not "-95%". Moderate moves (between halving
 * and doubling) stay as a signed percent, which is what a percent is good at.
 * A total wipe (-100%) has no finite multiplier, so it stays a percent. */
export function formatDelta(pct: number, symbols: { times: string; over: string } = { times: '×', over: '÷' }): string {
  const multiplier = 1 + pct / 100;
  if (multiplier >= 2) return `${trimZeros(multiplier.toFixed(multiplier >= 100 ? 0 : 1))}${symbols.times}`;
  if (multiplier > 0 && multiplier <= 0.5) return `${symbols.over}${trimZeros((1 / multiplier).toFixed(1 / multiplier >= 100 ? 0 : 1))}`;
  return `${pct > 0 ? '+' : ''}${pct.toFixed(1)}%`;
}
