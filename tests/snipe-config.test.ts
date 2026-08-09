import { describe, expect, test } from 'vitest';
import { loadConfig } from '../src/config.js';

describe('snipe settings', () => {
  test('defaults: no folder, no threshold, ping-ish, no standing consent', () => {
    expect(loadConfig({}).snipe).toEqual({
      folder: undefined,
      minMarginPct: null,
      mode: undefined,
      sound: false,
      webhookUrl: undefined,
      league: undefined,
      chromeCdpUrl: 'http://127.0.0.1:9222',
      chromePath: undefined,
      chromeProfile: undefined,
      autoTravelAcknowledged: false,
    });
  });

  test('loads saved snipe Chrome and league settings without persisting a selection', () => {
    const config = loadConfig({}, {
      snipe: {
        league: 'Current',
        chromeCdpUrl: 'http://127.0.0.1:9333',
        chromePath: 'C:\\Portable\\chrome.exe',
        chromeProfile: 'C:\\ExiliumProfile',
      },
    });
    expect(config.snipe).toMatchObject({
      league: 'Current',
      chromeCdpUrl: 'http://127.0.0.1:9333',
      chromePath: 'C:\\Portable\\chrome.exe',
      chromeProfile: 'C:\\ExiliumProfile',
    });
    expect(config.snipe).not.toHaveProperty('selectedSearchIds');
  });

  test('file values load and env overrides win', () => {
    const file = { snipe: { folder: '/from-file', minMarginPct: 15, mode: 'ping', sound: true, webhookUrl: 'https://file.example/hook' } };
    expect(loadConfig({}, file).snipe).toMatchObject({ folder: '/from-file', minMarginPct: 15, sound: true, webhookUrl: 'https://file.example/hook' });
    const env = { EXILIUM_BETTERTRADING: '/from-env', EXILIUM_SNIPE_MIN_MARGIN: '30', EXILIUM_SNIPE_MODE: 'auto', EXILIUM_SNIPE_SOUND: '0', EXILIUM_SNIPE_WEBHOOK: 'https://env.example/hook', EXILIUM_CHROME_CDP: 'http://127.0.0.1:9333' };
    expect(loadConfig(env, file).snipe).toMatchObject({ folder: '/from-env', minMarginPct: 30, mode: 'auto', sound: false, webhookUrl: 'https://env.example/hook', chromeCdpUrl: 'http://127.0.0.1:9333' });
  });

  test('auto-travel consent comes only from the config file, never the environment', () => {
    const config = loadConfig({ EXILIUM_SNIPE_AUTO_TRAVEL: '1' } as NodeJS.ProcessEnv, { snipe: {} });
    expect(config.snipe.autoTravelAcknowledged).toBe(false);
    expect(loadConfig({}, { snipe: { autoTravelAcknowledged: true } }).snipe.autoTravelAcknowledged).toBe(true);
  });

  test('an empty folder env var falls through to the file value', () => {
    expect(loadConfig({ EXILIUM_BETTERTRADING: '' }, { snipe: { folder: '/from-file' } }).snipe.folder).toBe('/from-file');
  });

  test('a non-numeric margin env var fails fast', () => {
    expect(() => loadConfig({ EXILIUM_SNIPE_MIN_MARGIN: 'lots' })).toThrow(/EXILIUM_SNIPE_MIN_MARGIN/);
  });
});
