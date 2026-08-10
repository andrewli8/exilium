import type { SnipeAlert } from './engine.js';

/** CSS selector for a trade-site result row (rows carry data-id=<listing>). */
export function rowSelector(listingId: string): string {
  return `[data-id="${listingId.replaceAll('\\', '\\\\').replaceAll('"', '\\"')}"]`;
}

/** The browser-page slice needed for one user-triggered travel action. */
export interface TravelPage {
  url(): string;
  goto(url: string): Promise<void>;
  clickTravelButton(listingId: string): Promise<boolean>;
}

export interface TravelResult {
  readonly action: 'traveled' | 'gone' | 'failed';
  readonly detail: string;
  readonly technicalDetail?: string;
}

/** One human-triggered travel action. Merely receiving an alert never calls
 * this function; the interactive console invokes it for the selected row on
 * Enter. It never sends, copies, or falls back to a whisper. */
export async function travelSelectedAlert(alert: SnipeAlert, page: TravelPage): Promise<TravelResult> {
  try {
    if (page.url() !== alert.searchUrl) await page.goto(alert.searchUrl);
    const clicked = await page.clickTravelButton(alert.listingId);
    if (!clicked) {
      return {
        action: 'gone',
        detail: `listing ${alert.listingId} was sold or removed`,
      };
    }
    return {
      action: 'traveled',
      detail: `clicked Travel to Hideout for ${alert.itemName}`,
    };
  } catch (error) {
    return { action: 'failed', detail: error instanceof Error ? error.message : String(error) };
  }
}
