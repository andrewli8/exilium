import { execFile } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import { createDb } from '../src/storage/db.js';
import { SnapshotRepository } from '../src/storage/snapshot-repository.js';

const exec = promisify(execFile);

/** Spawns the real CLI the way a user runs it. Slower than unit tests by
 * design: this is the wiring layer nothing else executes. */
describe('CLI integration', () => {
  let dir: string;
  let env: NodeJS.ProcessEnv;

  beforeAll(() => {
    dir = mkdtempSync(join(tmpdir(), 'exilium-cli-'));
    const dbPath = join(dir, 'test.db');
    const repo = new SnapshotRepository(createDb(dbPath));
    repo.save({
      game: 'poe1',
      league: 'TestLeague',
      category: 'Currency',
      fetchedAt: '2026-07-19T00:00:00Z',
      core: { primary: 'chaos', perPrimary: { chaos: 1, divine: 0.0014 } },
      lines: [
        {
          itemId: 'divine',
          name: 'Divine Orb',
          category: 'Currency',
          primaryValue: 714,
          volumePrimaryValue: 900000,
          maxVolumeCurrency: 'chaos',
          maxVolumeRate: 0.0014,
          sparkline: [1, 2, 1, 2, 1, 2, 1],
          totalChange: 1,
        },
        {
          itemId: 'crashed-orb',
          name: 'Crashed Orb',
          category: 'Currency',
          primaryValue: 12,
          volumePrimaryValue: 40000,
          maxVolumeCurrency: 'divine',
          maxVolumeRate: 60,
          sparkline: [10, 12, 11, 9, 10, 11, -40],
          totalChange: -40,
        },
      ],
    });
    env = { ...process.env, EXILIUM_DB: dbPath, EXILIUM_LEAGUE: 'TestLeague', EXILIUM_GAME: 'poe1' };
  });

  afterAll(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  const run = (...args: readonly string[]) =>
    exec('npx', ['tsx', 'src/cli.ts', ...args], { env, timeout: 30_000 });

  test('price resolves an item from the stored snapshot', async () => {
    const { stdout } = await run('price', 'divine', 'orb');
    expect(stdout).toContain('Divine Orb');
    expect(stdout).toContain('714');
    expect(stdout).toContain('chaos');
  }, 40_000);

  test('snapshot prints movers from the fixture', async () => {
    const { stdout } = await run('snapshot');
    expect(stdout).toContain('poe1/TestLeague');
    expect(stdout).toContain('Crashed Orb');
  }, 40_000);

  test('opps surfaces the planted mean-reversion signal', async () => {
    const { stdout } = await run('opps', '--min-edge', '10');
    expect(stdout).toContain('Crashed Orb');
    expect(stdout).toContain('mean-reversion');
  }, 40_000);

  test('journal add then journal list round-trips through the real DB', async () => {
    await run('journal', 'add', 'mean-reversion:poe1:TestLeague:crashed-orb', 'filled', 'integration test');
    const { stdout } = await run('journal');
    expect(stdout).toContain('integration test');
    expect(stdout).toMatch(/fill rate 100%/);
    expect(stdout).toContain('mean-reversion');
  }, 80_000);

  test('watches add, list, and rm manage the real watch store', async () => {
    await run('watches', 'add', '--kind', 'price_above', '--item', 'divine', '--threshold', '700', '--id', 'itest');
    const { stdout: listed } = await run('watches');
    expect(listed).toContain('itest');
    expect(listed).toContain('price_above');
    const { stdout: removed } = await run('watches', 'rm', 'itest');
    expect(removed).toContain('Deleted');
  }, 120_000);

  test('unknown commands exit nonzero with usage', async () => {
    await expect(run('frobnicate')).rejects.toMatchObject({ code: 2 });
  }, 40_000);
});
