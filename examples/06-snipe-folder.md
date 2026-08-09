# Snipe your BetterTrading folder

`exilium snipe` runs every trade search you have saved, all at once, with a live
profit margin on each hit. This walkthrough sets up a folder for a Valdo's
Puzzle Box session — sniping underpriced foil uniques — but the flow is the
same for any searches.

It needs your POESESSID cookie (`exilium setup` stores it) because the live
websocket is authenticated, just like `exilium live`.

## 1. First run scaffolds the folder

```
$ exilium snipe
No BetterTrading folder yet — created /Users/you/.exilium/BetterTrading with a starter:
  /Users/you/.exilium/BetterTrading/README.txt
  /Users/you/.exilium/BetterTrading/my-snipes.txt
Drop your trade links / Better Trading exports in there and rerun `exilium snipe`.
```

A `BetterTrading/` directory next to where you run the command works too, and
`EXILIUM_BETTERTRADING` or `--folder` point anywhere else.

## 2. Fill it with searches

Three formats, mix freely:

**Plain text** — one URL per line, `| label` optional:

```
# my-snipes.txt
https://www.pathofexile.com/trade/search/Allflame/AbC123xyz | Foil Mageblood
https://www.pathofexile.com/trade/search/Allflame/DeF456uvw | Valdo boxes under 30div
```

**Better Trading extension exports** — in the extension, open a bookmark
folder, Export, and paste the `3:...` string on its own line in any `.txt` or
`.bt` file. Every trade in the folder becomes a target, labeled
`Folder · Trade`.

**Structured JSON** — when a search needs its own rules:

```json
{
  "targets": [
    {
      "label": "Cheap Valdo boxes",
      "url": "https://www.pathofexile.com/trade/search/Allflame/DeF456uvw",
      "maxBuy": { "amount": 30, "currency": "divine" },
      "minMarginPct": 25
    }
  ]
}
```

## 3. Run it

```
$ exilium snipe --min-margin 15
Exilium snipe — 2 searches · league Allflame · min margin 15 · mode ping
Whispers are copied to your clipboard the moment a listing lands. Ctrl+C to stop.
  · Foil Mageblood (AbC123xyz)
  · Cheap Valdo boxes (DeF456uvw)
Every alert is appended to /Users/you/.exilium/snipes.jsonl
watching Foil Mageblood — Allflame/AbC123xyz
watching Cheap Valdo boxes — Allflame/DeF456uvw
```

When something lists:

```
[2026-08-09T16:04:12.331Z] [Foil Mageblood] Mageblood · 150 divine · +10,000c (+25.0%) · seller Valdo_Enjoyer
  ping: whisper copied — paste in game, or click Travel to Hideout on the trade site yourself
```

The desktop notification carries the same margin line. The whisper is already
on your clipboard: alt-tab, paste, Enter. Add `--open` to also pop the search
page in your browser so the listing's **Travel to Hideout** button is right
there.

What the margin line means:

- `+10,000c (+25.0%)` — poe.ninja values the item 10,000 chaos above the
  asking price. The reference was fetched minutes ago; Exilium refreshes it in
  the background so it stays under 10 minutes old.
- `STALE >10m` — the refresh fell behind (rate limit, network); reprice before
  you commit.
- `no reference price` — a rare or unindexed item. It still alerts, because
  judging those is why you saved the search.

Suppressed listings (over `maxBuy`, under the margin floor, duplicates) are
logged to stderr with the reason, so you can tell "quiet" from "broken".

## 4. League handling

Search ids are league-portable, so every PoE1 search runs under the current
challenge league — **Allflame** — even if the bookmark URL says an older
league. `--league Standard` overrides, `--keep-league` trusts each URL.

## 5. Ping vs auto-travel

The default `ping` mode never acts for you — that is the same line the rest
of Exilium holds. There is an opt-in `auto` mode that drives a separate
logged-in browser (Playwright) to click Travel to Hideout on qualifying
snipes. It requires `--auto-travel` on the command line **and**
`"snipe": { "autoTravelAcknowledged": true }` in `~/.exilium/config.json`,
and it warns on every run: an automated click is a server action GGG did not
get from your hand, and your account carries that risk. If any part fails —
Playwright missing, browser closed, button gone — it degrades to a ping.

## 6. Review the session

```
$ tail -1 ~/.exilium/snipes.jsonl | jq '{ts, targetLabel, itemName, priceText, marginText, action}'
{
  "ts": "2026-08-09T16:04:12.340Z",
  "targetLabel": "Foil Mageblood",
  "itemName": "Mageblood",
  "priceText": "150 divine",
  "marginText": "+10,000c (+25.0%)",
  "action": "ping"
}
```

Every alert lands there, so a snipe missed while mapping is still reviewable.
