import { describe, expect, test, vi } from 'vitest';
import { createSoundPlayer, type SoundChild, type SoundSpawnFn } from '../src/snipe/sound-player.js';

function fakeChild() {
  const writes: string[] = [];
  const listeners = new Map<string, Array<() => void>>();
  const child: SoundChild = {
    stdin: { write: (chunk: string) => { writes.push(chunk); return true; } },
    on: (event, listener) => {
      const existing = listeners.get(event) ?? [];
      existing.push(listener);
      listeners.set(event, existing);
    },
    kill: vi.fn(),
  };
  return { child, writes, emit: (event: string) => { for (const l of listeners.get(event) ?? []) l(); } };
}

describe('createSoundPlayer', () => {
  test('spawns one child and plays via pipe writes', () => {
    const fake = fakeChild();
    const spawn = vi.fn((() => fake.child) as SoundSpawnFn);
    const player = createSoundPlayer('darwin', spawn, () => undefined);
    player.play();
    player.play();
    player.play();
    expect(spawn).toHaveBeenCalledTimes(1);
    expect(fake.writes).toHaveLength(3);
    expect(String(spawn.mock.calls[0]?.[0])).toBe('/bin/sh');
  });

  test('a dead child respawns on the next ping', () => {
    const first = fakeChild();
    const second = fakeChild();
    const children = [first, second];
    const spawn = vi.fn((() => children.shift()!.child) as SoundSpawnFn);
    const player = createSoundPlayer('darwin', spawn, () => undefined);
    player.play();
    first.emit('exit');
    player.play();
    expect(spawn).toHaveBeenCalledTimes(2);
    expect(second.writes).toHaveLength(1);
    expect(String(spawn.mock.calls[0]?.[0])).toBe('/bin/sh');
  });

  test('non-darwin platforms are a no-op and close kills the child', () => {
    const spawn = vi.fn();
    const player = createSoundPlayer('win32', spawn as unknown as SoundSpawnFn, () => undefined);
    player.play();
    expect(spawn).not.toHaveBeenCalled();

    const fake = fakeChild();
    const mac = createSoundPlayer('darwin', (() => fake.child) as SoundSpawnFn, () => undefined);
    mac.play();
    mac.close();
    expect(fake.child.kill).toHaveBeenCalled();
    mac.play(); // closed player never respawns
    expect(fake.writes).toHaveLength(1);
  });
});
