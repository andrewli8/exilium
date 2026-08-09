import { describe, expect, test } from 'vitest';
import { DEFAULT_CDP_PORT, parseCdpPort, resolveChromeLaunch } from '../src/snipe/chrome.js';

describe('parseCdpPort', () => {
  test('defaults to the Exilium CDP port and accepts a valid integer', () => {
    expect(parseCdpPort(undefined)).toBe(DEFAULT_CDP_PORT);
    expect(parseCdpPort('9333')).toBe(9333);
  });

  test.each(['0', '-1', '65536', 'abc', '9222.5'])(
    'rejects invalid CDP port %s',
    (raw) => expect(() => parseCdpPort(raw)).toThrow(/CDP port/),
  );
});

describe('resolveChromeLaunch', () => {
  test('uses Local App Data Chrome when Program Files copies do not exist', () => {
    const local = 'C:\\Users\\me\\AppData\\Local';
    const expected = `${local}\\Google\\Chrome\\Application\\chrome.exe`;
    const launch = resolveChromeLaunch({
      platform: 'win32',
      env: { PROGRAMFILES: 'C:\\Program Files', LOCALAPPDATA: local },
      port: 9222,
      exists: (path) => path === expected,
    });
    expect(launch.cmd).toBe(expected);
    expect(launch.args).toContain(`--user-data-dir=${local}\\Exilium\\chrome-profile`);
  });

  test('checks Program Files x86 before falling back to Edge', () => {
    const chromeX86 = 'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe';
    const edge = 'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe';
    const launch = resolveChromeLaunch({
      platform: 'win32',
      env: {
        PROGRAMFILES: 'C:\\Program Files',
        'PROGRAMFILES(X86)': 'C:\\Program Files (x86)',
        LOCALAPPDATA: 'C:\\Users\\me\\AppData\\Local',
      },
      port: 9222,
      exists: (path) => path === chromeX86 || path === edge,
    });
    expect(launch.cmd).toBe(chromeX86);
  });

  test('uses Edge only when no Chrome candidate exists', () => {
    const edge = 'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe';
    const launch = resolveChromeLaunch({
      platform: 'win32',
      env: { PROGRAMFILES: 'C:\\Program Files' },
      port: 9222,
      exists: (path) => path === edge,
    });
    expect(launch.cmd).toBe(edge);
  });

  test('environment override wins over a saved executable path', () => {
    const launch = resolveChromeLaunch({
      platform: 'win32',
      env: { EXILIUM_CHROME: 'D:\\env-chrome.exe' },
      configuredPath: 'D:\\saved-chrome.exe',
      profileDir: 'D:\\profile',
      port: 9333,
      exists: () => true,
    });
    expect(launch.cmd).toBe('D:\\env-chrome.exe');
    expect(launch.args).toEqual([
      '--remote-debugging-port=9333',
      '--user-data-dir=D:\\profile',
      'https://www.pathofexile.com/trade',
    ]);
  });

  test('keeps macOS and Linux launch defaults', () => {
    expect(resolveChromeLaunch({ platform: 'darwin', env: {}, port: 9222 }).cmd).toContain('Google Chrome.app');
    expect(resolveChromeLaunch({ platform: 'linux', env: {}, port: 9222 }).cmd).toBe('google-chrome');
  });
});
