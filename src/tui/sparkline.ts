const BLOCKS = ['▁', '▂', '▃', '▄', '▅', '▆', '▇', '█'] as const;

/** Render a numeric series as a sparkline, scaled to its own min/max. Flat
 * series render at mid height. The ramp (low to high) is injectable so a
 * legacy Windows console can pass an ASCII-safe set instead of block glyphs. */
export function renderSparkline(data: readonly number[], ramp: readonly string[] = BLOCKS): string {
  if (data.length === 0) return '';
  const mid = ramp[Math.floor(ramp.length / 2)] ?? ramp[0]!;
  const min = Math.min(...data);
  const max = Math.max(...data);
  const range = max - min;
  if (range === 0) return mid.repeat(data.length);
  return data
    .map((v) => ramp[Math.min(ramp.length - 1, Math.floor(((v - min) / range) * ramp.length))]!)
    .join('');
}
