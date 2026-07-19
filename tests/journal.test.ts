import { beforeEach, describe, expect, test } from 'vitest';
import { JournalRepository } from '../src/storage/journal-repository.js';
import { formatJournal } from '../src/cli/format.js';
import { createDb } from '../src/storage/db.js';

describe('JournalRepository', () => {
  let repo: JournalRepository;

  beforeEach(() => {
    repo = new JournalRepository(createDb(':memory:'));
  });

  test('records an outcome and lists it newest first', () => {
    repo.record({
      opportunityId: 'mean-reversion:poe1:Mirage:blessed',
      itemName: 'Blessed Orb',
      outcome: 'filled',
      expectedEdgePct: 35,
      note: 'sold 40 at 190c',
      recordedAt: '2026-07-19T01:00:00Z',
    });
    repo.record({
      opportunityId: 'mean-reversion:poe1:Mirage:fusing',
      itemName: 'Orb of Fusing',
      outcome: 'no-fill',
      expectedEdgePct: 60,
      note: null,
      recordedAt: '2026-07-19T02:00:00Z',
    });
    const entries = repo.list(10);
    expect(entries).toHaveLength(2);
    expect(entries[0]!.itemName).toBe('Orb of Fusing');
    expect(entries[1]!.note).toBe('sold 40 at 190c');
  });

  test('rejects unknown outcome values at the boundary', () => {
    expect(() =>
      repo.record({
        opportunityId: 'x',
        itemName: 'X',
        outcome: 'mooned' as never,
        expectedEdgePct: 10,
        note: null,
        recordedAt: '2026-07-19T01:00:00Z',
      }),
    ).toThrow(/outcome/i);
  });

  test('summary reports counts and fill rate', () => {
    const base = { itemName: 'X', expectedEdgePct: 20, note: null, recordedAt: '2026-07-19T01:00:00Z' };
    repo.record({ ...base, opportunityId: 'a', outcome: 'filled' });
    repo.record({ ...base, opportunityId: 'b', outcome: 'filled' });
    repo.record({ ...base, opportunityId: 'c', outcome: 'partial' });
    repo.record({ ...base, opportunityId: 'd', outcome: 'no-fill' });
    const s = repo.summary();
    expect(s.total).toBe(4);
    expect(s.counts['filled']).toBe(2);
    expect(s.counts['no-fill']).toBe(1);
    expect(s.fillRate).toBeCloseTo(0.625); // filled + 0.5 * partial over total
  });
});

describe('formatJournal', () => {
  test('prints entries and the fill-rate summary', () => {
    const out = formatJournal(
      [
        {
          id: 1,
          opportunityId: 'mean-reversion:poe1:Mirage:blessed',
          itemName: 'Blessed Orb',
          outcome: 'filled',
          expectedEdgePct: 35,
          note: 'sold 40 at 190c',
          recordedAt: '2026-07-19T01:00:00Z',
        },
      ],
      { total: 1, counts: { filled: 1, partial: 0, 'no-fill': 0, skipped: 0 }, fillRate: 1 },
    );
    expect(out).toContain('Blessed Orb');
    expect(out).toContain('filled');
    expect(out).toContain('35');
    expect(out).toMatch(/fill rate.*100%/i);
  });

  test('explains an empty journal', () => {
    const out = formatJournal([], { total: 0, counts: { filled: 0, partial: 0, 'no-fill': 0, skipped: 0 }, fillRate: 0 });
    expect(out).toMatch(/no outcomes recorded/i);
  });
});
