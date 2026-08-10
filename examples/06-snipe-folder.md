# Interactive Better Trading snipe console

`exilium snipe` loads searches from a Better Trading folder, asks which ones
to enable for this run, and puts qualifying live listings in a terminal queue.
It needs your POESESSID (`exilium setup`) for the authenticated live-search
WebSockets.

## 1. Import the extension folder

In Better Trading, export a folder and copy its `2:...` or `3:...` string.
Then either paste it:

```powershell
exilium snipe import
```

or import a saved export file:

```powershell
exilium snipe import --file "$HOME\Downloads\better-trading.bt"
```

The validated source is saved under the configured Better Trading directory.
You can instead point `EXILIUM_BETTERTRADING` or `--folder` at a directory of
`.bt`, `.txt`, `.md`, or `.json` sources. A plain source may contain trade URLs;
structured JSON can add `maxBuy` or `minMarginPct` per search.

## 2. Choose searches and monitor headlessly

```powershell
exilium snipe --min-margin 15
```

The picker starts with nothing selected:

- Up/Down moves.
- Space or `1`–`9` toggles a search.
- `a` toggles all searches.
- Enter enables the selected searches.
- Escape cancels.

This selection is deliberately not written to config. After Enter, Exilium
creates live WebSockets only for the selected searches (up to 20); it does not
open Chrome or create browser tabs. In a rate-limited background sequence it
also loads up to ten current results per selected search using your locally
saved POESESSID. Those current results seed the queue quietly. Listings that
arrive afterward through the WebSockets produce notifications.

For a non-interactive run, make the choice explicit:

```powershell
exilium snipe --all
exilium snipe --search AbC123xyz --search DeF456uvw
```

Search IDs are league-portable for PoE1. `--league Standard` overrides the
resolved challenge league; `--keep-league` trusts each source URL.

The trade-search endpoints used by the website are not in GGG's supported API
reference and may change. Exilium observes the dynamic account/IP rate-limit
headers and waits when needed; six imports are never polled simultaneously.

## 3. Act on queue entries

New hits appear as `NEW` queue rows with search label, item, price, margin,
freshness, seller, and age. New arrivals do not move your current selection.

- Up/Down selects a row.
- Enter clicks **Travel to Hideout** for that row.
- `r` retries a `FAILED` row.
- `d` dismisses a row.
- `q` exits and closes only Exilium's page.

An arrival only queues and notifies. It does not navigate the browser, click,
send a whisper, or copy a whisper. Enter navigates the same owned page to the
search, finds the matching listing row, reloads once for indexing lag, and
clicks its Travel to Hideout button once. The row becomes `TRAVELED` only after
that click succeeds.

Chrome is contacted for the first time only after Enter. If it cannot be
reached, the row becomes `FAILED` with the recovery command `exilium chrome`;
headless live hits continue to queue.

Start the reusable profile in another terminal only when you want to travel:

```powershell
exilium chrome
```

Log into pathofexile.com in that window and clear any human verification once.
Exilium attaches through the local CDP endpoint and owns one action page. It
leaves the Chrome process running when the console exits. If Chrome is installed
somewhere unusual, save `snipe.chromePath` in config or set `EXILIUM_CHROME`;
`exilium chrome --print` shows the launch command without starting it.

## 4. Margin and history

- `+10,000c (+25.0%)` means the local reference is 10,000 chaos above the ask.
- `STALE >10m` means reference refresh fell behind; reprice before committing.
- `no reference price` means the item cannot be valued from aggregate data.

Suppressed listings are logged with their reason. Queued hits and later travel
results are appended to `~/.exilium/snipes.jsonl`. Optional desktop, sound, and
structured webhook notifications contain status information; the interactive
console does not use a whisper/paste workflow.

## Windows verification checklist

1. The imported extension searches appear in the picker.
2. Enabling a subset starts sockets and seeds queue rows with no Chrome process.
3. A new hit appears as `NEW` and produces a notification without navigation.
4. Enter without Chrome marks only that row `FAILED` and monitoring continues.
5. `exilium chrome` opens the dedicated profile; retry performs one Travel to Hideout click.
6. A second Enter action reuses the same action tab.
7. `q` leaves Chrome running and closes only Exilium's owned page.
