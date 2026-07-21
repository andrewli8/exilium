# A tour of the CLI

Run `exilium` with no arguments and you get the terminal UI. Everything else is a subcommand. This page goes through each one in the order you are likely to need them.

## exilium ingest

Fetches current market data and stores a snapshot. Each run also extends the local price history, which is what the charts and `get_pair_history` are built from.

```
Ingesting poe1/Mirage: Currency, Fragment, Scarab, Essence, Oil, Fossil, Resonator, DeliriumOrb, Tattoo, Omen, DivinationCard, Artifact, AllflameEmber
Saved: Currency, Fragment, Scarab, Essence, Oil, Fossil, Resonator, DeliriumOrb, Tattoo, Omen, DivinationCard, Artifact, AllflameEmber
```

A category can fail without killing the rest. Failures print with the reason.

## exilium snapshot

The market at a glance: top movers and top volume.

```
poe1/Mirage · 13 categories · as of 2026-07-19T00:04:41.132Z

Top movers:
Item                               Category        Price (chaos)  Change     Volume (chaos)
---------------------------------  --------------  -------------  ---------  --------------
Screaming Essence of Fear          Essence         28.18          154871.0%  80
Tattoo of the Tukohama Warcaller   Tattoo          171.9          17088.0%   458
```

Enormous change percentages on tiny volume are usually an item waking up from being worthless, not a trading opportunity. Read the volume column before the change column.

## exilium categories and exilium list

`categories` shows what exists and how much of it trades:

```
Category        Markets  Volume (chaos)
--------------  -------  --------------
Currency        101      13,758,620
DivinationCard  159      6,836,223
Fragment        69       1,410,207
Scarab          108      379,972
```

`list` browses one category. Case does not matter. Sort by `value`, `volume`, or `change`:

```bash
exilium list scarab --sort volume
```

```
Item                                  Price (chaos)  7d change  Volume (chaos)
------------------------------------  -------------  ---------  --------------
Horned Scarab of Bloodlines           1838           6.8%       172,509
Ultimatum Scarab of Catalysing        1022           181.9%     38,682
```

Typo the category name and the error lists the valid ones. That is faster than looking it up.

## exilium opps

Detector signals. By default it shows edges at or above 25%; both numbers are worth adjusting.

```bash
exilium opps --min-edge 100
exilium opps --category divinationcard --min-edge 50
exilium opps --experimental
```

Each row has a rationale, for example: "Latest daily change -40.0% is 3.2 standard deviations below its window mean, buy (expect recovery toward trend)." The edge is the gap between the latest move and the trend, not a promised profit. Gold fees and fill risk come out of it.

## exilium arb

Cross-rate consistency for every market. Covered properly in [the arbitrage walkthrough](04-arbitrage.md).

```bash
exilium arb --limit 10
exilium arb --category fragment --min-gap 1
```

## exilium price

Covered in [checking prices](01-checking-prices.md).

## exilium watch

A foreground loop that refetches on an interval and notifies you when a new signal crosses your threshold. Desktop notification on macOS and Linux, always the terminal, and a Discord webhook if you set one.

```bash
EXILIUM_MIN_EDGE=50 exilium watch
```

```
Watching poe1/Mirage every 600s for edges ≥ 50% — Ctrl+C to stop.
[2026-07-18T23:56:45Z] 🔔 Blessed Orb: 347.1% edge — Latest daily change 581.2% is 1.9 standard deviations above its window mean...
```

Each signal notifies once. The loop will not ping you about the same thing every ten minutes.

## exilium watches

The persistent version of alerts. Watches live in the database, so they survive restarts, and any running surface (TUI, dashboard, watch mode) evaluates them after each refresh. Agents create them through MCP; this command is how you see and manage the same set.

```bash
exilium watches add --kind price_above --item divine --threshold 750 --mode repeat
exilium watches
exilium watches events
exilium watches rm price_above:poe1:Mirage:divine:750
```

Kinds: `price_above` and `price_below` take a price in the primary currency, `change_abs` takes a 7-day change percent, `opportunity` takes a minimum edge percent. `--mode once` (the default) fires a single time and deactivates. `--webhook` posts fired events to a Discord webhook.

## exilium journal

The other half of every trade plan. After you act on one (or decide not to), record what happened:

```bash
exilium journal add mean-reversion:poe1:Mirage:blessed filled "sold 40 at 190c"
exilium journal
```

```
When                      Item     Outcome  Expected edge  Note
------------------------  -------  -------  -------------  -------------------
2026-07-19T03:04:46.828Z  blessed  filled   35.0%          sold 40 at 190c

1 recorded · fill rate 100% (filled 1, partial 0, no-fill 0, skipped 0)
```

