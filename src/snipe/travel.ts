import type { SnipeAlert } from './engine.js';

/** The response to a snipe alert.
 *
 * `ping` (default, recommended): notify + whisper on the clipboard; the human
 * clicks the trade site's own "Travel to Hideout" button.
 *
 * `auto` (double-gated opt-in): a locally driven, logged-in browser clicks
 * that button once per alert. This performs a server action without a direct
 * human click — the automation line GGG draws and Exilium otherwise refuses
 * to cross. It exists only behind BOTH a per-run `--auto-travel` flag and a
 * standing `snipe.autoTravelAcknowledged: true` in the config file, and every
 * run repeats the warning. Account risk is the operator's. */

export type TravelMode = 'ping' | 'auto';

export interface ResolveTravelModeInput {
  /** --mode flag value, verbatim. */
  readonly modeFlag: string | undefined;
  /** --auto-travel flag presence. */
  readonly autoTravelFlag: boolean;
  /** snipe.mode from config file or EXILIUM_SNIPE_MODE. */
  readonly configuredMode: string | undefined;
  /** snipe.autoTravelAcknowledged from the config file. */
  readonly acknowledged: boolean;
}

export interface ResolvedTravelMode {
  readonly mode: TravelMode;
  readonly warning?: string;
}

const AUTO_WARNING =
  'AUTO-TRAVEL IS ON: Exilium will click "Travel to Hideout" for qualifying snipes. ' +
  'That is an automated server action — outside the one-action-per-click line GGG holds tools to — and it can risk your account. ' +
  'You enabled this explicitly; remove --auto-travel (or snipe.autoTravelAcknowledged) to go back to ping-only.';

export function resolveTravelMode(input: ResolveTravelModeInput): ResolvedTravelMode {
  const flagMode = input.modeFlag ?? (input.autoTravelFlag ? 'auto' : undefined);
  const requested = flagMode ?? input.configuredMode ?? 'ping';
  if (requested !== 'ping' && requested !== 'auto') {
    throw new Error(`--mode must be "ping" or "auto", got "${requested}"`);
  }
  if (requested === 'ping') return { mode: 'ping' };
  // Auto from config/env alone (an inherited shell variable, say) never
  // crashes the session — it downgrades. Only an explicit per-run flag can
  // reach the acknowledgment gate.
  if (flagMode !== 'auto') {
    return {
      mode: 'ping',
      warning: 'snipe.mode is "auto" in config/env, but auto-travel also needs --auto-travel on the command line each run — staying ping-only.',
    };
  }
  if (!input.acknowledged) {
    throw new Error(
      'Auto-travel needs a standing acknowledgment: set "snipe": { "autoTravelAcknowledged": true } in ~/.exilium/config.json. ' +
        'Understand what you are enabling first — it clicks a trade-site button for you, which is automation GGG can act on. Ping-only needs nothing.',
    );
  }
  return { mode: 'auto', warning: AUTO_WARNING };
}

/** CSS selector for a trade-site result row (rows carry data-id=<listing>). */
export function rowSelector(listingId: string): string {
  return `[data-id="${listingId.replaceAll('\\', '\\\\').replaceAll('"', '\\"')}"]`;
}

/** The slice of a browser page the dispatcher needs (adapter over
 * Playwright; faked in tests). */
export interface TravelPage {
  url(): string;
  goto(url: string): Promise<void>;
  /** Click the row's "Travel to Hideout" button; false when absent. */
  clickTravelButton(listingId: string): Promise<boolean>;
}

export interface DispatchTravelOptions {
  readonly mode: TravelMode;
  /** Ping mode: also open the search page in the default browser. */
  readonly openSearchPage: boolean;
  readonly openUrl: (url: string) => Promise<void>;
  /** Auto mode's logged-in page; absent when the browser is not running. */
  readonly page?: TravelPage;
}

export interface TravelResult {
  readonly action: 'ping' | 'auto-traveled' | 'auto-failed' | 'traveled' | 'failed';
  readonly detail: string;
}

const PING_DETAIL = 'whisper copied — paste in game, or click Travel to Hideout on the trade site yourself';

export async function dispatchTravel(alert: SnipeAlert, opts: DispatchTravelOptions): Promise<TravelResult> {
  if (opts.mode === 'ping') {
    if (opts.openSearchPage) {
      try {
        await opts.openUrl(alert.searchUrl);
      } catch {
        // Opening a browser is convenience, never a reason to miss a snipe.
      }
    }
    return { action: 'ping', detail: PING_DETAIL };
  }

  if (opts.page === undefined) {
    return { action: 'auto-failed', detail: `no logged-in browser page available — ${PING_DETAIL}` };
  }
  try {
    if (opts.page.url() !== alert.searchUrl) await opts.page.goto(alert.searchUrl);
    const clicked = await opts.page.clickTravelButton(alert.listingId);
    if (!clicked) {
      return { action: 'auto-failed', detail: `Travel to Hideout button not found for ${alert.listingId} (listing gone or not instant-buyout) — ${PING_DETAIL}` };
    }
    return { action: 'auto-traveled', detail: `clicked Travel to Hideout for ${alert.itemName} — you should be loading into the seller's hideout` };
  } catch (err) {
    return { action: 'auto-failed', detail: `${err instanceof Error ? err.message : String(err)} — ${PING_DETAIL}` };
  }
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
        action: 'failed',
        detail: `Travel to Hideout button not found for listing ${alert.listingId}`,
      };
    }
    return {
      action: 'traveled',
      detail: `clicked Travel to Hideout for ${alert.itemName}`,
    };
  } catch (err) {
    return { action: 'failed', detail: err instanceof Error ? err.message : String(err) };
  }
}
