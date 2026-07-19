import type { Db } from './db.js';

export const OUTCOMES = ['filled', 'partial', 'no-fill', 'skipped'] as const;
export type Outcome = (typeof OUTCOMES)[number];

export interface JournalEntryInput {
  readonly opportunityId: string;
  readonly itemName: string;
  readonly outcome: Outcome;
  readonly expectedEdgePct: number;
  readonly note: string | null;
  readonly recordedAt: string;
}

export interface JournalEntry extends JournalEntryInput {
  readonly id: number;
}

export interface JournalSummary {
  readonly total: number;
  readonly counts: Readonly<Record<Outcome, number>>;
  /** filled + half credit for partial, over total. The honest realized-fill proxy. */
  readonly fillRate: number;
}

const SCHEMA = `
CREATE TABLE IF NOT EXISTS journal (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  opportunity_id TEXT NOT NULL,
  item_name TEXT NOT NULL,
  outcome TEXT NOT NULL,
  expected_edge_pct REAL NOT NULL,
  note TEXT,
  recorded_at TEXT NOT NULL
);
`;

interface Row {
  readonly id: number;
  readonly opportunity_id: string;
  readonly item_name: string;
  readonly outcome: Outcome;
  readonly expected_edge_pct: number;
  readonly note: string | null;
  readonly recorded_at: string;
}

/** Stores what actually happened after a trade plan: the fill-reality data
 * the PRD wants and no API can provide. */
export class JournalRepository {
  constructor(private readonly db: Db) {
    db.exec(SCHEMA);
  }

  record(entry: JournalEntryInput): void {
    if (!OUTCOMES.includes(entry.outcome)) {
      throw new Error(`Unknown outcome "${entry.outcome}" — expected one of: ${OUTCOMES.join(', ')}`);
    }
    this.db
      .prepare(
        'INSERT INTO journal (opportunity_id, item_name, outcome, expected_edge_pct, note, recorded_at) VALUES (?, ?, ?, ?, ?, ?)',
      )
      .run(entry.opportunityId, entry.itemName, entry.outcome, entry.expectedEdgePct, entry.note, entry.recordedAt);
  }

  list(limit: number): readonly JournalEntry[] {
    const rows = this.db
      .prepare('SELECT * FROM journal ORDER BY recorded_at DESC, id DESC LIMIT ?')
      .all(limit) as readonly Row[];
    return rows.map((r) => ({
      id: r.id,
      opportunityId: r.opportunity_id,
      itemName: r.item_name,
      outcome: r.outcome,
      expectedEdgePct: r.expected_edge_pct,
      note: r.note,
      recordedAt: r.recorded_at,
    }));
  }

  summary(): JournalSummary {
    const counts = Object.fromEntries(OUTCOMES.map((o) => [o, 0])) as Record<Outcome, number>;
    const rows = this.db.prepare('SELECT outcome, COUNT(*) AS n FROM journal GROUP BY outcome').all() as readonly {
      outcome: Outcome;
      n: number;
    }[];
    for (const r of rows) if (r.outcome in counts) counts[r.outcome] = r.n;
    const total = Object.values(counts).reduce((a, b) => a + b, 0);
    const fillRate = total === 0 ? 0 : (counts.filled + 0.5 * counts.partial) / total;
    return { total, counts, fillRate };
  }
}
