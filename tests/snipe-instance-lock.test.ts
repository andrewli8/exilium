import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, test } from 'vitest';
import { acquireSnipeLock, releaseSnipeLock } from '../src/snipe/instance-lock.js';

function dir(): string {
  return mkdtempSync(join(tmpdir(), 'exilium-lock-'));
}

describe('snipe instance lock', () => {
  test('acquires when no lock exists and records the pid', () => {
    const lockDir = dir();
    const result = acquireSnipeLock(lockDir, 123, () => true);
    expect(result.acquired).toBe(true);
    expect(readFileSync(result.path, 'utf8').trim()).toBe('123');
  });

  test('reports a live holder instead of acquiring', () => {
    const lockDir = dir();
    acquireSnipeLock(lockDir, 111, () => true);
    const second = acquireSnipeLock(lockDir, 222, (pid) => pid === 111);
    expect(second.acquired).toBe(false);
    expect(second.holderPid).toBe(111);
  });

  test('a stale lock (dead holder) is taken over', () => {
    const lockDir = dir();
    acquireSnipeLock(lockDir, 111, () => true);
    const second = acquireSnipeLock(lockDir, 222, () => false);
    expect(second.acquired).toBe(true);
    expect(readFileSync(second.path, 'utf8').trim()).toBe('222');
  });

  test('release removes only our own lock', () => {
    const lockDir = dir();
    const mine = acquireSnipeLock(lockDir, 111, () => true);
    writeFileSync(mine.path, '999'); // someone else took over meanwhile
    releaseSnipeLock(mine.path, 111);
    expect(readFileSync(mine.path, 'utf8').trim()).toBe('999'); // untouched
    releaseSnipeLock(mine.path, 999);
    expect(() => readFileSync(mine.path, 'utf8')).toThrow(); // gone
  });
});
