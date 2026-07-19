import { beforeEach, describe, expect, test } from 'vitest';
import { OpportunityLogRepository } from '../src/storage/opportunity-log-repository.js';
import { createDb } from '../src/storage/db.js';
import type { Opportunity } from '../src/domain/types.js';

function opp(overrides: Partial<Opportunity>): Opportunity {
  return {
    id: 'mean-reversion:poe1:Mirage:blessed',
    kind: 'mean-reversion',
    game: 'poe1',
    league: 'Mirage',
    itemId: 'blessed',
    itemName: 'Blessed Orb',
    category: 'Currency',
    edge: 0.35,
    confidence: 0.6,
    direction: 'sell',
    rationale: 'spiked above trend',
    dataFreshness: '2026-07-19T01:00:00Z',
    experimental: false,
    ...overrides,
  };
}

describe('OpportunityLogRepository', () => {
  let repo: OpportunityLogRepository;

  beforeEach(() => {
    repo = new OpportunityLogRepository(createDb(':memory:'));
  });

  test('records opportunities and resolves the latest instance of an id', () => {
    repo.record([opp({ edge: 0.3, dataFreshness: '2026-07-19T01:00:00Z' })]);
    repo.record([opp({ edge: 0.4, dataFreshness: '2026-07-19T02:00:00Z' })]);
    const resolved = repo.resolve('mean-reversion:poe1:Mirage:blessed');
    expect(resolved).not.toBeNull();
    expect(resolved!.edge).toBe(0.4);
    expect(resolved!.rationale).toBe('spiked above trend');
    expect(resolved!.direction).toBe('sell');
  });

  test('re-recording the same (id, asOf) is idempotent', () => {
    const o = opp({});
    repo.record([o]);
    repo.record([o]);
    expect(repo.countFor('mean-reversion:poe1:Mirage:blessed')).toBe(1);
  });

  test('resolve returns null for unknown ids', () => {
    expect(repo.resolve('nope')).toBeNull();
  });
});
