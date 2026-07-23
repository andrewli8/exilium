import { describe, expect, test } from 'vitest';
import { TradeRateLimiter, RateLimitError } from '../src/trade/rate-limit.js';

/** GGG returns rate-limit policy + state headers on every trade-API response.
 * Format per rule: "hits:period:restrictSeconds", comma-separated sets.
 *   X-Rate-Limit-Ip:        8:10:60         (allow 8 per 10s; 60s timeout if broken)
 *   X-Rate-Limit-Ip-State:  8:10:0          (8 used in the current 10s window)
 * A good client backs off BEFORE the 429, and honors Retry-After after one. */
function res(status: number, headers: Record<string, string>): { status: number; headers: { get(n: string): string | null } } {
  const lower = new Map(Object.entries(headers).map(([k, v]) => [k.toLowerCase(), v]));
  return { status, headers: { get: (n: string) => lower.get(n.toLowerCase()) ?? null } };
}

describe('TradeRateLimiter', () => {
  test('a fresh limiter lets the first request through', () => {
    const rl = new TradeRateLimiter(() => 0);
    expect(() => rl.gate()).not.toThrow();
  });

  test('honors Retry-After on a 429', () => {
    let now = 0;
    const rl = new TradeRateLimiter(() => now);
    rl.observe(res(429, { 'Retry-After': '12' }));
    expect(() => rl.gate()).toThrow(RateLimitError);
    try { rl.gate(); } catch (e) { expect((e as RateLimitError).retryAfterSec).toBe(12); }
    now = 12_000;
    expect(() => rl.gate()).not.toThrow();
    expect(rl.health().total429s).toBe(1);
  });

  test('backs off proactively when a bucket is full, before any 429', () => {
    const rl = new TradeRateLimiter(() => 0);
    // 8 of 8 used in the 10s window -> the next call would 429, so wait ~10s.
    rl.observe(res(200, { 'X-Rate-Limit-Rules': 'Ip', 'X-Rate-Limit-Ip': '8:10:60', 'X-Rate-Limit-Ip-State': '8:10:0' }));
    expect(() => rl.gate()).toThrow(RateLimitError);
  });

  test('healthy usage does not trip the gate', () => {
    const rl = new TradeRateLimiter(() => 0);
    rl.observe(res(200, { 'X-Rate-Limit-Rules': 'Ip,Account', 'X-Rate-Limit-Ip': '8:10:60', 'X-Rate-Limit-Ip-State': '2:10:0', 'X-Rate-Limit-Account': '15:60:120', 'X-Rate-Limit-Account-State': '3:60:0' }));
    expect(() => rl.gate()).not.toThrow();
  });

  test('honors an active restriction reported in the state header', () => {
    let now = 0;
    const rl = new TradeRateLimiter(() => now);
    rl.observe(res(200, { 'X-Rate-Limit-Rules': 'Ip', 'X-Rate-Limit-Ip': '8:10:60', 'X-Rate-Limit-Ip-State': '9:10:55' }));
    expect(() => rl.gate()).toThrow(RateLimitError);
    now = 55_000;
    expect(() => rl.gate()).not.toThrow();
  });

  test('takes the most restrictive bucket across rules', () => {
    const rl = new TradeRateLimiter(() => 0);
    rl.observe(res(200, { 'X-Rate-Limit-Rules': 'Ip,Account', 'X-Rate-Limit-Ip': '8:10:60', 'X-Rate-Limit-Ip-State': '2:10:0', 'X-Rate-Limit-Account': '15:60:120', 'X-Rate-Limit-Account-State': '15:60:0' }));
    expect(() => rl.gate()).toThrow(RateLimitError);
  });
});
