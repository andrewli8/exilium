import type { Opportunity, TradePlan, TradePlanStep } from '../domain/types.js';

const GOLD_FEE_NOTE =
  'The in-game Currency Exchange charges a gold fee per order. Gold is character-bound and finite — ' +
  'treat it as a real cost: skip edges thinner than your gold cost plus the farming time to replace it.';

const HUMAN_EXECUTION_NOTE =
  'Exilium never executes trades. Every step below is performed by you, in-game. ' +
  'Prices are minutes-to-hours old — re-verify the live ratio before confirming any order.';

/** Turn a detected opportunity into an ordered, human-executable plan. */
export function draftTradePlan(opp: Opportunity): TradePlan {
  const experimentalTag = opp.experimental ? '[EXPERIMENTAL — research signal, fills unproven] ' : '';
  const instructions: readonly string[] = [
    `Review the signal: ${opp.rationale}`,
    `Open the Currency Exchange in-game (league: ${opp.league}).`,
    `Check the live ratio for ${opp.itemName} — proceed only if the ${(opp.edge * 100).toFixed(1)}% edge still holds.`,
    `Place your order for ${opp.itemName} at or better than the signal ratio; note the gold fee before confirming.`,
    `Record the outcome (filled / partial / no-fill) to judge this detector's real-world hit rate.`,
  ];
  const steps: readonly TradePlanStep[] = instructions.map((instruction, i) => ({ order: i + 1, instruction }));

  return {
    opportunityId: opp.id,
    summary: `${experimentalTag}${opp.kind} on ${opp.itemName} (${opp.league}): expected edge ${(opp.edge * 100).toFixed(1)}%, confidence ${(opp.confidence * 100).toFixed(0)}%.`,
    steps,
    expectedEdge: opp.edge,
    goldFeeNote: GOLD_FEE_NOTE,
    humanExecutionNote: HUMAN_EXECUTION_NOTE,
  };
}
