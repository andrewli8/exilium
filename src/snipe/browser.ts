import type { SnipeAlert } from './engine.js';
import {
  rowSelector,
  travelSelectedAlert,
  type TravelPage,
  type TravelResult,
} from './travel.js';

/** Playwright adapter for manual, CLI-triggered travel. Two ways to get a page, in order of
 * preference:
 *
 *   1. Attach over CDP to a Chrome the USER launched with a debugging port
 *      (`exilium chrome`). That browser is a normal, human-driven Chrome —
 *      already logged in and already past Cloudflare — so the trade site
 *      treats it like any other tab. This is the reliable path.
 *   2. Launch a fresh persistent Playwright profile. Works, but a brand-new
 *      automation profile is what Cloudflare challenges, so the user has to
 *      clear one captcha the first time.
 *
 * Either way the adapter only clicks the trade site's own "Travel to
 * Hideout" button after an explicit console action. */

/** Verified against the live trade site (Allflame, 2026-08): result rows are
 * `.row[data-id="<listingId>"]` and the travel button is
 * `button.direct-btn` labeled "Travel to Hideout". A just-sniped listing
 * appears in the static search results; on price-sorted snipe searches an
 * underpriced hit sits on page one, and one reload-retry covers indexing lag. */
const ROW_TIMEOUT_MS = 6_000;
const TRAVEL_BUTTON = 'button.direct-btn';

export interface TravelBrowser {
  readonly page: TravelPage;
  close(): Promise<void>;
}

interface PlaywrightPage {
  url(): string;
  goto(url: string, opts: { waitUntil: 'domcontentloaded' }): Promise<unknown>;
  reload(opts: { waitUntil: 'domcontentloaded' }): Promise<unknown>;
  waitForSelector(selector: string, opts: { timeout: number }): Promise<unknown>;
  locator(selector: string): {
    count(): Promise<number>;
    first(): { click(opts: { timeout: number }): Promise<void> };
  };
  close(): Promise<void>;
}

interface PlaywrightContext {
  pages(): Array<PlaywrightPage>;
  newPage(): Promise<PlaywrightPage>;
  close(): Promise<void>;
}

interface PlaywrightBrowser {
  contexts(): Array<PlaywrightContext>;
  close(): Promise<void>;
}

interface PlaywrightLike {
  chromium: {
    launchPersistentContext(dir: string, opts: { headless: boolean; viewport: null; channel?: string }): Promise<PlaywrightContext>;
    connectOverCDP(url: string, opts?: { timeout?: number }): Promise<PlaywrightBrowser>;
  };
}

async function importPlaywright(): Promise<PlaywrightLike> {
  try {
    // Computed specifier: Playwright is an optional dev-install, and a
    // literal import would fail type-checking when it is absent.
    const moduleName = 'playwright';
    return (await import(moduleName)) as unknown as PlaywrightLike;
  } catch {
    throw new Error(
      'CLI-triggered travel needs Playwright, which is not installed. Run: npm i -D playwright.',
    );
  }
}

/** Build the TravelPage behaviour over any Playwright page. */
function travelPageFromPage(page: PlaywrightPage): TravelPage {
  const findRow = async (row: string): Promise<boolean> => {
    try {
      await page.waitForSelector(row, { timeout: ROW_TIMEOUT_MS });
      return true;
    } catch {
      return false;
    }
  };
  return {
    url: () => page.url(),
    goto: async (url: string) => {
      await page.goto(url, { waitUntil: 'domcontentloaded' });
    },
    clickTravelButton: async (listingId: string) => {
      const row = rowSelector(listingId);
      // One reload-retry: the listing can lag the search index by a beat.
      if (!(await findRow(row))) {
        await page.reload({ waitUntil: 'domcontentloaded' });
        if (!(await findRow(row))) return false;
      }
      const byClass = page.locator(`${row} ${TRAVEL_BUTTON}`);
      const button = (await byClass.count()) > 0 ? byClass : page.locator(`${row} button:has-text("Travel to Hideout")`);
      if ((await button.count()) === 0) return false;
      await button.first().click({ timeout: ROW_TIMEOUT_MS });
      return true;
    },
  };
}

