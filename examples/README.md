# Examples

Walkthroughs for the Exilium CLI. Each one is a sequence of commands you can paste into a terminal, with the output you should expect and an explanation of what to do with it.

Start with the first one if you have never run Exilium before. The others assume you have data ingested.

1. [Checking prices](01-checking-prices.md). Price a single item, understand the confidence number, convert between currencies.
2. [A tour of the CLI](02-cli-tour.md). Every command, what it prints, and which flags matter.
3. [Common workflows](03-common-workflows.md). A daily flipping session, setting up alerts, and using Exilium through Claude.
4. [Arbitrage events](04-arbitrage.md). What the arb table actually measures, how to read it, and why most gaps are small.

There is also an eval suite that checks the detectors against planted, known-answer data:

```bash
npm run eval
```

See the last section of the arbitrage walkthrough for what it verifies.
