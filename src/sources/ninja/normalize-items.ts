import { z } from 'zod';
import type { MarketLine, MarketSnapshot } from '../../domain/types.js';
import type { NormalizeContext } from './normalize.js';

/** Normalizer for poe.ninja's stash/item overview API (uniques, maps, gems,
 * beasts, base types — everything the in-game exchange does not trade).
 *
 * Semantics differ from the exchange normalizer in two documented ways:
 * - Prices are listing-derived (chaosValue), not exchange ratios.
 * - volumePrimaryValue is a market-depth proxy: chaosValue × listingCount.
 *   There is no traded-volume figure for listings; depth-in-chaos keeps
 *   volume sorting and confidence heuristics meaningful. */

const itemLineSchema = z.object({
  id: z.number(),
  detailsId: z.string().optional(),
  name: z.string(),
  baseType: z.string().nullish(),
  variant: z.string().nullish(),
  links: z.number().nullish(),
  gemLevel: z.number().nullish(),
  gemQuality: z.number().nullish(),
  corrupted: z.boolean().nullish(),
  chaosValue: z.number().nullish(),
  divineValue: z.number().nullish(),
  listingCount: z.number().nonnegative().default(0),
  sparkLine: z
    .object({ totalChange: z.number().nullable().default(0), data: z.array(z.number().nullable()).default([]) })
    .default({ totalChange: 0, data: [] }),
});

const itemOverviewSchema = z.object({ lines: z.array(itemLineSchema) });

/** Turn poe.ninja's variant fields into a readable, searchable suffix:
 * gems spell out level/quality/corruption ("(lvl 1, 23q, corrupt)")
 * instead of the cryptic "1/23c"; linked uniques show "(6L)". */
function buildSuffix(l: { gemLevel?: number | null | undefined; gemQuality?: number | null | undefined; corrupted?: boolean | null | undefined; variant?: string | null | undefined; links?: number | null | undefined }): string {
  if (l.gemLevel != null) {
    const parts = [`lvl ${l.gemLevel}`];
    if (l.gemQuality != null && l.gemQuality > 0) parts.push(`${l.gemQuality}q`);
    if (l.corrupted === true) parts.push('corrupt');
    return ` (${parts.join(', ')})`;
  }
  if (l.variant != null && l.variant !== '') return ` (${l.variant})`;
  if (l.links != null && l.links >= 5) return ` (${l.links}L)`;
  return '';
}

export function normalizeItemOverview(raw: unknown, ctx: NormalizeContext): MarketSnapshot {
  const parsed = itemOverviewSchema.safeParse(raw);
  if (!parsed.success) {
    throw new Error(
      `Invalid item overview payload for ${ctx.league}/${ctx.category}: ${parsed.error.issues[0]?.message ?? 'unknown error'}`,
    );
  }
  const lines: readonly MarketLine[] = parsed.data.lines
    .filter((l) => (l.chaosValue ?? 0) > 0)
    .map((l) => {
      const suffix = buildSuffix(l);
      const chaosValue = l.chaosValue ?? 0;
      return {
        itemId: l.detailsId ?? String(l.id),
        name: `${l.name}${suffix}`,
        category: ctx.category,
        primaryValue: chaosValue,
        volumePrimaryValue: chaosValue * l.listingCount,
        maxVolumeCurrency: null,
        maxVolumeRate: null,
        sparkline: l.sparkLine.data.filter((v): v is number => v !== null),
        totalChange: l.sparkLine.totalChange ?? 0,
      };
    });
  // Recover the chaos->divine rate from any line carrying both values, so
  // big-ticket items can display in divines like the exchange categories.
  const ratePair = parsed.data.lines.find((l) => (l.chaosValue ?? 0) > 0 && (l.divineValue ?? 0) > 0);
  const perPrimary: Record<string, number> = { chaos: 1 };
  if (ratePair !== undefined) perPrimary['divine'] = (ratePair.divineValue ?? 0) / (ratePair.chaosValue ?? 1);
  return {
    game: ctx.game,
    league: ctx.league,
    category: ctx.category,
    fetchedAt: ctx.fetchedAt,
    core: { primary: 'chaos', perPrimary },
    lines,
  };
}
