/** Live end-to-end exercise of the snipe pipeline against the real trade
 * site, driven by the user's own BetterTrading folder and session cookie.
 *
 *   exilium chrome
 *   npx tsx scripts/e2e-snipe.ts [--target mageblood] [--listen 90] [--click]
 *
 * What it verifies, in order:
 *   1. The BetterTrading folder decodes and the chosen target exists.
 *   2. Reference prices ingest fresh from poe.ninja (targeted categories).
 *   3. One owned page in the configured debug Chrome loads the enabled
 *      search; rows carry data-id and expose "Travel to Hideout".
 *   4. Real listings run the full pipeline: fetch → margin → decide → alert.
 *   5. --listen N: every folder search holds a live websocket for N seconds;
 *      any listing that arrives is alerted through the same pipeline.
 *   6. --click (opt-in, WARNING): actually clicks Travel to Hideout on the
 *      first row — your character travels if you are in game.
 *
 * Read-only against your account except --click. The page is closed at the
 * end while the user's Chrome process remains running. */

import { homedir } from 'node:os';
import { join } from 'node:path';
import { readFileSync } from 'node:fs';
import { loadConfig, readFileConfig, configFilePath } from '../src/config.js';
import { createDb } from '../src/storage/db.js';
import { SnapshotRepository } from '../src/storage/snapshot-repository.js';
import { NinjaClient } from '../src/sources/ninja/client.js';
import { ingestLeague } from '../src/ingest/ingest.js';
import { loadSnipeFolder, readSnipeFolderFiles, resolveSnipeFolder } from '../src/snipe/bettertrading.js';
import { resolveSnipeLeague } from '../src/snipe/league.js';
import { buildSearchPageUrl, decideSnipe, formatAlert } from '../src/snipe/engine.js';
import { assessMargin } from '../src/snipe/margin.js';
import { rowSelector } from '../src/snipe/travel.js';
import { buildLiveWsUrl, fetchListings, type TradeSearch } from '../src/trade/live-search.js';

const args = process.argv.slice(2);
const flag = (name: string): string | undefined => {
  const i = args.indexOf(name);
  return i === -1 ? undefined : args[i + 1];
};
const targetQuery = flag('--target') ?? 'mageblood';
const listenSec = Number(flag('--listen') ?? 0);
const doClick = args.includes('--click');
/** Comma-separated listing ids to pipeline-test directly, skipping the
 * browser (useful when listing ids were collected from a real session). */
const directIds = (flag('--ids') ?? '').split(',').filter((s) => s !== '');

