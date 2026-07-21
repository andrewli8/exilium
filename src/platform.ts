/** Cross-platform shells for the three OS-specific things Exilium does:
 * copy to clipboard, open a URL, and (in notify.ts) show a notification.
 * PoE is mostly played on Windows, so every branch here has a win32 path. */

import { spawn as nodeSpawn } from 'node:child_process';

interface ChildLike {
  readonly stdin: { end: (s?: string) => void } | null;
  on: (event: string, cb: (...a: unknown[]) => void) => void;
  unref: () => void;
}

export type SpawnFn = (cmd: string, args: readonly string[], opts?: Record<string, unknown>) => ChildLike;

export interface PlatformDeps {
  readonly platform: NodeJS.Platform;
  readonly spawnFn?: SpawnFn;
}

export interface Command {
  readonly cmd: string;
  readonly args: readonly string[];
}

export function clipboardCommand(platform: NodeJS.Platform): Command | null {
  if (platform === 'darwin') return { cmd: 'pbcopy', args: [] };
  if (platform === 'win32') return { cmd: 'clip', args: [] };
  if (platform === 'linux') return { cmd: 'xclip', args: ['-selection', 'clipboard'] };
  return null;
}

/** On Windows `start` is a cmd builtin, not an executable, so it must be
 * invoked as `cmd /c start "" <url>` (the empty "" is the window title). */
export function openCommand(platform: NodeJS.Platform, url: string): Command {
  if (platform === 'darwin') return { cmd: 'open', args: [url] };
  if (platform === 'win32') return { cmd: 'cmd', args: ['/c', 'start', '', url] };
  return { cmd: 'xdg-open', args: [url] };
}

export async function copyToClipboard(text: string, deps: PlatformDeps): Promise<void> {
  const c = clipboardCommand(deps.platform);
  if (c === null) throw new Error(`No clipboard tool for platform "${deps.platform}".`);
  const spawn = deps.spawnFn ?? (nodeSpawn as unknown as SpawnFn);
  await new Promise<void>((resolve, reject) => {
    const child = spawn(c.cmd, c.args, { stdio: ['pipe', 'ignore', 'ignore'] });
    child.on('error', reject);
    child.on('close', () => resolve());
    child.stdin?.end(text);
  });
}

export function openUrl(url: string, deps: PlatformDeps): void {
  const c = openCommand(deps.platform, url);
  const spawn = deps.spawnFn ?? (nodeSpawn as unknown as SpawnFn);
  spawn(c.cmd, c.args, { detached: true, stdio: 'ignore' }).unref();
}
