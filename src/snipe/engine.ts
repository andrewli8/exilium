import type { MarketSnapshot } from '../domain/types.js';
import { formatNumber } from '../domain/format-price.js';
import type { LiveListing } from '../trade/live-search.js';
import type { SnipeTarget } from './bettertrading.js';
import { toChaos, type MarginAssessment, passesMarginGate } from './margin.js';

/** The snipe decision core: given a live listing, its target's rules, and a
 * margin assessment, either produce a ready-to-send alert or a suppression
 * with a reason. Pure — sockets, clipboards, and browsers live in the CLI. */

export interface SnipeAlert {
  readonly targetLabel: string;
  readonly listingId: string;
  readonly itemName: string;
  readonly priceText: string;
  readonly seller: string;
  readonly whisper: string;
  readonly searchUrl: string;
  readonly listedChaos: number | null;
  readonly marginChaos: number | null;
  readonly marginPct: number | null;
  readonly marginText: string;
  readonly freshnessText: string;
  /** Reference price older than 10 minutes. */
  readonly stale: boolean;
  /** A margin threshold was set but this item has no reference price. */
  readonly unknownMargin: boolean;
}

export type SnipeDecision =
  | { readonly kind: 'alert'; readonly alert: SnipeAlert }
  | { readonly kind: 'suppressed'; readonly reason: string };

/** Search page URL for a target under the resolved league (slugs are
 * league-portable; the league lives only in the path). */
export function buildSearchPageUrl(target: Pick<SnipeTarget, 'realm' | 'searchId'>, league: string): string {
  const base =
    target.realm === 'trade2'
      ? `https://www.pathofexile.com/trade2/search/poe2/${encodeURIComponent(league)}`
      : `https://www.pathofexile.com/trade/search/${encodeURIComponent(league)}`;
  return `${base}/${target.searchId}`;
}

function marginText(assessment: MarginAssessment, unknownMargin: boolean): string {
  const { marginChaos, marginPct } = assessment;
  if (marginChaos === null || marginPct === null) {
    if (assessment.referenceChaos === null) {
      return unknownMargin ? 'margin unknown (no reference price) — judge it yourself' : 'no reference price';
    }
    return `ref ${formatNumber(assessment.referenceChaos)}c, listing price unknown`;
  }
  const sign = (v: number): string => (v >= 0 ? '+' : '-');
  return `${sign(marginChaos)}${formatNumber(Math.abs(marginChaos))}c (${sign(marginPct)}${Math.abs(marginPct).toFixed(1)}%)`;
}

export interface DecideSnipeOptions {
  readonly listing: LiveListing;
  readonly target: SnipeTarget;
  readonly assessment: MarginAssessment;
  readonly snapshots: readonly MarketSnapshot[];
  /** Folder-wide minimum margin (percent); per-target overrides win. */
  readonly globalMinMarginPct: number | null;
  /** Resolved league every search runs under (default: Allflame). */
  readonly league: string;
  readonly seen: ReadonlySet<string>;
}

/** True when the listing price exceeds the target's max buy. Unconvertible
 * prices fail open — a human judging a snipe beats a silent skip. */
function aboveMaxBuy(opts: DecideSnipeOptions): boolean {
  const { listing, target, snapshots } = opts;
  if (target.maxBuy === undefined || listing.price === null) return false;
  if (listing.price.currency === target.maxBuy.currency) {
    return listing.price.amount > target.maxBuy.amount;
  }
  const listedChaos = toChaos(listing.price, snapshots);
  const maxChaos = toChaos(target.maxBuy, snapshots);
  if (listedChaos === null || maxChaos === null) return false;
  return listedChaos > maxChaos;
}

export function decideSnipe(opts: DecideSnipeOptions): SnipeDecision {
  const { listing, target, assessment } = opts;
  if (opts.seen.has(listing.id)) {
    return { kind: 'suppressed', reason: `duplicate listing ${listing.id}` };
  }
  if (aboveMaxBuy(opts)) {
    return {
      kind: 'suppressed',
      reason: `above max buy (${listing.priceText} > ${target.maxBuy!.amount} ${target.maxBuy!.currency}) for "${target.label}"`,
    };
  }
  const threshold = target.minMarginPct ?? opts.globalMinMarginPct;
  const gate = passesMarginGate(assessment, threshold);
  if (!gate.pass) {
    const pct = assessment.marginPct === null ? '?' : assessment.marginPct.toFixed(1);
    return { kind: 'suppressed', reason: `margin ${pct}% below the ${threshold}% minimum for "${target.label}"` };
  }

  const stale = assessment.freshness !== null && assessment.freshness.level !== 'live';
  return {
    kind: 'alert',
    alert: {
      targetLabel: target.label,
      listingId: listing.id,
      itemName: listing.itemName,
      priceText: listing.priceText,
      seller: listing.seller,
      whisper: listing.whisper,
      searchUrl: buildSearchPageUrl(target, opts.league),
      listedChaos: assessment.listedChaos,
      marginChaos: assessment.marginChaos,
      marginPct: assessment.marginPct,
      marginText: marginText(assessment, gate.unknownMargin),
      freshnessText: assessment.freshness === null ? 'ref age unknown' : `ref ${assessment.freshness.label}`,
      stale,
      unknownMargin: gate.unknownMargin,
    },
  };
}

export interface RenderedAlert {
  readonly title: string;
  readonly body: string;
  /** One console line per snipe, timestamped by the caller. */
  readonly line: string;
}

export function formatAlert(alert: SnipeAlert): RenderedAlert {
  const staleTag = alert.stale ? ' · STALE >10m — reprice before you commit' : '';
  return {
    title: `Exilium snipe: ${alert.itemName} · ${alert.priceText}`,
    body: `${alert.marginText} · ${alert.freshnessText}${staleTag} · whisper copied`,
    line: `[${alert.targetLabel}] ${alert.itemName} · ${alert.priceText} · ${alert.marginText} · seller ${alert.seller}`,
  };
}
