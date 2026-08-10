/**
 * Live unid-market floor for Valdo reward items.
 *
 * Variant-lottery uniques (Sublime Vision, Forbidden Flame/Flesh, ...) have
 * no honest poe.ninja aggregate: the single "Sublime Vision" line averages
 * the cheap variants (~1 divine) while the unidentified jewel trades near
 * 93 divine. The real reference is the trade site's own market — the
 * cheapest online unidentified listing of the base item. The search runs
 * inside an already-open browser-live tab (the page's session and budget,
 * two requests per item), and results are cached.
 */

export interface RewardFloorPrice {
  readonly amount: number;
  readonly currency: string;
}

export type PageEvaluate = (expression: string) => Promise<unknown>;

export interface RewardFloorServiceOptions {
  readonly league: string;
  /** A live tab's page-world evaluator; null while no tab is open yet. */
  readonly getEvaluate: () => PageEvaluate | null;
  readonly log: (message: string) => void;
  readonly now?: () => number;
  /** How long a found floor stays fresh. Default 10 minutes. */
  readonly ttlMs?: number;
  /** How long a missing floor (no unid market) is remembered. Default 10 minutes. */
  readonly failureTtlMs?: number;
  /** Pause before the one retry after a thrown evaluate (e.g. the tab
   * navigated mid-flight). Default 3s; tests shorten it. */
  readonly retryDelayMs?: number;
}

const DEFAULT_TTL_MS = 10 * 60_000;
/** Failures retry sooner — a transient page race must not stick for long. */
const DEFAULT_FAILURE_TTL_MS = 2 * 60_000;

/** Exported for tests: the in-page script that finds the cheapest online
 * unidentified listing of `name` and returns its price (or null). */
export function unidFloorExpression(league: string, name: string): string {
  // status must be 'any': the trade API returns ZERO results for
  // identified:false combined with status:online (verified live), while
  // 'any' finds the real unid market — price-ascending, so the floor is
  // still the cheapest actual listing.
  const body = JSON.stringify({
    query: {
      status: { option: 'any' },
      name,
      filters: { misc_filters: { filters: { identified: { option: 'false' } } } },
    },
    sort: { price: 'asc' },
  });
  return `(async () => {
    try {
      const search = await fetch('https://www.pathofexile.com/api/trade/search/${encodeURIComponent(league)}', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'include',
        body: ${JSON.stringify(body)},
      }).then((res) => res.json());
      if (!search || typeof search.id !== 'string' || !Array.isArray(search.result)) return null;
      // A single listing is not a market — one troll price must not become
      // the reference.
      if (search.result.length < 2) return null;
      const ids = search.result.slice(0, 5);
      const details = await fetch('https://www.pathofexile.com/api/trade/fetch/' + ids.join(',') + '?query=' + search.id, { credentials: 'include' })
        .then((res) => res.json());
      const prices = (details && Array.isArray(details.result) ? details.result : [])
        .filter((entry) => entry && entry.listing && entry.listing.price)
        .map((entry) => entry.listing.price)
        .filter((price) => typeof price.amount === 'number' && typeof price.currency === 'string');
      return prices.length > 0 ? { amount: prices[0].amount, currency: prices[0].currency } : null;
    } catch {
      return null;
    }
  })()`;
}

function asPrice(value: unknown): RewardFloorPrice | null {
  if (typeof value !== 'object' || value === null) return null;
  const price = value as { amount?: unknown; currency?: unknown };
  if (typeof price.amount !== 'number' || !Number.isFinite(price.amount)) return null;
  if (typeof price.currency !== 'string' || price.currency === '') return null;
  return { amount: price.amount, currency: price.currency };
}

interface CacheEntry {
  readonly price: RewardFloorPrice | null;
  readonly at: number;
}

export class RewardFloorService {
  private readonly cache = new Map<string, CacheEntry>();
  private readonly inFlight = new Map<string, Promise<RewardFloorPrice | null>>();

  constructor(private readonly options: RewardFloorServiceOptions) {}

  async floorPrice(baseName: string): Promise<RewardFloorPrice | null> {
    const now = this.options.now ?? Date.now;
    const key = baseName.toLowerCase();
    const cached = this.cache.get(key);
    if (cached !== undefined) {
      const ttl = cached.price === null
        ? this.options.failureTtlMs ?? DEFAULT_FAILURE_TTL_MS
        : this.options.ttlMs ?? DEFAULT_TTL_MS;
      if (now() - cached.at < ttl) return cached.price;
    }
    const pending = this.inFlight.get(key);
    if (pending !== undefined) return pending;

    const evaluate = this.options.getEvaluate();
    if (evaluate === null) return cached?.price ?? null;

    const attempt = async (): Promise<RewardFloorPrice | null> => {
      try {
        return asPrice(await evaluate(unidFloorExpression(this.options.league, baseName)));
      } catch (error) {
        // A tab navigating mid-evaluate throws; wait for it to settle and
        // retry once on whatever page is stable by then.
        this.options.log(`reward floor lookup for ${baseName} retrying: ${error instanceof Error ? error.message : String(error)}`);
        await new Promise((resolve) => setTimeout(resolve, this.options.retryDelayMs ?? 3_000));
        const secondTry = this.options.getEvaluate();
        if (secondTry === null) return null;
        try {
          return asPrice(await secondTry(unidFloorExpression(this.options.league, baseName)));
        } catch (secondError) {
          this.options.log(`reward floor lookup failed for ${baseName}: ${secondError instanceof Error ? secondError.message : String(secondError)}`);
          return null;
        }
      }
    };
    const task = attempt()
      .then((price) => {
        this.cache.set(key, { price, at: now() });
        this.inFlight.delete(key);
        if (price !== null) this.options.log(`reward floor: unid ${baseName} @ ${price.amount} ${price.currency}`);
        return price;
      });
    this.inFlight.set(key, task);
    return task;
  }
}