Outcomes are filled, partial, no-fill, or skipped. The fill rate is the honest number this product cannot get anywhere else: whether the detector's edges survive contact with the actual market. Agents can record outcomes too, through the record_outcome tool.

## exilium live

Your pathofexile.com live searches, in the terminal, with the whisper copied to your clipboard the moment a listing appears. Needs your own POESESSID cookie. Covered properly in [the live search walkthrough](05-live-search.md).

```bash
EXILIUM_POESESSID=<cookie> exilium live "https://www.pathofexile.com/trade/search/Mirage/AbC123xyz"
```

## exilium simulate

The league is between updates and nothing is trading, but you want to know your watches and live-search setup actually work. `simulate` runs synthetic market movement through the real pipelines, entirely in memory — your database and pathofexile.com are never touched.

```bash
exilium simulate --moves "divine orb:+12, ambush scarab:-30" --rounds 3
exilium simulate                      # seeded random moves against your real watches
exilium simulate --live --count 5     # fake listings through the real snipe pipeline
exilium simulate --notify             # also fire a real desktop notification
```

Watch simulation clones your current snapshots and active watches (or two demo watches aimed at the item your first move touches, if you have none), applies the moves round by round, and reports exactly which watches fired with the same evaluation, dedupe, and once-mode logic production uses. Live simulation fabricates listings and pushes them through the identical whisper path — clipboard copy and notifications are real, so you can verify the whole chain ends at your paste buffer. Whispers are tagged (SIMULATED) so nobody pastes one at a real seller.

## exilium dashboard

A local web page on port 4321. It ingests on boot, refetches every five minutes, and reloads itself every 30 seconds. Price history charts for the top-volume markets appear once you have two or more snapshots stored, and fired watch events show in their own section.

## exilium tui

The default. Four views (movers, opportunities, arbitrage, fired watch events), switched with 1, 2, 3, 4. All views share the same table controls:

- `s` — incremental search: type words to filter rows (each word just has to appear, so "empower 4" finds the level-4 gem even though the words straddle the name and its variant), arrows scroll the matches while you type, Enter keeps the filter, Esc clears it.
- `f` — sort: `f` toggles the current column between descending and ascending (only `f` changes direction), ←/→ move to another column, ↑/↓ keep scrolling rows the whole time, Esc done.
- `c` — category picker: type a few letters ("sca" → Scarab), ↑/↓ to pick (the list scrolls when it's long), Enter applies, Esc cancels. No more cycling past the one you wanted.
- `l` — league picker: switch the active league among the ones you have data for (type-ahead, ↑/↓, Enter). To view a league you have not pulled yet, run `EXILIUM_LEAGUE="Standard" exilium ingest` first.
- `w` — create a watch for the selected row without leaving the terminal: type a threshold price (prefilled at +5%), and the direction infers itself — a threshold above the current price alerts on a rise, below alerts on a drop; ↑/↓ nudge ±1%. **High-value items (a Mirror, a chase unique) default to divines** so you can set "alert at 1500 div" without knowing the chaos number; press `d`/`c` to switch units, and the panel shows the chaos equivalent. On the opportunities view `w` builds an edge watch instead. Fires once, shows up in pane 4 and `exilium watches`.
- ↑/↓ move one row, Shift+↑/↓ jump ten, PgUp/PgDn (or ←/→) page — through the full list (a "row 12 of 604" indicator shows where you are; there is no top-15 cap).
- Enter — opens the selected item's search on the official trade site in your browser.

The movers view has a 24H% column computed from Exilium's own stored history, falling back to the poe.ninja sparkline's last-day segment (marked `7d`) until enough history accumulates; the 7D% figure stays alongside. Selecting a row in the opportunities view shows its full trade plan, journal command included. ←/→ cycle category filters. Press r to refetch immediately; it also refetches every five minutes on its own. The dot in the top right tells you data age: green under ten minutes, yellow under thirty, red past that.

## exilium mcp

Starts the MCP server on stdio so AI agents can use all of this. Not something you run by hand except to debug; register it once with `claude mcp add exilium -- exilium mcp` and let the agent client manage it.

## Environment variables

`EXILIUM_GAME` switches to poe2. `EXILIUM_LEAGUE` pins a league instead of auto-detecting. `EXILIUM_REFRESH` changes the auto-refetch cadence, with a floor of 300 seconds so nobody hammers poe.ninja. The full table is in the main README.