const checks: Array<{ name: string; ok: boolean; detail: string }> = [];
const check = (name: string, ok: boolean, detail: string): void => {
  checks.push({ name, ok, detail });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name} — ${detail}`);
};

const config = loadConfig(process.env, readFileConfig(configFilePath(process.env), (p) => readFileSync(p, 'utf8')));
if (config.poesessid === undefined || config.poesessid === '') {
  console.error('No POESESSID configured (exilium setup) — the e2e needs your session.');
  process.exit(2);
}
const sessionId = config.poesessid;
const UA = config.userAgent;

// ── 1. Folder ────────────────────────────────────────────────────────────
const folder = resolveSnipeFolder({ flagValue: config.snipe.folder, cwd: process.cwd(), home: homedir() });
const targets = loadSnipeFolder(readSnipeFolderFiles(folder), (m) => console.error(`  warn: ${m}`));
check('folder decodes', targets.length > 0, `${targets.length} searches from ${folder}`);
const target = targets.find((t) => t.label.toLowerCase().includes(targetQuery.toLowerCase()));
if (target === undefined) {
  check('target found', false, `no target label contains "${targetQuery}"`);
  process.exit(1);
}
check('target found', true, `${target.label} → ${target.searchId}`);

const league = await resolveSnipeLeague(config, undefined, (m) => console.error(`  ${m}`));
check('league resolved', league === 'Allflame', league);
const search: TradeSearch = { realm: target.realm, league, searchId: target.searchId };
const searchUrl = buildSearchPageUrl(target, league);

// ── 2. Fresh reference prices (targeted categories, one forced sweep) ────
const db = createDb(config.dbPath);
const repo = new SnapshotRepository(db);
const E2E_CATEGORIES = ['Currency', 'ValdoMap', 'UniqueAccessory', 'UniqueArmour', 'UniqueFlask', 'UniqueJewel', 'ForbiddenJewel', 'DivinationCard'] as const;
const specs = config.categories.filter((c) => (E2E_CATEGORIES as readonly string[]).includes(c.name));
const ninja = new NinjaClient({ userAgent: UA });
const ingested = await ingestLeague(ninja, repo, {
  game: config.game,
  league,
  categories: specs,
  now: () => new Date().toISOString(),
  minIntervalSec: 0,
  itemsMinIntervalSec: 0,
});
check('reference prices fresh', ingested.saved.length >= specs.length - 1, `ingested ${ingested.saved.join(', ') || 'nothing'}${ingested.errors.length > 0 ? ` (errors: ${ingested.errors.map((e) => e.category).join(', ')})` : ''}`);
const snapshots = repo.latestAll(config.game, league);

// ── 3. Real browser: rows + Travel button ────────────────────────────────
if (directIds.length > 0) {
  const listings = await fetchListings(directIds, search, sessionId, { fetchFn: (url, init) => fetch(url, init) });
  let ok = false;
  for (const listing of listings) {
    const decision = decideSnipe({
      listing,
      target,
      assessment: assessMargin({ itemName: listing.referenceName, price: listing.price, snapshots, nowMs: Date.now() }),
      snapshots,
      globalMinMarginPct: null,
      league,
      seen: new Set(),
    });
    if (decision.kind === 'alert') {
      ok = true;
      console.log(`  ALERT ${formatAlert(decision.alert).line}`);
    } else {
      console.log(`  suppressed: ${decision.reason}`);
    }
  }
  check('pipeline on provided ids', ok, `${listings.length}/${directIds.length} listings fetched, margined, decided`);
  const failedDirect = checks.filter((c) => !c.ok);
  console.log(`\n${failedDirect.length === 0 ? 'ALL CHECKS PASSED' : `${failedDirect.length} CHECK(S) FAILED`} (${checks.length} total)`);
  process.exit(failedDirect.length === 0 ? 0 : 1);
}
const { chromium } = await import('playwright');
const browser = await chromium.connectOverCDP(config.snipe.chromeCdpUrl, {
  timeout: 5_000,
}).catch((error: unknown) => {
  throw new Error(`Could not attach to ${config.snipe.chromeCdpUrl}: ${error instanceof Error ? error.message : String(error)}. Run \`exilium chrome\`, log in, and retry.`);
});
const context = browser.contexts()[0];
if (context === undefined) throw new Error('Attached Chrome has no browser context.');
const page = await context.newPage();
await page.goto(searchUrl, { waitUntil: 'domcontentloaded' });
// Cloudflare may challenge fresh automation profiles. That checkbox is for a
// human — this script never clicks it. Headed, we wait for the human (or for
// the challenge to clear on its own); headless, we report and move on.
const challenged = await page
  .locator('text=/security verification|verify you are human/i')
  .first()
  .isVisible()
  .catch(() => false);
if (challenged) {
  console.log('  Cloudflare challenge shown — clear it in the Chrome window; waiting up to 90s…');
  await page.waitForSelector('.row[data-id]', { timeout: 90_000 }).catch(() => undefined);
}
let listingIds: string[] = [];
try {
  await page.waitForSelector('.row[data-id]', { timeout: 20_000 });
  listingIds = await page.$$eval('.row[data-id]', (rows) => rows.slice(0, 5).map((r) => r.getAttribute('data-id') ?? ''));
} catch {
  // fall through — check records the failure
}
check('search rows render', listingIds.length > 0, `${listingIds.length} rows with data-id at ${searchUrl}`);

let travelOk = false;
let travelDetail = 'no rows';
if (listingIds[0] !== undefined && listingIds[0] !== '') {
  const row = rowSelector(listingIds[0]);
  const btn = page.locator(`${row} button.direct-btn`);
  const count = await btn.count();
  travelOk = count > 0 && /travel to hideout/i.test((await btn.first().innerText().catch(() => '')) ?? '');
  travelDetail = travelOk ? `button.direct-btn present on row ${listingIds[0].slice(0, 12)}…` : `direct-btn count=${count}`;
}
check('Travel to Hideout button', travelOk, travelDetail);
const shot = join(homedir(), '.exilium', 'e2e-snipe.png');
await page.screenshot({ path: shot, fullPage: false }).catch(() => undefined);
console.log(`  screenshot: ${shot}`);

