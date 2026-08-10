import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, test } from 'vitest';
import { TradeRateLimiter } from '../src/trade/rate-limit.js';
import { TradeRequestScheduler } from '../src/trade/request-scheduler.js';
import { loadStatIndex } from '../src/trade/trade-stats.js';

describe('loadStatIndex', () => {
  test('uses the shared scheduler gate before fetching stat data', async () => {
    let now = 0;
    const waits: number[] = [];
    const limiter = new TradeRateLimiter(() => now);
    limiter.observe(new Response('{}', { headers: {
      'X-Rate-Limit-Rules': 'Ip',
      'X-Rate-Limit-Ip': '1:2:60',
      'X-Rate-Limit-Ip-State': '1:2:0',
    } }));
    const scheduler = new TradeRequestScheduler({ limiter, wait: async (ms) => { waits.push(ms); now += ms; } });
    const cachePath = join(mkdtempSync(join(tmpdir(), 'exilium-stats-')), 'stats.json');

    await loadStatIndex('poe1', cachePath, async () => new Response(JSON.stringify({ result: [] })), 0, { scheduler });

    expect(waits).toEqual([1_000, 1_000]);
  });
});
