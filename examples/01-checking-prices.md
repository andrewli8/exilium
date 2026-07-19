# Checking prices

You want to know what something is worth without alt-tabbing to a browser.

## Setup, once

```bash
exilium ingest
```

This pulls current market data for the active challenge league into `~/.exilium/exilium.db`. It takes a few seconds. If you skip this step every other command will tell you to run it.

## Price one item

```bash
exilium price divine orb
```

```
Divine Orb (poe1/Mirage)
  720.800 chaos  (= 0.9997 divine)
  confidence 95% · as of 2026-07-19T00:04:40.892Z
```

Three things worth knowing about this output.

The price is in chaos because chaos is the pricing unit for PoE1. If you run with `EXILIUM_GAME=poe2`, prices come back in divine instead, since that is what the PoE2 exchange prices against.

The confidence number comes from traded volume. Divine Orbs trade constantly, so 95%. A niche essence that traded twice today might show 30%, and you should trust that price less.

The `as of` timestamp is when the data was fetched. If it is old, run `exilium ingest` again. The TUI and dashboard refresh on their own; the one-shot commands read whatever is stored.

## Partial names work

You do not need the exact name. Matching tries the item id first, then the exact name, then falls back to a substring match and picks the highest-volume candidate:

```bash
exilium price mirror
```

```
Mirror of Kalandra (poe1/Mirage)
  1.07032e+6 chaos  (= 1485 divine)
  confidence 100% · as of 2026-07-19T00:04:40.892Z
```

If nothing matches you get a plain "no match" message, not a guess. Pricing covers currency and stackables only. Asking for a rare item with mods will never work, and that is deliberate: mod-based valuation is a different product.

## When the answer looks wrong

Check the confidence first, then the timestamp. A thin market plus stale data produces prices that lag the real exchange by a lot. The trade plans in `exilium opps` repeat this warning for a reason: verify the live ratio in game before you commit currency to anything.
