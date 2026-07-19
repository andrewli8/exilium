const BLOCKS = ['▁', '▂', '▃', '▄', '▅', '▆', '▇', '█'] as const;

/** Render a numeric series as unicode block sparkline, scaled to its own
 * min/max. Flat series render as mid-height blocks. */
export function renderSparkline(data: readonly number[]): string {
  if (data.length === 0) return '';
  const min = Math.min(...data);
  const max = Math.max(...data);
  const range = max - min;
  if (range === 0) return BLOCKS[3]!.repeat(data.length);
  return data
    .map((v) => BLOCKS[Math.min(BLOCKS.length - 1, Math.floor(((v - min) / range) * BLOCKS.length))]!)
    .join('');
}
