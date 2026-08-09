import { rowSelector, type TravelPage } from './travel.js';

/** Playwright adapter for auto-travel: a persistent, headed browser profile
 * the user logs into pathofexile.com once. Playwright is a dev-install, not
 * a shipped dependency — ping-only users never pay for it. The adapter
 * clicks the trade site's own "Travel to Hideout" button, once per alert. */

/** Verified against the live trade site (Allflame, 2026-08): result rows are
 * `.row[data-id="<listingId>"]` and the travel button is
 * `button.direct-btn` labeled "Travel to Hideout" (the site's directWhisper
 * flow). A just-sniped listing appears in the static search results; on
 * price-sorted snipe searches an underpriced hit sits on page one, and one
 * reload-retry covers indexing lag. */
const ROW_TIMEOUT_MS = 6_000;
const TRAVEL_BUTTON = 'button.direct-btn';

export interface TravelBrowser {
  readonly page: TravelPage;
  close(): Promise<void>;
}

interface PlaywrightLike {
  chromium: {
    launchPersistentContext(
      dir: string,
      opts: { headless: boolean; viewport: null; channel?: string },
    ): Promise<{
      pages(): Array<PlaywrightPage>;
      newPage(): Promise<PlaywrightPage>;
      close(): Promise<void>;
    }>;
  };
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
}

type PersistentContext = Awaited<ReturnType<PlaywrightLike['chromium']['launchPersistentContext']>>;

/** Prefer the user's installed Chrome (no `npx playwright install` needed —
 * the common case on Windows); fall back to Playwright's bundled Chromium. */
async function launchContext(playwright: PlaywrightLike, profileDir: string): Promise<PersistentContext> {
  try {
    return await playwright.chromium.launchPersistentContext(profileDir, { headless: false, viewport: null, channel: 'chrome' });
  } catch {
    return playwright.chromium.launchPersistentContext(profileDir, { headless: false, viewport: null });
  }
}

export async function createTravelBrowser(profileDir: string, log: (message: string) => void): Promise<TravelBrowser> {
  let playwright: PlaywrightLike;
  try {
    // Computed specifier: Playwright is an optional dev-install, and a
    // literal import would fail type-checking when it is absent.
    const moduleName = 'playwright';
    playwright = (await import(moduleName)) as unknown as PlaywrightLike;
  } catch {
    throw new Error(
      'Auto-travel needs Playwright, which is not installed. Run: npm i -D playwright && npx playwright install chromium — or drop --auto-travel to stay ping-only.',
    );
  }
  const context = await launchContext(playwright, profileDir);
  const page = context.pages()[0] ?? (await context.newPage());
  log('Auto-travel browser is open. Log into pathofexile.com in that window once; the session persists in the profile.');

  const findRow = async (row: string): Promise<boolean> => {
    try {
      await page.waitForSelector(row, { timeout: ROW_TIMEOUT_MS });
      return true;
    } catch {
      return false;
    }
  };

  const travelPage: TravelPage = {
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
  return { page: travelPage, close: () => context.close() };
}
