import {
  parseFetchResponseBody,
  type LiveListing,
  type TradeSearch,
} from '../trade/live-search.js';
import { buildSearchPageUrl } from './engine.js';
import type { TravelPage } from './travel.js';
import {
  createCdpPage,
  type CdpTravelPage,
  type CreateCdpPageOptions,
} from './cdp.js';

/**
 * Browser-live mode rides the trade site's own live page instead of calling
 * the trade API ourselves. The page keeps its own websocket open and fetches
 * every new listing itself, inside its normal browser session and budget;
 * Exilium only reads those response bodies off the wire via CDP. No extra
 * request ever leaves this process for listing details, which is what keeps
 * this mode clear of the API rate limits the direct mode has to schedule
 * around.
 */

export type BrowserLiveSource = 'seed' | 'live';

export interface BrowserLiveSearchOptions {
  readonly cdpUrl: string;
  readonly search: TradeSearch;
  readonly log: (message: string) => void;
  readonly onListings: (listings: readonly LiveListing[], source: BrowserLiveSource) => void;
  readonly onDisconnect?: () => void;
  /** Captures within this window after the live page opens are the page's
   * current results (seed), not fresh live hits. Default 10s. */
  readonly seedWindowMs?: number;
  readonly createPage?: (options: CreateCdpPageOptions) => Promise<CdpTravelPage>;
  readonly now?: () => number;
}

export interface BrowserLiveSearchHandle {
  /** The owned tab, already showing this search's live page. Travel can click
   * a row here directly instead of navigating a separate tab. */
  readonly page: CdpTravelPage;
  close(): Promise<void>;
}

const DEFAULT_SEED_WINDOW_MS = 10_000;

export function liveSearchPageUrl(search: TradeSearch): string {
  return `${buildSearchPageUrl({ realm: search.realm, searchId: search.searchId }, search.league)}/live`;
}

/** Adapt an open live tab into a TravelPage. The tab already renders this
 * search's rows, so `url()` reports the search URL and `goto` is a no-op —
 * travelSelectedAlert must never navigate the capture tab away from /live. */
export function liveTabTravelPage(page: CdpTravelPage, searchUrl: string): TravelPage {
  return {
    url: () => searchUrl,
    goto: async () => undefined,
    clickTravelButton: (listingId) => page.clickTravelButton(listingId),
  };
}

export async function openBrowserLiveSearch(
  options: BrowserLiveSearchOptions,
): Promise<BrowserLiveSearchHandle> {
  const now = options.now ?? Date.now;
  const seedWindowMs = options.seedWindowMs ?? DEFAULT_SEED_WINDOW_MS;
  let openedAt = now();
  const page = await (options.createPage ?? createCdpPage)({
    cdpUrl: options.cdpUrl,
    log: options.log,
    onTradeFetchBody: (url, body) => {
      let listings: readonly LiveListing[];
      try {
        listings = parseFetchResponseBody(JSON.parse(body));
      } catch (error) {
        options.log(`browser-live: ignoring an unparsable fetch payload from ${url}: ${error instanceof Error ? error.message : String(error)}`);
        return;
      }
      if (listings.length === 0) return;
      options.onListings(listings, now() - openedAt < seedWindowMs ? 'seed' : 'live');
    },
    ...(options.onDisconnect === undefined ? {} : { onDisconnect: options.onDisconnect }),
  });
  try {
    await page.goto(liveSearchPageUrl(options.search));
  } catch (error) {
    await page.close();
    throw error;
  }
  openedAt = now();
  return { page, close: () => page.close() };
}
