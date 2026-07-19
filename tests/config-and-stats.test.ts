import { homedir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, test, vi } from 'vitest';
import { loadConfig } from '../src/config.js';
import { mean, stddev, volumeConfidence } from '../src/signals/stats.js';
import { NinjaClient } from '../src/sources/ninja/client.js';

describe('loadConfig', () => {
  test('applies defaults when env is empty', () => {
    const c = loadConfig({});
    expect(c.dbPath).toBe(join(homedir(), '.exilium', 'exilium.db'));
    expect(c.league).toBeNull();
    expect(c.dashboardPort).toBe(4321);
    expect(c.userAgent).toContain('github.com/andrewli8/exilium');
    expect(c.userAgent).not.toContain('contact:');
    expect(c.game).toBe('poe1');
    expect(c.categories).toContain('Currency');
    expect(c.categories).toContain('Scarab');
    expect(c.categories).toContain('DivinationCard');
    expect(c.watchIntervalSec).toBe(600);
    expect(c.minEdgePct).toBe(25);
    expect(c.webhookUrl).toBeUndefined();
  });

  test('EXILIUM_REFRESH sets the auto-refresh cadence with a 300s floor', () => {
    expect(loadConfig({}).refreshSec).toBe(300);
    expect(loadConfig({ EXILIUM_REFRESH: '60' }).refreshSec).toBe(300);
    expect(loadConfig({ EXILIUM_REFRESH: '900' }).refreshSec).toBe(900);
  });

  test('enforces a 300s floor on the watch interval (poe.ninja politeness)', () => {
    expect(loadConfig({ EXILIUM_WATCH_INTERVAL: '60' }).watchIntervalSec).toBe(300);
    expect(loadConfig({ EXILIUM_WATCH_INTERVAL: '900' }).watchIntervalSec).toBe(900);
  });

  test('honors env overrides', () => {
    const c = loadConfig({
      EXILIUM_DB: '/tmp/x.db',
      EXILIUM_CONTACT: 'me@example.com',
      EXILIUM_LEAGUE: 'Standard',
      EXILIUM_PORT: '9999',
      EXILIUM_GAME: 'poe2',
      EXILIUM_MIN_EDGE: '50',
      EXILIUM_WEBHOOK: 'https://discord.example/hook',
    });
    expect(c.dbPath).toBe('/tmp/x.db');
    expect(c.userAgent).toContain('me@example.com');
    expect(c.league).toBe('Standard');
    expect(c.dashboardPort).toBe(9999);
    expect(c.game).toBe('poe2');
    expect(c.categories.length).toBeGreaterThan(1);
    expect(c.minEdgePct).toBe(50);
    expect(c.webhookUrl).toBe('https://discord.example/hook');
  });
});

describe('stats edge cases', () => {
  test('mean of empty series is 0', () => {
    expect(mean([])).toBe(0);
  });

  test('stddev of short series is 0', () => {
    expect(stddev([])).toBe(0);
    expect(stddev([5])).toBe(0);
  });

  test('volumeConfidence clamps negatives to 0 and saturates at 1', () => {
    expect(volumeConfidence(-10)).toBe(0);
    expect(volumeConfidence(10 ** 9)).toBe(1);
  });
});

describe('NinjaClient defaults', () => {
  test('uses the poe.ninja base URL by default', async () => {
    const fetchFn = vi.fn().mockResolvedValue(new Response('[]', { status: 200 }));
    const client = new NinjaClient({ fetchFn, userAgent: 'ua' });
    await client.getLeagues('poe1');
    expect(String(fetchFn.mock.calls[0]![0])).toMatch(/^https:\/\/poe\.ninja\//);
  });

  test('rejects leagues payloads with unexpected shape', async () => {
    const fetchFn = vi.fn().mockResolvedValue(new Response('{"weird":1}', { status: 200 }));
    const client = new NinjaClient({ fetchFn, userAgent: 'ua' });
    await expect(client.getLeagues('poe1')).rejects.toThrow(/shape/i);
  });
});
