/**
 * Persistent ping player. Spawning a process per ping costs ~100ms (afplay)
 * to 1-2s (PowerShell cold start on Windows) — audible lag against the trade
 * tab's own instant ding. Instead one long-lived child reads lines from
 * stdin and plays the system sound per line, so a ping is a single pipe
 * write. A dead child respawns lazily on the next ping.
 */

export interface SoundChild {
  readonly stdin?: { write(chunk: string): unknown } | null;
  on(event: 'error' | 'exit' | 'close', listener: () => void): unknown;
  kill(): unknown;
}

export type SoundSpawnFn = (cmd: string, args: readonly string[], opts: Record<string, unknown>) => SoundChild;

export interface SoundPlayer {
  play(): void;
  close(): void;
}

function playerCommand(platform: NodeJS.Platform): { cmd: string; args: readonly string[] } | null {
  if (platform === 'darwin') {
    return {
      cmd: '/bin/sh',
      args: ['-c', 'while read line; do afplay /System/Library/Sounds/Glass.aiff & done'],
    };
  }
  if (platform === 'win32') {
    return {
      cmd: 'powershell',
      args: [
        '-NoProfile', '-NonInteractive', '-WindowStyle', 'Hidden', '-Command',
        '$in=[Console]::In; while($null -ne ($l=$in.ReadLine())){[System.Media.SystemSounds]::Asterisk.Play()}',
      ],
    };
  }
  return null; // Other platforms rely on the terminal bell alone.
}

export function createSoundPlayer(
  platform: NodeJS.Platform,
  spawnFn: SoundSpawnFn,
  log: (message: string) => void,
): SoundPlayer {
  const command = playerCommand(platform);
  let child: SoundChild | null = null;
  let closed = false;

  const ensureChild = (): SoundChild | null => {
    if (command === null || closed) return null;
    if (child !== null) return child;
    try {
      const spawned = spawnFn(command.cmd, command.args, {
        stdio: ['pipe', 'ignore', 'ignore'],
        windowsHide: true,
      });
      spawned.on('error', () => { child = null; });
      spawned.on('exit', () => { child = null; });
      child = spawned;
      return spawned;
    } catch (error) {
      log(`sound player unavailable: ${error instanceof Error ? error.message : String(error)}`);
      return null;
    }
  };

  return {
    play(): void {
      const current = ensureChild();
      if (current === null) return;
      try {
        current.stdin?.write('\n');
      } catch {
        child = null; // Broken pipe: respawn on the next ping.
      }
    },
    close(): void {
      closed = true;
      try {
        child?.kill();
      } catch {
        // Already gone.
      }
      child = null;
    },
  };
}
