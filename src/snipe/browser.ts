import type { SnipeAlert } from './engine.js';
import {
  createCdpPage,
  type CdpTravelPage,
  type CreateCdpPageOptions,
} from './cdp.js';
import { travelSelectedAlert, type TravelResult } from './travel.js';

export interface TravelController {
  /** Show an enabled Better Trading search without clicking any listing. */
  openSearch(url: string): Promise<void>;
  travel(alert: SnipeAlert): Promise<TravelResult>;
  close(): Promise<void>;
}

export interface TravelControllerOptions {
  readonly cdpUrl: string;
  /** Retained for config compatibility; direct CDP always uses `exilium chrome`. */
  readonly profileDir: string;
  readonly log: (message: string) => void;
  readonly createPage?: (options: CreateCdpPageOptions) => Promise<CdpTravelPage>;
}

/**
 * Own one native Chrome trade tab for the session. Direct page-target CDP
 * deliberately avoids Playwright browser-context initialization (including
 * Browser.setDownloadBehavior), which newer Chrome debugging endpoints may
 * reject. A promise tail serializes explicit Enter actions; close bypasses
 * that tail so a stalled navigation cannot hang q/Ctrl+C.
 */
export async function createTravelController(options: TravelControllerOptions): Promise<TravelController> {
  const page = await (options.createPage ?? createCdpPage)({
    cdpUrl: options.cdpUrl,
    log: options.log,
  });
  let tail: Promise<unknown> = Promise.resolve();
  let closePromise: Promise<void> | undefined;
  let closed = false;

  const enqueue = <T>(action: () => Promise<T>): Promise<T> => {
    if (closed) return Promise.reject(new Error('Chrome travel controller is closed'));
    const result = tail.then(action);
    tail = result.then(() => undefined, () => undefined);
    return result;
  };

  return {
    openSearch(url) {
      return enqueue(async () => {
        if (page.url() !== url) await page.goto(url);
      });
    },
    travel(alert) {
      return enqueue(() => travelSelectedAlert(alert, page));
    },
    close() {
      if (closePromise === undefined) {
        closed = true;
        closePromise = page.close();
      }
      return closePromise;
    },
  };
}
