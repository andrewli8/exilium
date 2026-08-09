import type { SnipeAlert } from './engine.js';

/** Structured JSON webhook fired per snipe alert (EXILIUM_SNIPE_WEBHOOK /
 * snipe.webhookUrl). It carries click-flow identifiers and margin/status
 * data, but deliberately excludes the seller whisper. */

export interface SnipeWebhookPayload extends SnipeAlert {
  readonly event: 'snipe';
  readonly ts: string;
  readonly action: string;
  readonly detail: string;
}

export function buildSnipeWebhookPayload(alert: SnipeAlert, action: string, detail: string, ts: string): SnipeWebhookPayload {
  return { event: 'snipe', ts, ...alert, action, detail };
}

export type WebhookFetchFn = (
  url: string,
  init: { method: string; headers: Record<string, string>; body: string },
) => Promise<Response>;

export async function postSnipeWebhook(
  url: string,
  payload: SnipeWebhookPayload,
  fetchFn: WebhookFetchFn,
  log: (message: string) => void,
): Promise<void> {
  try {
    const res = await fetchFn(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(payload),
    });
    if (!res.ok) log(`snipe webhook returned ${res.status}`);
  } catch (err) {
    log(`snipe webhook failed: ${err instanceof Error ? err.message : String(err)}`);
  }
}
