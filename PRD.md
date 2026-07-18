# Exilium — PoE Trading Terminal with Agent-Native MCP
**Version:** 2.1 · **Date:** 2026-07-18 · **Status:** ✅ APPROVED (GO, with conditions — see §12)
**Changelog v2:** Rebuilt signal thesis around durable edges (arch review C1); purged server-side POESESSID/trade-site sampling (C2, C3); gold fees modeled (C4); "MCP never touches upstream" invariant (C5); P0 shrunk to Postgres monolith (H1); GGG approval as week-1 gating milestone (H2); `price_item` scoped to currency/stackables (H3); source-adapter layer + poe.ninja outreach (H4); platform components added (H5); MCP surface tightened (M2).

## 1. Problem & Opportunity

Path of Exile (1 & 2) has one of the deepest player-driven economies in gaming, but tooling is fragmented: price checks (Awakened PoE Trade / Exiled Exchange 2), dashboards (poe.ninja, POE2 Scout), bulk trading (TFT Discord), and the official trade site are silos. No product offers a **terminal-grade view** (spreads, momentum, watchlists, alerts) — and none is **agent-native**: no way for an AI agent to watch the market, detect opportunities, and prepare trades for a human to execute.

**Exilium** is a market terminal for the PoE economy whose full feature surface is also an **MCP server**, making AI agents first-class users.

## 2. Design Anchors (non-negotiable)

