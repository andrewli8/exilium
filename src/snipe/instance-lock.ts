/**
 * Single-instance detection for the snipe runtime. Two snipe sessions on
 * one machine share the same Chrome profile: both attach to the same tabs,
 * double-process every listing, and fight over activate/travel clicks —
 * and every extra process holding the SQLite database open blocks WAL
 * checkpointing, which is how month-old databases grew 100MB+ WALs. The
 * lock only warns; it never blocks a start (a stale file must never brick
 * the tool).
 */
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

export interface SnipeLockResult {
  readonly acquired: boolean;
  /** Pid of the live session already holding the lock, when not acquired. */
  readonly holderPid: number | null;
  readonly path: string;
}

export function acquireSnipeLock(
  dir: string,
  pid: number,
  isAlive: (pid: number) => boolean,
): SnipeLockResult {
  mkdirSync(dir, { recursive: true });
  const path = join(dir, 'snipe.lock');
  try {
    const holder = Number(readFileSync(path, 'utf8').trim());
    if (Number.isInteger(holder) && holder > 0 && holder !== pid && isAlive(holder)) {
      return { acquired: false, holderPid: holder, path };
    }
  } catch {
    // No lock file (or unreadable) — free to take.
  }
  writeFileSync(path, String(pid));
  return { acquired: true, holderPid: null, path };
}

/** Remove the lock, but only if this pid still owns it. */
export function releaseSnipeLock(path: string, pid: number): void {
  try {
    if (readFileSync(path, 'utf8').trim() === String(pid)) rmSync(path);
  } catch {
    // Already gone or taken over — nothing to release.
  }
}

/** signal 0 probes liveness; EPERM means alive but not ours (still alive). */
export function defaultIsAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'EPERM';
  }
}
