# Arbitrage events

The honest version first: the in-game Currency Exchange is efficient, and most of the time there is nothing to arbitrage. This walkthrough explains what Exilium measures, how to read it, and how we test that the measurement itself is correct.

## What the arb table measures

Every market on the exchange has a listed price in the primary currency (chaos for PoE1). Most markets also trade heavily against a second currency. A Scarab might be priced at 583.4 chaos while its busiest pair trades it against divine.

Those two routes imply each other. If one divine is 720 chaos, and the Scarab trades at 1.24 per divine, then the divine route prices the Scarab at about 581 chaos. Exilium computes that implied price for every market and compares it to the listed one:

```bash
exilium arb --limit 8
```

```
Item                           Category   Listed (chaos)  Implied (chaos)  Via     Gap   Volume
-----------------------------  ---------  --------------  ---------------  ------  ----  ------
Simulacrum Splinter            Fragment   0.9304          0.9346           chaos   0.4%  267
Primitive Chaotic Resonator    Resonator  1.130           1.135            chaos   0.4%  192
Ambush Scarab of Containment   Scarab     583.4           581.4            divine  0.3%  22,945
```

A gap means the two routes disagree. In principle you buy through the cheap route and sell through the expensive one.

## Why the gaps are small

Every player on the exchange is implicitly doing this arithmetic, and the market makers who post bulk orders keep the routes aligned. In practice gaps stay under half a percent, which is less than the gold fee you would pay to exploit them. The table above is the exchange working correctly.

So when does this view earn its place? Three situations show real gaps: the first days of a new league, when prices move faster than order books adjust; thin markets, where one stale bulk order skews a route; and sudden repricing events, a patch note or a popular video, where one route reacts before the other.

That is why the arb view exists as a monitor rather than a money printer. Set a watch and forget it:

```bash
# through Claude, or any MCP client:
# create_watch kind=opportunity threshold=3 category=... (cross-rate signals are experimental, opt in)
```

or glance at pane 3 in the TUI during league start week, which is when it is actually interesting.

## Reading a wide gap skeptically

Say a row shows a 6% gap. Before treating it as free money, look at the volume column. A wide gap on 21 chaos of daily volume means one person posted a weird order. You will not get filled at the implied price, and trying costs gold.

Then check freshness. A gap computed from 25-minute-old data may have already closed. The TUI header tells you the data age; re-run `exilium ingest` and see if the gap survives.

If it survives on real volume, verify in game, route by route, before committing anything. The trade plan format applies here too: the last step is always to record what actually happened.

## How we know the detector is accurate

Detection code that mostly works is worse than none, because you stop double-checking it. The eval suite plants known answers and requires the detectors to find exactly those:

```bash
npm run eval
```

It runs three checks.

The first builds a synthetic market of 40 lines where 32 are internally consistent within noise and 8 have divergences planted at known sizes, from 4% to 15%. The cross-rate detector must flag all 8 planted lines and none of the clean ones, and each reported edge must match the planted gap to within a tolerance. Precision and recall both have to be 1.0 or the eval fails.

The second does the same for mean reversion: flat, noisy price series with a handful of planted spikes, where the detector must flag the spikes and leave the noise alone.

The third runs against your real database. It recomputes every implied price independently from the stored raw fields and asserts the arb table agrees, which catches pipeline bugs like a units mix-up between "items per divine" and "divine per item" that synthetic data might accidentally encode on both sides.

The evals are deterministic (seeded random noise), so a failure is a bug, not a flake. If you change detector math, run them.
