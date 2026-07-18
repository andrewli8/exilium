import { z } from 'zod';
import type { Game, MarketLine, MarketSnapshot } from '../../domain/types.js';

const itemSchema = z.object({
  id: z.string(),
  name: z.string(),
});

const lineSchema = z.object({
  id: z.string(),
  primaryValue: z.number(),
  volumePrimaryValue: z.number().nonnegative().default(0),
  maxVolumeCurrency: z.string().optional(),
  maxVolumeRate: z.number().optional(),
  sparkline: z
    .object({
      totalChange: z.number().nullable().default(0),
      // Days with no trades come through as null — treated as gaps downstream.
      data: z.array(z.number().nullable()).default([]),
    })
    .default({ totalChange: 0, data: [] }),
});

const overviewSchema = z.object({
  core: z.object({
    rates: z.record(z.string(), z.number()),
    primary: z.string(),
  }),
  lines: z.array(lineSchema),
  items: z.array(itemSchema).default([]),
});

export interface NormalizeContext {
  readonly game: Game;
  readonly league: string;
  readonly category: string;
  readonly fetchedAt: string;
}

/** Validate and normalize a raw poe.ninja exchange overview payload into a
 * MarketSnapshot. Throws with a descriptive message on malformed input. */
export function normalizeExchangeOverview(raw: unknown, ctx: NormalizeContext): MarketSnapshot {
  const parsed = overviewSchema.safeParse(raw);
  if (!parsed.success) {
    throw new Error(`Invalid exchange overview payload for ${ctx.league}/${ctx.category}: ${parsed.error.issues[0]?.message ?? 'unknown error'}`);
  }
  const { core, lines, items } = parsed.data;
  const namesById = new Map(items.map((i) => [i.id, i.name]));

  const normalized: readonly MarketLine[] = lines
    .filter((l) => l.primaryValue > 0)
    .map((l) => ({
      itemId: l.id,
      name: namesById.get(l.id) ?? l.id,
      category: ctx.category,
      primaryValue: l.primaryValue,
      volumePrimaryValue: l.volumePrimaryValue,
      maxVolumeCurrency: l.maxVolumeCurrency ?? null,
      maxVolumeRate: l.maxVolumeRate ?? null,
      sparkline: l.sparkline.data.filter((x): x is number => x !== null),
      totalChange: l.sparkline.totalChange ?? 0,
    }));

  return {
    game: ctx.game,
    league: ctx.league,
    category: ctx.category,
    fetchedAt: ctx.fetchedAt,
    core: { primary: core.primary, perPrimary: { [core.primary]: 1, ...core.rates } },
    lines: normalized,
  };
}
