import { describe, expect, test, vi } from 'vitest';
import type { SnipeTarget } from '../src/snipe/bettertrading.js';
import { DEFAULT_SNIPE_LEAGUE, effectiveLeague, resolveSnipeLeague } from '../src/snipe/league.js';

const noLog = (): void => undefined;

describe('resolveSnipeLeague', () => {
  test('flag beats config beats discovery', async () => {
    const fetchLeagues = vi.fn();
    expect(await resolveSnipeLeague({ game: 'poe1', league: 'Standard' }, 'Allflame', noLog, fetchLeagues)).toBe('Allflame');
    expect(await resolveSnipeLeague({ game: 'poe1', league: 'Standard' }, undefined, noLog, fetchLeagues)).toBe('Standard');
    expect(fetchLeagues).not.toHaveBeenCalled();
  });

  test('discovers the current challenge league, skipping permanent variants', async () => {
    const fetchLeagues = vi.fn().mockResolvedValue(['Standard', 'Hardcore', 'Ruthless', 'HC Ruthless Allflame', 'Allflame']);
    expect(await resolveSnipeLeague({ game: 'poe1', league: null }, undefined, noLog, fetchLeagues)).toBe('Allflame');
  });

  test('falls back to Allflame when the trade API is unreachable, and says so', async () => {
    const log = vi.fn();
    const fetchLeagues = vi.fn().mockRejectedValue(new Error('offline'));
    expect(await resolveSnipeLeague({ game: 'poe1', league: null }, undefined, log, fetchLeagues)).toBe(DEFAULT_SNIPE_LEAGUE);
    expect(String(log.mock.calls[0]![0])).toContain('offline');
  });

  test('a league list with only permanent leagues also falls back', async () => {
    const fetchLeagues = vi.fn().mockResolvedValue(['Standard', 'Hardcore']);
    expect(await resolveSnipeLeague({ game: 'poe1', league: null }, undefined, noLog, fetchLeagues)).toBe(DEFAULT_SNIPE_LEAGUE);
  });
});

describe('effectiveLeague', () => {
  const target = (over: Partial<SnipeTarget>): SnipeTarget => ({
    label: 't',
    realm: 'trade',
    searchId: 'A1',
    league: null,
    ...over,
  });

  test('poe1 searches run under the resolved league regardless of URL league', () => {
    expect(effectiveLeague(target({ league: 'Settlers' }), 'Allflame', false)).toBe('Allflame');
    expect(effectiveLeague(target({}), 'Allflame', false)).toBe('Allflame');
  });

  test('--keep-league trusts the URL league when there is one', () => {
    expect(effectiveLeague(target({ league: 'Standard' }), 'Allflame', true)).toBe('Standard');
    expect(effectiveLeague(target({}), 'Allflame', true)).toBe('Allflame');
  });

  test('poe2 searches keep their own league and never inherit a poe1 one', () => {
    expect(effectiveLeague(target({ realm: 'trade2', league: 'Runes of Aldur' }), 'Allflame', false)).toBe('Runes of Aldur');
    expect(effectiveLeague(target({ realm: 'trade2' }), 'Allflame', false)).toBeNull();
  });
});