1. **Human-in-the-loop execution.** No API exists to execute trades and GGG prohibits automation. Agents scan, price, detect, rank, draft, alert; the human trades in-game. This is the compliance moat, stated in the product and in every MCP tool description.
2. **Durable edges, not latency races.** Our freshest data is minutes old (poe.ninja current snapshots) and our history is hourly (official Currency Exchange digests). We therefore target **structural inefficiencies that persist for hours**, not tick-level arbitrage — see §5.
3. **MCP never touches upstream.** Agent/API calls serve only pre-ingested, cached data. Ingestion cadence is owned exclusively by pollers behind a quota governor. Agents can never spend our GGG quota.
4. **No POESESSID server-side, ever.** Any trade-site interaction is client-side in a later-phase desktop companion (Awakened-PoE-Trade-style, user's own local session), or not at all.

## 3. Users

1. **Economy players / flippers** — spreads, momentum, alerts, opportunity feed.
2. **AI-agent power users** — codify strategies against our MCP.
3. **Regular players** — "what's this worth", stash valuation (P1).

## 4. Data Sources (verified, July 2026)

| Source | What | Freshness | Access & risk posture |
|---|---|---|---|
| GGG `GET /currency-exchange/poe2` (OAuth 2.1) | Hourly aggregate digests: per-market volume, stock, lowest/highest ratio. **Historical only.** | 1h | Registered app; dynamic rate limits with `Retry-After`. **Week-1 gating task: submit app for approval; verify commercial-use terms.** Fallback mode: community sources only. |
| poe.ninja API (incl. `…/economy/exchange/current/overview`) | Current exchange ratios, item/currency overviews, sparklines (PoE1+2) | ~min | Community-run, no SLA. ≥5-min caching, adapter-isolated, maintainer outreach before launch. |
| POE2 Scout API | PoE2 item/currency economy | ~min | Same posture as ninja; redundant adapter. |
| GGG public stash river (PoE1, `service:psapi` scope, ~5-min delay) | All public stashes stream | ~5 min | **Requires GGG service-application approval — P2, not assumed.** |
| Client.txt log tail | Whispers, zone events | real-time | Local-only, explicitly permitted. P2 desktop companion. |

All sources sit behind a **source-adapter interface** (swappable, per-source health/staleness surfaced in UI and MCP responses).

## 5. Signal Engine — durable-edge detectors

Every signal carries: expected edge (**gold-fee- and gold-opportunity-cost-adjusted**), confidence, data freshness, and a **prepared action plan** for the human.

**P0 detectors (persist for hours; survive slow data + human latency):**
- **Bulk ↔ single spread:** in-game Currency Exchange bulk ratio vs single-listing pricing gaps that persist across snapshots. *Week 1–2 validation gate: confirm community listing-derived aggregates (ninja/Scout) give sufficient coverage/freshness for the "single" leg; if not, card-set EV becomes the lead detector.*
- **Divination card set EV:** card-set completion cost vs redeemed-item market value.

**Stretch / P1 detectors:**
- **Cross-source divergence:** sustained ratio disagreement between exchange digests and listing-based prices.
- **Mean-reversion flags:** post-league-start normalization curves; items far off historical league-week trajectory.

**Experimental (research tab, clearly labeled, not in headline metrics):**
- Triangular ratio cycles from current-snapshot data — surfaced with staleness warnings; used to gather fill-reality data, not sold as an edge.

**Deferred:** fill-likelihood model and backtesting (need ≥1 full league of ingested history — collection starts day 1, features ship P1/P2).

## 6. MCP Server (the differentiator)

Thin adapter over the Core API — same engine as the web UI, cached data only.

**P0 tools (~8):**
- `get_leagues()` — leagues, realms, economy phase (discovery/meta).
- `get_market_snapshot(league)` — top movers, spreads, volumes.
- `get_pair_history(pair, league, window)` — ratio history (official digests + snapshot interpolation).
- `price_item(name | stackable)` — **currency, fragments, stackables, unique-by-name only in P0**; rare-item mod-based valuation explicitly deferred (it's a multi-month subsystem).
- `find_opportunities(league, detector?, min_edge_pct?)` — current durable-edge signals with full edge math.
- `create_watch(rule, idempotency_key)` / `list_watches()` / `delete_watch(id)` — persistent server-side rules; results via webhook **or** `poll_watch_results(cursor)` for agents without endpoints.
- `draft_trade_plan(opportunity_id)` — ordered human-executable steps: quantities, ratios, gold fees, expected P&L, whisper text where applicable. Never sends anything.

**Design details (from review):**
- Compact response schemas — trimmed payloads, never raw PoE item JSON.
- MCP tool annotations (`readOnlyHint` etc.); every description states the human-executes rule.
- Per-user API keys, tool-level scopes (read / strategy / notify), per-key rate budgets; remaining-budget metadata returned in responses so agents self-throttle.
- Transport: streamable HTTP (+ stdio for local dev).

## 7. System Architecture

**P0 — modular monolith** (Go or TypeScript), sized to real volume (a few pollers at 5–60 min cadence ≈ single-digit events/sec):

```
   GGG OAuth API ──┐   (hourly digest poller)
   poe.ninja ──────┼─▶ Ingestion module ─▶ Postgres (+ Timescale ext)
   POE2 Scout ─────┘      │  quota governor:            │
                          │  token-bucket per upstream, │
                          │  Retry-After honoring,      │
                          │  429 telemetry (P0 dash)    │
                          ▼                              ▼
                   Signal Engine module ◀── league-scoped tables
                   (durable-edge detectors,     (league_id everywhere,
                    watch evaluator)             archival per league)
                          │
                          ▼  LISTEN/NOTIFY + pg-boss jobs
                   ┌──────┴────────┐
                   │   Core API    │  (REST + WebSocket; app auth = its own
                   └──┬─────────┬──┘   identity system, separate from GGG OAuth)
                      │         │
              ┌───────▼──┐   ┌──▼──────────────┐
              │ Web App  │   │ MCP Server      │──▶ AI agents ──▶ prepared plans
              │ Next.js  │   │ (cached data    │                    │
              │ terminal │   │  ONLY — never   │                    ▼
              │ UI       │   │  upstream)      │            Human executes in-game
              └──────────┘   └─────────────────┘
   Alerts: watch evaluator ─▶ Discord webhook / web push
```

**Platform components (P0):** app-level user auth + API-key management UI; observability with **rate-limit telemetry as the flagship dashboard** (429s / Retry-After per upstream = existential metric); league lifecycle runbook (economies reset every ~3–4 months: league_id on every table, league-start checklist, cadence dry-run before launch); raw-payload retention for replay/backfill of the signal store.

**Evolution triggers (documented, not built):** PoE1 stash river lands (P2, multi-GB/day) → extract ingestion into services + add NATS/Redis; WebSocket fanout beyond single-node capacity → Redis pub/sub.

**League-start surge:** 10–100× load and peak trader attention; infra headroom and cadence configs planned around league launches.

## 8. Compliance Posture
- OAuth 2.1 for all account data; explicit scopes; **no POESESSID touches our servers, ever**.
- No trade execution, no in-game automation, no memory reading, no game-file interaction.
- Registered GGG application (week-1 submission) with proper `User-Agent` and contact; **commercial-use terms verified with GGG before any paid tier ships**.
- "Deal finder" naming (not "snipe") for any future listing-based feature; alert rate limits.
- MCP tool descriptions carry the human-executes rule so agents represent the product accurately.

## 9. Risks
| Risk | Mitigation |
|---|---|
| GGG app not approved / access revoked | Week-1 submission with product description; degrade to community-source-only mode; 429 telemetry keeps citizenship provable |
| poe.ninja/Scout change or block us | Adapter isolation, aggressive caching, maintainer outreach, official digests as backbone |
| Durable edges thinner than modeled | Gold-fee-adjusted math from day 1; experimental tab gathers fill-reality data before claims |
| Agent abuse (watch spam, quota burn) | Per-key budgets, watch caps, idempotency keys |
| Community backlash | No auto-anything; analytics positioning; human-executes stance is public |

## 10. Roadmap
- **P0 (6 wks, 1–2 eng):** PoE2 only. Official digest + ninja/Scout ingestion behind adapters; quota governor + 429 dashboard; pair dashboards + ratio charts; bulk-vs-single & card-set-EV detectors (two detectors, per approval condition 1); watches + Discord/webhook alerts; MCP with the 8 tools above; app auth + API keys; league runbook. **Week 1: GGG app submission. End of week 2: log GGG response as explicit checkpoint; if silent/denied, re-scope P1 billing assumptions then.** UI stays lean (charts + tables) — UI polish is the schedule's cut line, never the MCP or quota governor.
- **P1:** OAuth stash valuation + mark-to-market; mean-reversion detector hardening; `poll_watch_results` cursoring at scale; fill-reality reporting; billing (pending GGG commercial-terms confirmation).
- **P2:** PoE1 stash river (if service scope granted) → ingestion service split; desktop companion (client-side price check, whisper board, single-keypress reply); rare-item valuation; backtesting on accumulated history.

## 11. Success Metrics (proxies, labeled as such)
- Terminal WAU; active MCP keys; watch count & webhook delivery success.
- **Proxy for realized value:** trade-plan marked-done rate, whisper-copy rate (true realized edge unmeasurable without trade confirmation — stated honestly).
- Upstream health: 429 rate ≈ 0; data staleness SLOs per source.

## 12. Approval Record

- **Architect review (v1):** 5 critical, 5 high, 5 medium findings — all critical/high resolved in v2 (arb thesis rebuilt on durable edges; POESESSID purged server-side; listing sampler cut; gold fees modeled; MCP-never-touches-upstream invariant; monolith P0; GGG approval gated; `price_item` scoped; source adapters; platform components added).
- **Approver verdict (v2): GO**, with non-blocking conditions, all incorporated:
  1. P0 ships exactly two detectors (bulk↔single, card-set EV); divergence & mean-reversion moved to stretch/P1. ✅ §5
  2. Week 1–2 validation gate on the bulk↔single "single-leg" data path. ✅ §5
  3. UI is the schedule flex zone; MCP + quota governor are never cut. ✅ §10
  4. GGG approval checkpoint at end of week 2 drives P1 billing re-scope. ✅ §10