// ── 4. Full pipeline on real listings ────────────────────────────────────
const realIds = listingIds.filter((id) => id !== '').slice(0, 3);
let pipelineOk = false;
if (realIds.length > 0) {
  const listings = await fetchListings(realIds, search, sessionId, { fetchFn: (url, init) => fetch(url, init) });
  for (const listing of listings) {
    const decision = decideSnipe({
      listing,
      target,
      assessment: assessMargin({ itemName: listing.referenceName, price: listing.price, snapshots, nowMs: Date.now() }),
      snapshots,
      globalMinMarginPct: null,
      league,
      seen: new Set(),
    });
    if (decision.kind === 'alert') {
      pipelineOk = true;
      console.log(`  ALERT ${formatAlert(decision.alert).line}`);
    } else {
      console.log(`  suppressed: ${decision.reason}`);
    }
  }
}
check('pipeline produces alerts from real listings', pipelineOk, `${realIds.length} listings fetched and priced`);

// ── 5. Optional live listen across the whole folder ──────────────────────
if (listenSec > 0) {
  const { default: WebSocket } = await import('ws');
  let opened = 0;
  let alerts = 0;
  const sockets = targets.slice(0, 20).map((t, i) => {
    const s: TradeSearch = { realm: t.realm, league, searchId: t.searchId };
    return new Promise<void>((resolve) => {
      setTimeout(() => {
        const ws = new WebSocket(buildLiveWsUrl(s), {
          headers: { Cookie: `POESESSID=${sessionId}`, 'User-Agent': UA, Origin: 'https://www.pathofexile.com' },
        });
        ws.on('open', () => {
          opened += 1;
          resolve();
        });
        ws.on('message', (data: Buffer) => {
          void (async () => {
            const msg = JSON.parse(data.toString()) as { new?: string[] };
            if (!msg.new?.length) return;
            const ls = await fetchListings(msg.new, s, sessionId, { fetchFn: (url, init) => fetch(url, init) });
            for (const l of ls) {
              alerts += 1;
              const d = decideSnipe({ listing: l, target: t, assessment: assessMargin({ itemName: l.referenceName, price: l.price, snapshots, nowMs: Date.now() }), snapshots, globalMinMarginPct: null, league, seen: new Set() });
              console.log(`  LIVE [${t.label}] ${d.kind === 'alert' ? formatAlert(d.alert).line : d.reason}`);
            }
          })();
        });
        ws.on('error', (e: Error) => {
          console.error(`  ws error [${t.label}]: ${e.message}`);
          resolve();
        });
        setTimeout(resolve, 15_000);
      }, i * 500);
    });
  });
  await Promise.all(sockets);
  console.log(`  listening ${listenSec}s across ${targets.length} searches (${opened} sockets open)…`);
  await new Promise((r) => setTimeout(r, listenSec * 1000));
  check('live sockets connect', opened >= Math.min(targets.length, 20) * 0.9, `${opened}/${Math.min(targets.length, 20)} open, ${alerts} live listings seen (quiet searches are normal)`);
}

// ── 6. Opt-in real click ─────────────────────────────────────────────────
if (doClick && listingIds[0] !== undefined && listingIds[0] !== '') {
  console.log('  WARNING: clicking Travel to Hideout for real in 3s — Ctrl+C to abort');
  await new Promise((r) => setTimeout(r, 3000));
  await page.locator(`${rowSelector(listingIds[0])} button.direct-btn`).first().click();
  await new Promise((r) => setTimeout(r, 2000));
  const toast = await page.locator('.toast, .toast-message, [class*="toastr"]').first().innerText().catch(() => '(no toast)');
  console.log(`  click result toast: ${toast}`);
}

await page.close().catch(() => undefined);
// For a CDP attachment Playwright's browser.close() disconnects this client;
// it does not terminate the Chrome process launched by the user.
await browser.close().catch(() => undefined);
const failed = checks.filter((c) => !c.ok);
console.log(`\n${failed.length === 0 ? 'ALL CHECKS PASSED' : `${failed.length} CHECK(S) FAILED`} (${checks.length} total)`);
process.exit(failed.length === 0 ? 0 : 1);
