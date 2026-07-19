/** Known-answer evals for the signal detectors.
 *
 * Unlike unit tests, these measure detection quality (precision/recall/edge
 * accuracy) against planted ground truth, plus a consistency check over the
 * real local database. Deterministic: seeded noise, no Date.now in scoring.
 * Exit code 1 on any failure so this can gate CI.
 */
import { detectCrossRateDivergence } from '../src/signals/cross-rate.js';
import { detectMeanReversion } from '../src/signals/mean-reversion.js';
import { ExiliumService } from '../src/mcp/service.js';
import { createDb } from '../src/storage/db.js';
import { SnapshotRepository } from '../src/storage/snapshot-repository.js';
import { loadConfig } from '../src/config.js';
import type { MarketLine, MarketSnapshot } from '../src/domain/types.js';

// Deterministic PRNG (mulberry32) so evals never flake.
function rng(seed: number): () => number {
  let a = seed;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

interface EvalResult {
  readonly name: string;
  readonly pass: boolean;
  readonly detail: string;
}

const PER_DIVINE = 720; // chaos per divine in the synthetic market
const results: EvalResult[] = [];

function report(name: string, pass: boolean, detail: string): void {
  results.push({ name, pass, detail });
  console.log(`${pass ? 'PASS' : 'FAIL'}  ${name}  ${detail}`);
}

// ---------------------------------------------------------------------------
// Eval 1: cross-rate divergence on planted ground truth
// ---------------------------------------------------------------------------
function crossRateEval(): void {
  const random = rng(42);
  const plantedGaps = [0.04, 0.05, 0.06, 0.08, 0.1, 0.12, 0.13, 0.15];
  const lines: MarketLine[] = [];
  const planted = new Map<string, number>();

  for (let i = 0; i < 40; i++) {
    const listed = 1 + random() * 999; // chaos price
    const isPlanted = i < plantedGaps.length;
    const gap = isPlanted ? plantedGaps[i]! : (random() - 0.5) * 0.006; // clean: ±0.3% noise
    // implied = listed * (1 + gap)  =>  rate chosen to produce that implied price
    const implied = listed * (1 + gap);
    const ratePerDivine = 1 / (implied / PER_DIVINE); // items per divine
    const id = isPlanted ? `planted-${i}` : `clean-${i}`;
    if (isPlanted) planted.set(id, Math.abs(1 - implied / listed));
    lines.push({
      itemId: id,
      name: id,
      category: 'Currency',
      primaryValue: listed,
      volumePrimaryValue: 5000,
      maxVolumeCurrency: 'divine',
      maxVolumeRate: ratePerDivine,
      sparkline: [],
      totalChange: 0,
    });
  }

  const snapshot: MarketSnapshot = {
    game: 'poe1',
    league: 'Eval',
    category: 'Currency',
    fetchedAt: '2026-01-01T00:00:00Z',
    core: { primary: 'chaos', perPrimary: { chaos: 1, divine: 1 / PER_DIVINE } },
    lines,
  };

  const found = detectCrossRateDivergence(snapshot, { minDivergence: 0.03, minVolume: 100 });
  const foundIds = new Set(found.map((o) => o.itemId));
  const truePositives = [...planted.keys()].filter((id) => foundIds.has(id));
  const falsePositives = found.filter((o) => !planted.has(o.itemId));
  const precision = found.length === 0 ? 0 : truePositives.length / found.length;
  const recall = truePositives.length / planted.size;

  const edgeErrors = found
    .filter((o) => planted.has(o.itemId))
    .map((o) => Math.abs(o.edge - planted.get(o.itemId)!));
  const maxEdgeError = edgeErrors.length === 0 ? Infinity : Math.max(...edgeErrors);

  report(
    'cross-rate: precision',
    precision === 1,
    `${precision.toFixed(3)} (${falsePositives.length} false positives of ${found.length} flagged)`,
  );
  report('cross-rate: recall', recall === 1, `${recall.toFixed(3)} (${truePositives.length}/${planted.size} planted gaps found)`);
  report('cross-rate: edge accuracy', maxEdgeError < 0.005, `max |reported − planted| = ${maxEdgeError.toFixed(5)} (tolerance 0.005)`);
}

// ---------------------------------------------------------------------------
// Eval 2: mean reversion on planted spikes
// ---------------------------------------------------------------------------
function meanReversionEval(): void {
  const random = rng(7);
  const lines: MarketLine[] = [];
  const plantedIds = new Set<string>();

  for (let i = 0; i < 36; i++) {
    const isPlanted = i < 6;
    const window = Array.from({ length: 6 }, () => (random() - 0.5) * 4); // quiet ±2% days
    const latest = isPlanted
      ? 60 + random() * 60 // violent planted spike
      : (random() - 0.5) * 4; // another quiet day
    const id = isPlanted ? `spike-${i}` : `quiet-${i}`;
    if (isPlanted) plantedIds.add(id);
    lines.push({
      itemId: id,
      name: id,
      category: 'Currency',
      primaryValue: 10,
      volumePrimaryValue: 5000,
      maxVolumeCurrency: null,
      maxVolumeRate: null,
      sparkline: [...window, latest],
      totalChange: latest,
    });
  }

  const snapshot: MarketSnapshot = {
    game: 'poe1',
    league: 'Eval',
    category: 'Currency',
    fetchedAt: '2026-01-01T00:00:00Z',
    core: { primary: 'chaos', perPrimary: { chaos: 1 } },
    lines,
  };

  const found = detectMeanReversion(snapshot, { minVolume: 100, zThreshold: 1.5, minDeviationPct: 10 });
  const foundIds = new Set(found.map((o) => o.itemId));
  const truePositives = [...plantedIds].filter((id) => foundIds.has(id));
  const falsePositives = found.filter((o) => !plantedIds.has(o.itemId));
  const precision = found.length === 0 ? 0 : truePositives.length / found.length;
  const recall = truePositives.length / plantedIds.size;

  report('mean-reversion: precision', precision === 1, `${precision.toFixed(3)} (${falsePositives.length} false positives)`);
  report('mean-reversion: recall', recall === 1, `${recall.toFixed(3)} (${truePositives.length}/${plantedIds.size} planted spikes found)`);
  const directionsOk = found.filter((o) => plantedIds.has(o.itemId)).every((o) => o.rationale.includes('above'));
  report('mean-reversion: direction', directionsOk, 'planted upward spikes all read as sell candidates');
}

// ---------------------------------------------------------------------------
// Eval 3: live database consistency (skipped when no data is ingested)
// ---------------------------------------------------------------------------
function liveConsistencyEval(): void {
  const config = loadConfig(process.env);
  let repo: SnapshotRepository;
  try {
    repo = new SnapshotRepository(createDb(config.dbPath));
  } catch {
    console.log('SKIP  live consistency (no database)');
    return;
  }
  const leagues = repo.leaguesSeen();
  if (leagues.length === 0) {
    console.log('SKIP  live consistency (no data ingested)');
    return;
  }
  const service = new ExiliumService(repo);
  let checked = 0;
  let mismatches = 0;
  for (const { game, league } of leagues) {
    const rows = service.arbitrage(game, league);
    const linesById = new Map(
      repo.latestAll(game, league).flatMap((s) =>
        s.lines.map((l) => [`${s.category}:${l.itemId}`, { line: l, core: s.core }] as const),
      ),
    );
    for (const row of rows) {
      const entry = linesById.get(`${row.category}:${row.itemId}`);
      if (entry === undefined) continue;
      const { line, core } = entry;
      // Independent recomputation from raw stored fields.
      const quotePerPrimary = core.perPrimary[line.maxVolumeCurrency ?? ''];
      if (quotePerPrimary === undefined || line.maxVolumeRate === null) continue;
      const implied = 1 / (line.maxVolumeRate * quotePerPrimary);
      checked += 1;
      if (Math.abs(implied - row.implied) / row.implied > 1e-9) mismatches += 1;
    }
  }
  report(
    'live: implied-price consistency',
    mismatches === 0 && checked > 0,
    `${checked} markets recomputed independently, ${mismatches} mismatches`,
  );
}

crossRateEval();
meanReversionEval();
liveConsistencyEval();

const failed = results.filter((r) => !r.pass);
console.log(`\n${results.length - failed.length}/${results.length} eval checks passed`);
if (failed.length > 0) process.exit(1);
