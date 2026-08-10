# Snipe Catalog Editor Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add safe interactive and scriptable management for Better Trading and Exilium-owned snipes while preserving extension exports.

**Architecture:** Add a hidden validated manifest containing Exilium-managed targets and per-search overrides. A catalog module merges that manifest over existing Better Trading sources; CLI subcommands mutate only the manifest, while bare `exilium snipe` consumes the enabled resolved catalog.

**Tech Stack:** TypeScript 7, Node.js 20+, Zod 4, readline/promises, Vitest 4.

## Global Constraints

- Never rewrite Better Trading source/export files from add/edit/remove operations.
- Write `<folder>/.exilium-snipes.json` atomically with mode 0600 and complete Zod validation.
- A malformed existing manifest must fail visibly and must not be overwritten.
- Commands do not require Chrome or POESESSID and do not start monitoring.
- Runtime monitoring receives only enabled targets; list/edit receives enabled and disabled targets.
- Selectors accept exact ID, stable key, or unique case-insensitive label substring.
- Every production change follows a witnessed RED to GREEN test cycle.

---

### Task 1: Manifest-backed catalog model

**Files:**
- Create: `src/snipe/catalog.ts`
- Create: `tests/snipe-catalog.test.ts`
- Modify: `src/snipe/run.ts`

**Interfaces:**
- Produces: `CatalogEntry`, `SnipeManifest`, `loadSnipeCatalog(folder, warn)`, `saveSnipeManifest(folder, manifest)`, `targetKey(target)`, `resolveCatalogEntry(entries, selector)`.

- [ ] Write failing tests for imported-only catalog loading, managed targets, override precedence, disable/re-enable, managed deletion, ambiguous selectors, 0600 mode, atomic replacement, and malformed-manifest preservation.
- [ ] Run `npx vitest run tests/snipe-catalog.test.ts` and witness RED because the module is absent.
- [ ] Implement Zod schemas, hidden manifest loading, raw-source merge, stable-key dedupe, override application, selector resolution, and atomic save using a same-directory temporary file plus rename.
- [ ] Run the catalog tests and witness GREEN.
- [ ] Write a failing orchestration test showing a disabled imported target is absent from runtime selection and an enabled managed target is present.
- [ ] Replace direct `loadSnipeFolder(readSnipeFolderFiles(folder))` calls in `run.ts` with enabled targets from `loadSnipeCatalog` and witness GREEN.
- [ ] Commit with `git commit -m "feat: add manifest-backed snipe catalog"`.

### Task 2: Scriptable catalog commands

**Files:**
- Create: `src/snipe/manage.ts`
- Create: `tests/snipe-manage.test.ts`
- Modify: `src/cli.ts`
- Modify: `tests/cli-integration.test.ts`

**Interfaces:**
- Produces: `parseMaxBuy(raw)`, `addSnipe(input)`, `editSnipe(input)`, `removeSnipe(input)`, `formatSnipeCatalog(entries)`.
- Consumes: catalog load/save and existing `parseTradeUrl`.

- [ ] Write failing unit tests for `20div`, `20 divine`, `150c`, invalid/nonpositive prices, add from a `/live` URL, duplicate add as an enable/update, edit/clear fields, reversible imported removal, and permanent managed removal.
- [ ] Run `npx vitest run tests/snipe-manage.test.ts` and witness RED.
- [ ] Implement pure command operations that calculate and atomically save the next manifest.
- [ ] Run unit tests and witness GREEN.
- [ ] Write failing CLI integration tests invoking `node bin/exilium.js` with an isolated `EXILIUM_BETTERTRADING` folder for add, list, edit, disable/enable, and remove.
- [ ] Route `snipe list/add/edit/remove` before `runSnipe`; parse flags without requiring POESESSID; update help output; witness CLI integration GREEN.
- [ ] Commit with `git commit -m "feat: manage snipes from the CLI"`.

### Task 3: Interactive editor and documentation

**Files:**
- Modify: `src/snipe/manage.ts`
- Modify: `src/cli.ts`
- Modify: `tests/snipe-manage.test.ts`
- Modify: `README.md`
- Modify: `examples/06-snipe-folder.md`

**Interfaces:**
- Produces: `runInteractiveSnipeEditor(deps)` with injected `question`, output, and catalog operations for deterministic testing.

- [ ] Write a failing interaction test that lists rows, retries an invalid action, edits a label/margin, disables an imported row, adds a `/live` URL, and exits.
- [ ] Implement the readline action loop with add/edit/toggle/remove/import/done choices; keep errors inside the loop.
- [ ] Route bare `snipe edit` to the manager and `snipe edit <selector>` to scriptable flags.
- [ ] Update README/example with macOS and PowerShell commands, manifest behavior, and current headless monitoring flow.
- [ ] Run focused tests, `npm test`, `npm run build`, and `git diff --check`; all must exit 0.
- [ ] Commit with `git commit -m "feat: add interactive snipe editor"`.
