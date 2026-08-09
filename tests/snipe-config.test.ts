import { describe, expect, test } from 'vitest';
import { loadConfig } from '../src/config.js';

describe('snipe settings', () => {
  test('defaults: no folder, no threshold, ping-ish, no standing consent', () => {
    expect(loadConfig({}).snipe).toEqual({
      folder: undefined,
      minMarginPct: null,
      mode: undefined,
      sound: false,
      autoTravelAcknowledged: false,
    });
  });

  test('file values load and env overrides win', () => {
    const file = { snipe: { folder: '/from-file', minMarginPct: 15, mode: 'ping', sound: true } };
    expect(loadConfig({}, file).snipe).toMatchObject({ folder: '/from-file', minMarginPct: 15, sound: true });
    const env = { EXILIUM_BETTERTRADING: '/from-env', EXILIUM_SNIPE_MIN_MARGIN: '30', EXILIUM_SNIPE_MODE: 'auto', EXILIUM_SNIPE_SOUND: '0' };
    expect(loadConfig(env, file).snipe).toMatchObject({ folder: '/from-env', minMarginPct: 30, mode: 'auto', sound: false });
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
