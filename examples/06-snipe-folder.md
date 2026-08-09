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

## 2. Start the reusable Chrome profile

```powershell
exilium chrome
```

Log into pathofexile.com in that window and clear any human verification once.
Exilium attaches through the local CDP endpoint. It owns one page for the
session and leaves the Chrome process running when the console exits.

If Chrome is installed somewhere unusual, save `snipe.chromePath` in config or
set `EXILIUM_CHROME`. `exilium chrome --print` shows the command without
launching it.

## 3. Choose searches for this run

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
opens the first enabled search in its reusable Chrome tab and creates live
WebSockets only for the selected searches (up to 20).

For a non-interactive run, make the choice explicit:

```powershell
exilium snipe --all
exilium snipe --search AbC123xyz --search DeF456uvw
```

Search IDs are league-portable for PoE1. `--league Standard` overrides the
resolved challenge league; `--keep-league` trusts each source URL.

## 4. Act on live hits

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

If Chrome cannot be reached, the row becomes `FAILED` with the recovery command
`exilium chrome`; live hits continue to queue.

## 5. Margin and history

- `+10,000c (+25.0%)` means the local reference is 10,000 chaos above the ask.
- `STALE >10m` means reference refresh fell behind; reprice before committing.
- `no reference price` means the item cannot be valued from aggregate data.

Suppressed listings are logged with their reason. Queued hits and later travel
results are appended to `~/.exilium/snipes.jsonl`. Optional desktop, sound, and
structured webhook notifications contain status information; the interactive
console does not use a whisper/paste workflow.

## Windows verification checklist

1. `exilium chrome` opens the dedicated profile.
2. The imported extension searches appear in the picker.
3. Enabling a subset opens the first selected search in one Chrome tab.
4. A hit appears as `NEW` without browser navigation or travel.
5. Enter on that row performs one Travel to Hideout click.
6. A second hit reuses the same tab.
7. `q` leaves Chrome running and closes Exilium's owned page.
