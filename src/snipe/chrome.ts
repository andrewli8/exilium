import { existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

/** Launch a normal Chrome/Edge with a remote-debugging port so the manual
 * snipe console can reuse one logged-in trade-site tab. The dedicated profile
 * keeps the debugging session separate from the user's everyday browser. */

export const DEFAULT_CDP_PORT = 9222;

export interface ChromeLaunch {
  readonly cmd: string;
  readonly args: readonly string[];
  readonly note: string;
}

export function formatChromeLaunchCommand(launch: Pick<ChromeLaunch, 'cmd' | 'args'>, platform: NodeJS.Platform): string {
  const quote = (part: string): string => /[\s"]/u.test(part)
    ? `"${part.replaceAll('"', platform === 'win32' ? '`"' : '\\"')}"`
    : part;
  const command = [launch.cmd, ...launch.args].map(quote).join(' ');
  return platform === 'win32' ? `& ${command}` : command;
}

export interface ResolveChromeLaunchInput {
  readonly platform: NodeJS.Platform;
  readonly env: NodeJS.ProcessEnv;
  readonly port: number;
  readonly profileDir?: string;
  readonly configuredPath?: string;
  readonly exists?: (path: string) => boolean;
}

export function parseCdpPort(raw: string | undefined): number {
  if (raw === undefined || raw === '') return DEFAULT_CDP_PORT;
  const port = Number(raw);
  if (!Number.isInteger(port) || port < 1 || port > 65_535) {
    throw new Error(`CDP port must be an integer from 1 to 65535, got "${raw}"`);
  }
  return port;
}

function windowsChromeCandidates(env: NodeJS.ProcessEnv): readonly string[] {
  const programFiles = env['PROGRAMFILES'] ?? 'C:\\Program Files';
  const programFilesX86 = env['PROGRAMFILES(X86)'];
  const localAppData = env['LOCALAPPDATA'];
  return [
    `${programFiles}\\Google\\Chrome\\Application\\chrome.exe`,
    ...(programFilesX86 === undefined
      ? []
      : [`${programFilesX86}\\Google\\Chrome\\Application\\chrome.exe`]),
    ...(localAppData === undefined
      ? []
      : [`${localAppData}\\Google\\Chrome\\Application\\chrome.exe`]),
    `${programFiles}\\Microsoft\\Edge\\Application\\msedge.exe`,
    ...(programFilesX86 === undefined
      ? []
      : [`${programFilesX86}\\Microsoft\\Edge\\Application\\msedge.exe`]),
    ...(localAppData === undefined
      ? []
      : [`${localAppData}\\Microsoft\\Edge\\Application\\msedge.exe`]),
  ];
}

function windowsProfileDir(env: NodeJS.ProcessEnv): string {
  const localAppData =
    env['LOCALAPPDATA'] ??
    (env['USERPROFILE'] === undefined
      ? 'C:\\Users\\Public\\AppData\\Local'
      : `${env['USERPROFILE']}\\AppData\\Local`);
  return `${localAppData}\\Exilium\\chrome-profile`;
}

function defaultProfileDir(platform: NodeJS.Platform, env: NodeJS.ProcessEnv): string {
  return platform === 'win32'
    ? windowsProfileDir(env)
    : join(homedir(), '.exilium', 'chrome-profile');
}

export function resolveChromeLaunch(input: ResolveChromeLaunchInput): ChromeLaunch {
  const exists = input.exists ?? existsSync;
  const override = input.env['EXILIUM_CHROME'];
  let cmd: string;
  let note: string;

  if (override !== undefined && override !== '') {
    cmd = override;
    note = 'Using Chrome executable from EXILIUM_CHROME.';
  } else if (input.configuredPath !== undefined && input.configuredPath !== '') {
    cmd = input.configuredPath;
    note = 'Using the Chrome executable saved in Exilium config.';
  } else if (input.platform === 'darwin') {
    cmd = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
    note = 'Using the standard macOS Google Chrome location.';
  } else if (input.platform === 'win32') {
    const candidates = windowsChromeCandidates(input.env);
    cmd = candidates.find(exists) ?? candidates[0]!;
    note = exists(cmd)
      ? `Using detected browser at ${cmd}.`
      : 'Chrome was not detected. Set EXILIUM_CHROME or snipe.chromePath to the full Chrome/Edge executable path.';
  } else {
    cmd = 'google-chrome';
    note = 'Using google-chrome from PATH.';
  }

  const profileDir = input.profileDir ?? defaultProfileDir(input.platform, input.env);
  return {
    cmd,
    args: [
      `--remote-debugging-port=${input.port}`,
      `--user-data-dir=${profileDir}`,
      // Live-search tabs sit in the background, and Chrome deliberately
      // throttles background pages — timers and renderer scheduling can lag
      // by SECONDS, which is a direct sniping handicap. Disable all of it
      // for this dedicated profile.
      '--disable-background-timer-throttling',
      '--disable-backgrounding-occluded-windows',
      '--disable-renderer-backgrounding',
      'https://www.pathofexile.com/trade',
    ],
    note,
  };
}

/** Compatibility wrappers for callers outside the CLI; new code should use
 * resolveChromeLaunch so Windows discovery and profile defaults stay paired. */
export function defaultChromePath(platform: NodeJS.Platform, env: NodeJS.ProcessEnv): string {
  return resolveChromeLaunch({ platform, env, port: DEFAULT_CDP_PORT }).cmd;
}

export function chromeLaunchCommand(
  platform: NodeJS.Platform,
  env: NodeJS.ProcessEnv,
  port: number,
  profileDir: string,
): ChromeLaunch {
  return resolveChromeLaunch({ platform, env, port, profileDir });
}
