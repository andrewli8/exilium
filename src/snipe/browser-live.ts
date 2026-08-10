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
/** Tab CDP command budget. The trade site is heavy and several tabs open at
 * once; the default 6s regularly expired mid-load and detached capture. */
const TAB_COMMAND_TIMEOUT_MS = 20_000;
const KICKSTART_DEADLINE_MS = 15_000;
/** After the initial in-page search settles, its results may still be in
 * flight — keep classifying captures as seed for this much longer. */
const KICKSTART_SEED_GRACE_MS = 5_000;

export function liveSearchPageUrl(search: TradeSearch): string {
  return `${buildSearchPageUrl({ realm: search.realm, searchId: search.searchId }, search.league)}/live`;
}

/** The /live page only streams NEW listings; the search's current results
 * never load on their own. Click the page's own Search button once so the
 * current results arrive through the same captured fetches — still zero
 * Exilium-side API calls. */
function kickstartSearchExpression(): string {
  return `(async () => {
    const deadline = Date.now() + ${KICKSTART_DEADLINE_MS};
    const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
    for (;;) {
      if (document.querySelector('[data-id]')) return 'results';
      const button = document.querySelector('button.search-btn')
        || Array.from(document.querySelectorAll('button'))
          .find((element) => element.textContent && element.textContent.trim() === 'Search');
      if (button instanceof HTMLButtonElement && !button.disabled) {
        button.click();
        return 'clicked';
      }
      if (Date.now() >= deadline) return 'search button not found';
      await sleep(500);
    }
  })()`;
}

/** Adapt an open live tab into a TravelPage. The tab already renders this
 * search's rows, so `url()` reports the search URL and `goto` is a no-op —
 * travelSelectedAlert must never navigate the capture tab away from /live. */
export function liveTabTravelPage(page: CdpTravelPage, searchUrl: string): TravelPage {
  return {
    url: () => searchUrl,
    goto: async () => undefined,
    clickTravelButton: (listingId) => page.clickTravelButton(listingId, { allowReload: false }),
  };
}

export async function openBrowserLiveSearch(
  options: BrowserLiveSearchOptions,
): Promise<BrowserLiveSearchHandle> {
  const now = options.now ?? Date.now;
  const seedWindowMs = options.seedWindowMs ?? DEFAULT_SEED_WINDOW_MS;
  let seedUntil = now() + seedWindowMs;
  let firstCaptureLogged = false;
  const page = await (options.createPage ?? createCdpPage)({
    cdpUrl: options.cdpUrl,
    log: options.log,
    timeoutMs: TAB_COMMAND_TIMEOUT_MS,
    onTradeFetchBody: (url, body) => {
      let listings: readonly LiveListing[];
      try {
        listings = parseFetchResponseBody(JSON.parse(body));
      } catch (error) {
        options.log(`browser-live: ignoring an unparsable fetch payload from ${url}: ${error instanceof Error ? error.message : String(error)}`);
        return;
      }
      if (listings.length === 0) return;
      if (!firstCaptureLogged) {
        firstCaptureLogged = true;
        options.log(`browser-live: capturing listings for ${options.search.searchId}`);
      }
      options.onListings(listings, now() < seedUntil ? 'seed' : 'live');
    },
    ...(options.onDisconnect === undefined ? {} : { onDisconnect: options.onDisconnect }),
  });
  try {
    await page.goto(liveSearchPageUrl(options.search));
  } catch (error) {
    await page.close();
    throw error;
  }
  seedUntil = now() + seedWindowMs;
  if (page.evaluate !== undefined) {
    const evaluate = page.evaluate.bind(page);
    void evaluate(kickstartSearchExpression())
      .then((outcome) => {
        seedUntil = Math.max(seedUntil, now() + KICKSTART_SEED_GRACE_MS);
        options.log(`browser-live: initial search for ${options.search.searchId}: ${String(outcome)}`);
      })
      .catch((error: unknown) => {
        options.log(`browser-live: could not kick off the initial search for ${options.search.searchId}: ${error instanceof Error ? error.message : String(error)}`);
      });
  }
  return { page, close: () => page.close() };
}
