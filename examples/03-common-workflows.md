# Common workflows

Three ways people actually use Exilium: a manual flipping session, standing alerts, and driving it through Claude.

## A flipping session

You have an hour to play and some currency to put to work.

Start the TUI and leave it on a second monitor:

```bash
exilium
```

It refetches on its own, so the freshness dot stays green while you play.

Press 2 for the opportunities view. You are looking for rows where the edge is large, the confidence is not terrible, and the rationale makes sense for the league's current state. A 300% edge on an item with 48% confidence means a violent price move on moderate volume. Sometimes that is a real overshoot that will revert. Sometimes the item genuinely repriced because of a patch note, and it is never coming back. The detector cannot tell those apart; you can.

Found a candidate? Check the market around it. Press 1 for movers, arrow to the item, and look at the 7-day sparkline under the table. A spike at the end of a flat week reads differently than the latest step of a steady climb.

Then check the category. Press the right arrow until the filter shows the item's category, for example `[Essence]`. If every essence spiked today, that is a league-wide event (new crafting meta, a popular build guide), not one mispriced item.

When you decide to act, the trade itself happens in game at the Currency Exchange. Re-check the live ratio there before confirming. Exilium's data is minutes old and the plan you got is an estimate. Note the gold fee; thin edges disappear into it.

## Standing alerts

You do not want to stare at a terminal. You want a ping when something interesting happens.

```bash
EXILIUM_MIN_EDGE=75 exilium watch
```

That posts a desktop notification whenever a new signal crosses 75% edge, once per signal. Add `EXILIUM_WEBHOOK=https://discord.com/api/webhooks/...` and it lands in your Discord too.

For alerts that survive across sessions, use agent watches instead. They live in the database, not in a running process. Any of the refresh loops (TUI, dashboard, watch mode) will evaluate them, and an agent can read the results later. Which brings us to the next section.

## Driving Exilium through Claude

After `claude mcp add exilium -- exilium mcp`, Claude sessions can use all thirteen tools. Some prompts that map cleanly onto them:

"What are the biggest movers in PoE1 right now?" calls `get_market_snapshot`.

"List all scarabs by volume and tell me which ones look mispriced" chains `list_items` with `find_opportunities` and does the comparison itself.

"Watch for Divine Orb going above 750 chaos and check on it when I ask" calls `create_watch` with a price threshold. The watch persists. Hours later, "did my divine watch fire?" calls `poll_watch_results` and reads back exactly what fired and when, with no re-scanning.

"Find me an opportunity worth acting on and write out the steps" ends with `draft_trade_plan`, which returns an ordered list: review the signal, open the exchange, verify the ratio still holds, place the order, record what happened. The plan always says the same thing about execution, because it is true: Exilium never trades. You do.

One habit worth building: when a plan's last step says record the outcome, actually tell Claude what happened. Fill data is the thing this product cannot get any other way.

## Keeping history deep

Charts and `get_pair_history` are only as good as the number of snapshots stored. Anything that refetches (TUI, dashboard, watch mode) grows history while it runs. If you want history without any UI open, cron it:

```
*/10 * * * * cd /path/to/exilium && npx exilium ingest
```

Two weeks of that and the dashboard charts start looking like actual charts.