export interface TravelBrowserOptions {
  /** CDP endpoint of a user-launched Chrome (e.g. http://127.0.0.1:9222).
   * Tried first; falls back to a fresh profile if nothing is listening. */
  readonly cdpUrl?: string | undefined;
  /** Persistent-profile directory for the fallback launch path. */
  readonly profileDir: string;
  readonly log: (message: string) => void;
}

async function attachOverCdp(playwright: PlaywrightLike, cdpUrl: string): Promise<TravelBrowser> {
  const browser = await playwright.chromium.connectOverCDP(cdpUrl, { timeout: 5_000 });
  const context = browser.contexts()[0];
  if (context === undefined) throw new Error('attached Chrome has no browser context');
  // A dedicated tab so the snipe never hijacks whatever the user is viewing.
  const page = await context.newPage();
  return {
    page: travelPageFromPage(page),
    close: async () => {
      await page.close().catch(() => undefined);
      // Disconnects the CDP session; the user's Chrome keeps running.
      await browser.close().catch(() => undefined);
    },
  };
}

async function launchPersistent(playwright: PlaywrightLike, profileDir: string, log: (m: string) => void): Promise<TravelBrowser> {
  let context: PlaywrightContext;
  try {
    context = await playwright.chromium.launchPersistentContext(profileDir, { headless: false, viewport: null, channel: 'chrome' });
  } catch {
    context = await playwright.chromium.launchPersistentContext(profileDir, { headless: false, viewport: null });
  }
  const page = context.pages()[0] ?? (await context.newPage());
  log('Travel browser opened with a fresh profile. Log into pathofexile.com in that window once; if a Cloudflare check appears, clear it once and the profile stays trusted.');
  return { page: travelPageFromPage(page), close: () => context.close() };
}

async function createTravelBrowserWith(playwright: PlaywrightLike, opts: TravelBrowserOptions): Promise<TravelBrowser> {
  if (opts.cdpUrl !== undefined && opts.cdpUrl !== '') {
    try {
      const attached = await attachOverCdp(playwright, opts.cdpUrl);
      opts.log(`Travel controller attached to your Chrome at ${opts.cdpUrl} — using your logged-in session.`);
      return attached;
    } catch (err) {
      opts.log(
        `Could not attach to Chrome at ${opts.cdpUrl} (${err instanceof Error ? err.message : String(err)}). ` +
          'Start one with `exilium chrome` for the reliable path — falling back to a fresh profile for now.',
      );
    }
  }
  return launchPersistent(playwright, opts.profileDir, opts.log);
}

export async function createTravelBrowser(opts: TravelBrowserOptions): Promise<TravelBrowser> {
  return createTravelBrowserWith(await importPlaywright(), opts);
}

export interface TravelController {
  /** Show an enabled Better Trading search without clicking any listing. */
  openSearch(url: string): Promise<void>;
  travel(alert: SnipeAlert): Promise<TravelResult>;
  close(): Promise<void>;
}

export interface TravelControllerOptions {
  readonly cdpUrl: string;
  readonly profileDir: string;
  readonly log: (message: string) => void;
  readonly loadPlaywright?: () => Promise<PlaywrightLike>;
}

/** One controller owns one page for its entire session. A promise tail
 * serializes Enter actions so a second navigation cannot race the first. */
export async function createTravelController(opts: TravelControllerOptions): Promise<TravelController> {
  const playwright = await (opts.loadPlaywright ?? importPlaywright)();
  const browser = await createTravelBrowserWith(playwright, {
    cdpUrl: opts.cdpUrl,
    profileDir: opts.profileDir,
    log: opts.log,
  });
  let tail: Promise<unknown> = Promise.resolve();
  let closePromise: Promise<void> | undefined;

  const enqueue = <T>(action: () => Promise<T>): Promise<T> => {
    const result = tail.then(action);
    tail = result.then(() => undefined, () => undefined);
    return result;
  };

  return {
    openSearch(url) {
      return enqueue(async () => {
        if (browser.page.url() !== url) await browser.page.goto(url);
      });
    },
    travel(alert) {
      return enqueue(() => travelSelectedAlert(alert, browser.page));
    },
    close() {
      closePromise ??= tail.then(() => browser.close());
      return closePromise;
    },
  };
}
