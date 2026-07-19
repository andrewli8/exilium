import { describe, expect, test } from 'vitest';
import { draftTradePlan } from '../src/signals/trade-plan.js';
import type { Opportunity } from '../src/domain/types.js';

const OPP: Opportunity = {
  id: 'mean-reversion:Runes of Aldur:chaos',
  kind: 'mean-reversion',
  league: 'Runes of Aldur',
  itemId: 'chaos',
  itemName: 'Chaos Orb',
  category: 'Currency',
  edge: 0.12,
  confidence: 0.8,
  direction: 'sell',
  rationale: 'Latest daily change -25.0% is 3.2 standard deviations below its window mean — buy (expect recovery toward trend).',
  dataFreshness: '2026-07-18T18:00:00Z',
  experimental: false,
};

describe('draftTradePlan', () => {
  test('produces sequentially ordered human-executable steps naming the item', () => {
    const plan = draftTradePlan(OPP);
    expect(plan.opportunityId).toBe(OPP.id);
    expect(plan.steps.length).toBeGreaterThanOrEqual(3);
    expect(plan.steps.map((s) => s.order)).toEqual(plan.steps.map((_, i) => i + 1));
    expect(plan.steps.some((s) => s.instruction.includes('Chaos Orb'))).toBe(true);
    expect(plan.summary).toContain('Chaos Orb');
    expect(plan.expectedEdge).toBe(0.12);
  });

  test('final step tells the user exactly how to record the outcome', () => {
    const plan = draftTradePlan(OPP);
    const last = plan.steps[plan.steps.length - 1]!;
    expect(last.instruction).toContain('exilium journal add');
    expect(last.instruction).toContain(OPP.id);
  });

  test('always carries gold-fee and human-execution notes', () => {
    const plan = draftTradePlan(OPP);
    expect(plan.goldFeeNote).toMatch(/gold/i);
    expect(plan.humanExecutionNote).toMatch(/human|in-game|never executes/i);
  });

  test('marks experimental opportunities prominently in the summary', () => {
    const plan = draftTradePlan({ ...OPP, experimental: true, kind: 'cross-rate-divergence' });
    expect(plan.summary).toMatch(/experimental/i);
  });
});
