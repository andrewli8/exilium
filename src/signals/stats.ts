export function mean(xs: readonly number[]): number {
  return xs.length === 0 ? 0 : xs.reduce((a, b) => a + b, 0) / xs.length;
}

export function stddev(xs: readonly number[]): number {
  if (xs.length < 2) return 0;
  const m = mean(xs);
  return Math.sqrt(xs.reduce((acc, x) => acc + (x - m) ** 2, 0) / (xs.length - 1));
}

/** Volume-scaled 0..1 confidence heuristic (log curve, saturates ~1M divine). */
export function volumeConfidence(volumePrimaryValue: number): number {
  return Math.min(1, Math.log10(1 + Math.max(0, volumePrimaryValue)) / 6);
}
