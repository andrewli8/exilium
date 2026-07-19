# Live search: trade links in the CLI

The browser workflow this replaces: you build a search on pathofexile.com/trade, hit Activate Live Search, and leave the tab open, hoping you notice the ping before the other three people watching the same search. Exilium moves that into the terminal and puts the whisper on your clipboard the moment a listing appears.

## What you need

Your own `POESESSID` cookie. The live search API only works for logged-in sessions, the same as the browser tab. Log into pathofexile.com, open devtools (Application > Cookies on Chrome, Storage > Cookies on Firefox), and copy the value of `POESESSID`.

Two things about that cookie, stated plainly. It is a full login session, so treat it like a password. Exilium keeps it in the environment variable you set, stores it nowhere, and sends it to exactly one host: pathofexile.com. That is the same trust model as Awakened PoE Trade and every other session-based tool.

## Running it

Build your search in the browser first, then copy the URL from the address bar:

```bash
EXILIUM_POESESSID=<your cookie> exilium live "https://www.pathofexile.com/trade/search/Mirage/AbC123xyz"
```

```
Exilium live search — whispers are COPIED to your clipboard, never sent. Paste in game to contact the seller. Ctrl+C to stop.
watching Mirage/AbC123xyz (trade)
[2026-07-19T02:14:09Z] Mageblood Heavy Belt · 5 divine · seller SellerChar
  whisper (copied): @SellerChar Hi, I would like to buy your Mageblood Heavy Belt listed for 5 divine in Mirage ...
```

When a listing lands: desktop notification, the listing printed with price and seller, and GGG's own whisper text sitting on your clipboard. In game, that is one paste and Enter. You can watch several searches at once by passing more URLs; PoE2 `trade2` links work the same way.

If the socket drops (league restarts, network), Exilium reconnects after 30 seconds and keeps your already-seen listings deduplicated.

## Why it copies instead of sends

Sending the whisper for you would be automation, which GGG bans and which gets accounts flagged. A paste is a single user action, the same standard every accepted tool follows. The speed difference between auto-send and paste is a few hundred milliseconds; the difference in account risk is not worth it.

The same line applies further down: Exilium will never hail the seller, join the party, or move items. You do the trade. This tool just makes sure you are first to the whisper.

## Practical notes

GGG limits how many live searches one account can hold open (the browser has the same cap), so keep it to a handful. If you see 401 errors, your cookie expired; log in again and copy the fresh one. And the etiquette point that applies to every sniping tool: a whisper you send is a promise to show up. Sending twenty whispers you do not follow through on gets you ignored by sellers faster than any tool can help.
