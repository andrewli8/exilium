import { describe, expect, test, vi } from 'vitest';
import { clipboardCommand, openCommand, copyToClipboard, openUrl } from '../src/platform.js';

describe('clipboardCommand', () => {
  test('per-platform clipboard tools, including Windows clip', () => {
    expect(clipboardCommand('darwin')).toEqual({ cmd: 'pbcopy', args: [] });
    expect(clipboardCommand('win32')).toEqual({ cmd: 'clip', args: [] });
    expect(clipboardCommand('linux')).toEqual({ cmd: 'xclip', args: ['-selection', 'clipboard'] });
  });
});

describe('openCommand', () => {
  test('Windows uses cmd /c start with an empty title arg, not the start builtin directly', () => {
    expect(openCommand('win32', 'https://x')).toEqual({ cmd: 'cmd', args: ['/c', 'start', '', 'https://x'] });
    expect(openCommand('darwin', 'https://x')).toEqual({ cmd: 'open', args: ['https://x'] });
    expect(openCommand('linux', 'https://x')).toEqual({ cmd: 'xdg-open', args: ['https://x'] });
  });
});

describe('copyToClipboard', () => {
  test('writes the text to the platform tool via stdin', async () => {
    const ended: string[] = [];
    const spawnFn = vi.fn(() => ({ stdin: { end: (s?: string) => ended.push(s ?? '') }, on: (_e: string, _cb: () => void) => {}, unref() {} }));
    // resolve immediately: the fake child calls close on next tick
    const child = { stdin: { end: (s?: string) => ended.push(s ?? '') }, on: (e: string, cb: () => void) => { if (e === 'close') setTimeout(cb, 0); }, unref() {} };
    const spawn2 = vi.fn(() => child);
    await copyToClipboard('the whisper', { platform: 'win32', spawnFn: spawn2 as never });
    expect(spawn2).toHaveBeenCalledWith('clip', [], expect.anything());
    expect(ended).toContain('the whisper');
  });

  test('unsupported platform rejects clearly', async () => {
    await expect(copyToClipboard('x', { platform: 'aix' as never, spawnFn: (() => {}) as never })).rejects.toThrow(/clipboard/i);
  });
});

describe('openUrl', () => {
  test('spawns the platform opener detached', () => {
    const spawnFn = vi.fn(() => ({ unref: () => {}, on: () => {}, stdin: { end: () => {} } }));
    openUrl('https://poe', { platform: 'win32', spawnFn: spawnFn as never });
    expect(spawnFn).toHaveBeenCalledWith('cmd', ['/c', 'start', '', 'https://poe'], expect.objectContaining({ detached: true }));
  });
});
