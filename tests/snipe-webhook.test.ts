import { describe, expect, test, vi } from 'vitest';
import type { SnipeAlert } from '../src/snipe/engine.js';
import { buildSnipeWebhookPayload, postSnipeWebhook } from '../src/snipe/webhook.js';

const ALERT: SnipeAlert = {
  targetLabel: 'MB',
  listingId: 'abc123',
  itemName: 'Mageblood Heavy Belt',
  priceText: '150 divine',
  seller: 'Seller',
  whisper: '@Seller hi',
  searchUrl: 'https://www.pathofexile.com/trade/search/Allflame/AbC123',
  listedChaos: 30_000,
  marginChaos: 10_000,
  marginPct: 25,
  marginText: '+10,000c (+25.0%)',
  freshnessText: 'ref 4m ago',
  stale: false,
  unknownMargin: false,
};

describe('buildSnipeWebhookPayload', () => {
  test('carries everything an external actuator needs to act on the listing', () => {
    const payload = buildSnipeWebhookPayload(ALERT, 'ping', 'whisper copied', '2026-08-09T12:00:00Z');
    expect(payload).toMatchObject({
      event: 'snipe',
      ts: '2026-08-09T12:00:00Z',
      listingId: 'abc123',
      searchUrl: ALERT.searchUrl,
      whisper: ALERT.whisper,
      marginPct: 25,
      action: 'ping',
      detail: 'whisper copied',
    });
  });
});

describe('postSnipeWebhook', () => {
  const payload = buildSnipeWebhookPayload(ALERT, 'ping', 'd', 'ts');

  test('POSTs JSON to the configured URL', async () => {
    const fetchFn = vi.fn().mockResolvedValue(new Response('ok', { status: 200 }));
    const log = vi.fn();
    await postSnipeWebhook('https://hooks.example/snipe', payload, fetchFn, log);
    expect(fetchFn).toHaveBeenCalledWith('https://hooks.example/snipe', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(payload),
    });
    expect(log).not.toHaveBeenCalled();
  });

  test('failures are logged, never thrown — a dead webhook must not kill the session', async () => {
    const log = vi.fn();
    await postSnipeWebhook('https://hooks.example/snipe', payload, vi.fn().mockResolvedValue(new Response('no', { status: 500 })), log);
    expect(String(log.mock.calls[0]![0])).toContain('500');
    await postSnipeWebhook('https://hooks.example/snipe', payload, vi.fn().mockRejectedValue(new Error('offline')), log);
    expect(String(log.mock.calls[1]![0])).toContain('offline');
  });
});
