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
  /** Called with the owned page as soon as it exists (before navigation), so
   * hosts can use it for page-world work (e.g. reward floor lookups) while
   * the seed captures are still streaming in. */
  readonly onPage?: (page: CdpTravelPage) => void;
  /** Fired the instant the live stream announces new listings — before the
   * page fetches their details. Carries the number of incoming ids. */
  readonly onLiveFrame?: (newCount: number) => void;
  /** Fired once this tab's plain-page search has seeded (or its wait
   * elapsed) — its budgeted search POST is done, so the NEXT tab may start
   * while this one finishes settling and switching to /live. */
  readonly onSeeded?: () => void;
  /** Captures within this window after the tab reaches /live are still
   * treated as current results (seed), not fresh live hits. Default 10s. */
  readonly seedWindowMs?: number;
  /** How long to wait on the plain search page for current results before
   * switching to /live. Default 10s; tests shorten it. */
  readonly seedCaptureWaitMs?: number;
  /** Grace between the first seed capture and the /live navigation.
   * Default 4s; tests shorten it. */
  readonly seedSettleMs?: number;
  readonly createPage?: (options: CreateCdpPageOptions) => Promise<CdpTravelPage>;
  readonly now?: () => number;
}

export interface BrowserLiveSearchHandle {
  /** The owned tab, already showing this search's live page. Travel can click
   * a row here directly instead of navigating a separate tab. */
  readonly page: CdpTravelPage;
  close(): Promise<void>;
}

/** Captures within this window after the tab reaches /live may still be the
 * initial current-result fetches — classify them as seed, not live hits. */
const DEFAULT_SEED_WINDOW_MS = 10_000;
/** Tab CDP command budget. The trade site is heavy and several tabs open at
 * once; the default 6s regularly expired mid-load and detached capture. */
const TAB_COMMAND_TIMEOUT_MS = 20_000;
/** How long to wait on the plain search page for its auto-run search to
 * deliver current results before switching the tab to /live. Quiet searches
 * always pay the full wait, and the startup ramp multiplies it by the tab
 * count — keep it as tight as the page's search+fetch round trip allows. */
const SEED_CAPTURE_WAIT_MS = 6_000;
/** Grace after the first capture before navigating to /live: later fetch
 * batches finish arriving, and page-world work started against the plain
 * page (reward floor lookups) is not yanked mid-flight by the navigation. */
const SEED_SETTLE_MS = 4_000;

export function liveSearchPageUrl(search: TradeSearch): string {
  return `${buildSearchPageUrl({ realm: search.realm, searchId: search.searchId }, search.league)}/live`;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Reconciliation sweep script: reports the row ids the tab currently shows
 * and whether the live search has silently deactivated (the site drops live
 * connections quietly — the button relabels to "Activate Live Search").
 * If deactivated, it clicks the button to revive the stream. */
export function reconcileExpression(): string {
  return `(() => {
    const ids = Array.from(document.querySelectorAll('[data-id]'))
      .map((element) => element.getAttribute('data-id'))
      .filter((id) => typeof id === 'string' && id !== '')
      .slice(0, 50);
    const reviveButton = Array.from(document.querySelectorAll('button'))
      .find((element) => element instanceof HTMLButtonElement && !element.disabled
        // Anchored: "Activate Live Search" only — a substring match would
        // also hit "Deactivate Live Search" and switch a HEALTHY stream off.
        && /^activate live search$/i.test((element.textContent || '').trim()));
    const deactivated = reviveButton !== undefined;
    if (reviveButton) reviveButton.click();
    return { ids, deactivated };
  })()`;
}

/** Fetch details for listing ids the sweep found on the page but the CLI
 * never processed — one page-session request, same as the page's own. */
export function recoverDetailsExpression(searchId: string, ids: readonly string[]): string {
  const url = `https://www.pathofexile.com/api/trade/fetch/${ids.join(',')}?query=${searchId}`;
  return `(async () => {
    try {
      const res = await fetch(${JSON.stringify(url)}, { credentials: 'include' });
      if (!res.ok) return null;
      return await res.text();
    } catch {
      return null;
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
  // Everything captured before the tab reaches /live is a current result.
  let seedUntil = Number.POSITIVE_INFINITY;
  let firstCaptureLogged = false;
  let signalFirstCapture: () => void = () => undefined;
  const firstCapture = new Promise<void>((resolve) => { signalFirstCapture = resolve; });
  const page = await (options.createPage ?? createCdpPage)({
    cdpUrl: options.cdpUrl,
    log: options.log,
    timeoutMs: TAB_COMMAND_TIMEOUT_MS,
    onTradeFetchBody: (url, body) => {
      let listings: readonly LiveListing[];
      try {
        listings = parseFetchResponseBody(JSON.parse(body), (message) => options.log(`browser-live: ${message}`));
      } catch (error) {
        options.log(`browser-live: ignoring an unparsable fetch payload (${error instanceof Error ? error.message : String(error)}) — body: ${body.slice(0, 200)}`);
        return;
      }
      signalFirstCapture();
      if (listings.length === 0) return;
      if (!firstCaptureLogged) {
        firstCaptureLogged = true;
        options.log(`browser-live: capturing listings for ${options.search.searchId}`);
      }
      options.onListings(listings, now() < seedUntil ? 'seed' : 'live');
    },
    ...(options.onDisconnect === undefined ? {} : { onDisconnect: options.onDisconnect }),
    ...(options.onLiveFrame === undefined ? {} : {
      onWebSocketFrame: (payload: string) => {
        try {
          const frame = JSON.parse(payload) as { new?: unknown };
          if (Array.isArray(frame.new) && frame.new.length > 0) options.onLiveFrame!(frame.new.length);
        } catch {
          // Not every frame is the {new: [...]} shape — ignore the rest.
        }
      },
    }),
  });
  options.onPage?.(page);
  try {
    // The /live page never loads the search's current results on its own
    // (verified against the live site) — but the plain search page auto-runs
    // the search on load. Open plain first so current results stream through
    // the capture as seeds, then switch the same tab to /live for the stream.
    await page.goto(buildSearchPageUrl({ realm: options.search.realm, searchId: options.search.searchId }, options.search.league));
    await Promise.race([firstCapture, sleep(options.seedCaptureWaitMs ?? SEED_CAPTURE_WAIT_MS)]);
    options.onSeeded?.();
    await sleep(options.seedSettleMs ?? SEED_SETTLE_MS);
    await page.goto(liveSearchPageUrl(options.search));
  } catch (error) {
    await page.close();
    throw error;
  }
  seedUntil = now() + seedWindowMs;
  return { page, close: () => page.close() };
}
