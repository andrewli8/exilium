# Snipe catalog editor design

Date: 2026-08-09
Status: approved for implementation

## Goal

Make imported and manually added snipes easy to inspect and change from the
real `exilium` CLI. Provide both scriptable commands and an interactive editor
without rewriting or corrupting Better Trading extension exports.

## Commands

```text
exilium snipe list
exilium snipe add <trade-url> [--name NAME] [--max-buy PRICE] [--min-margin PCT]
exilium snipe edit
exilium snipe edit <id-or-label> [--name NAME] [--max-buy PRICE|none] [--min-margin PCT|none] [--enable|--disable]
exilium snipe remove <id-or-label>
exilium snipe import [--file FILE]
exilium snipe
```

Bare `snipe edit` is a readline-based interactive manager that works in macOS
Terminal, Windows Terminal, and PowerShell. It repeatedly prints the catalog
and offers add, edit, enable/disable, remove, import, and done actions. Invalid
input remains inside the manager with a useful error.

## Storage

Better Trading `.bt`, `.txt`, `.md`, and `.json` files remain untouched. A
hidden manifest at `<BetterTrading>/.exilium-snipes.json` stores:

```json
{
  "version": 1,
  "managed": [],
  "overrides": {
    "trade:9zRjda6KHK": {
      "label": "Cheap Sublime Vision",
      "maxBuy": { "amount": 20, "currency": "divine" },
      "minMarginPct": 15,
      "enabled": true
    }
  }
}
```

`managed` contains targets added directly through Exilium. `overrides` applies
to either imported or managed targets by stable `realm:searchId` key. Removing
an imported target writes `enabled: false`; removing an Exilium-managed target
deletes it. This makes a later re-import safe and reversible.

Manifest writes validate the complete next state, write a sibling temporary
file, and atomically rename it. Permissions are 0600. A malformed manifest is
reported and never overwritten automatically.

## Catalog resolution

The catalog loader reads ordinary Better Trading sources using the existing
parsers, appends managed targets, deduplicates by stable key, applies overrides,
and exposes both enabled and disabled rows. The runtime picker receives enabled
rows only. `snipe list` shows ID, enabled state, name, league, max buy, margin,
and source (`Better Trading` or `Exilium`). Selectors accept an exact search ID,
stable key, or unique case-insensitive label substring and preserve the current
ambiguous/unknown errors.

An extension export contains stable slugs but no league. Those targets continue
to use the current resolved league. Re-importing the same or updated folder
cannot erase Exilium labels, price rules, margin rules, or disabled state.

## Parsing rules

`--max-buy` accepts compact values such as `20div`, `20 divine`, `150c`, or
`150 chaos`; values must be positive. `none` clears an override. `--min-margin`
accepts a finite number or `none`. Add requires a Path of Exile trade URL,
including `/live` links; the saved identity is realm, league, and search ID.

## Safety and scope

- No command sends whispers, travels, opens Chrome, or starts network monitoring.
- Import remains local and does not require POESESSID.
- Removing imported data is reversible by enabling it again.
- The manifest never stores POESESSID or seller/listing data.
- Direct extension storage/LevelDB editing remains out of scope.
- Literal terminal mouse support remains out of scope.

## Testing

- Manifest creation, atomic update, permissions, and malformed-file safety.
- Overlay precedence, disable/re-enable, managed add/remove, and re-import merge.
- Compact price parsing and clearing rules.
- Scriptable CLI integration for list/add/edit/remove using the packaged bin.
- Interactive manager flow with injected answers and invalid-input retry.
- Runtime selection excludes disabled rows and includes enabled managed rows.
- Full test suite, TypeScript build, and `git diff --check`.
