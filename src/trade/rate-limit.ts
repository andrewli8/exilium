/** Rate-limit citizenship for the pathofexile.com trade API.
 *
 * GGG temporarily IP/account-bans clients that ignore trade-API rate limits,
 * so this is not optional politeness — it protects the user's own access. GGG
 * returns policy and state headers on every response:
 *
 *   X-Rate-Limit-Rules:    Ip,Account
 *   X-Rate-Limit-Ip:       8:10:60,15:60:120   (policy: hits:period:restrict)
 *   X-Rate-Limit-Ip-State: 5:10:0,9:60:0       (current usage per bucket)
 *
 * and a Retry-After on a 429. This limiter reads all of that and backs off
 * BEFORE tripping a limit (when a bucket fills), as well as after a 429 or an
 * active restriction. One instance is shared across every trade-API call in
 * the process, because GGG counts by IP/account across all endpoints. */

export class RateLimitError extends Error {
  readonly retryAfterSec: number;
  constructor(retryAfterSec: number) {
    super(
      `pathofexile.com trade limit reached — Exilium is backing off for ${retryAfterSec}s to keep your account in good standing. Try again after that.`,
    );
    this.name = 'RateLimitError';
    this.retryAfterSec = retryAfterSec;
  }
}

export interface RateLimitHealth {
  readonly total429s: number;
  readonly cooldownRemainingSec: number;
}

interface HeaderBag {
  get(name: string): string | null;
}

const DEFAULT_RESTRICT_SEC = 60;

/** Parse a "hits:period:restrict,hits:period:restrict" header into number triples. */
function parseSets(header: string | null): readonly (readonly [number, number, number])[] {
  if (header === null || header.trim() === '') return [];
  return header
    .split(',')
    .map((set) => set.split(':').map(Number))
    .filter((p) => p.length === 3 && p.every((n) => Number.isFinite(n)))
    .map((p) => [p[0]!, p[1]!, p[2]!] as const);
}

export class TradeRateLimiter {
  private readonly nowMs: () => number;
  private cooldownUntilMs = 0;
  private total429s = 0;

  constructor(nowMs: () => number = () => Date.now()) {
    this.nowMs = nowMs;
  }

  /** Pre-flight gate: throw if we are inside a cooldown window. Callers invoke
   * this immediately before every trade-API request. */
  gate(): void {
    const remaining = Math.ceil((this.cooldownUntilMs - this.nowMs()) / 1000);
    if (remaining > 0) throw new RateLimitError(remaining);
  }

  /** Fold one response's rate-limit signals into the cooldown window. */
  observe(res: { status: number; headers: HeaderBag }): void {
    if (res.status === 429) {
      this.total429s += 1;
      const retryAfter = Number(res.headers.get('Retry-After') ?? '');
      const fromState = this.worstActiveRestrict(res.headers);
      const sec = (Number.isFinite(retryAfter) && retryAfter > 0 ? retryAfter : 0) || fromState || DEFAULT_RESTRICT_SEC;
      this.setCooldown(sec);
      return;
    }
    const rules = (res.headers.get('X-Rate-Limit-Rules') ?? '')
      .split(',')
      .map((r) => r.trim())
      .filter((r) => r !== '');
    let waitSec = 0;
    for (const rule of rules) {
      const policy = parseSets(res.headers.get(`X-Rate-Limit-${rule}`));
      const state = parseSets(res.headers.get(`X-Rate-Limit-${rule}-State`));
      state.forEach((st, i) => {
        const [hits, period, activeRestrict] = st;
        if (activeRestrict > 0) {
          waitSec = Math.max(waitSec, activeRestrict); // already being penalised
        } else {
          const pol = policy[i];
          if (pol !== undefined && hits >= pol[0]) waitSec = Math.max(waitSec, period); // bucket full: wait the window out
        }
      });
    }
    if (waitSec > 0) this.setCooldown(waitSec);
  }

  health(): RateLimitHealth {
    return {
      total429s: this.total429s,
      cooldownRemainingSec: Math.max(0, Math.ceil((this.cooldownUntilMs - this.nowMs()) / 1000)),
    };
  }

  private worstActiveRestrict(headers: HeaderBag): number {
    const rules = (headers.get('X-Rate-Limit-Rules') ?? '').split(',').map((r) => r.trim()).filter((r) => r !== '');
    let worst = 0;
    for (const rule of rules) {
      for (const [, , activeRestrict] of parseSets(headers.get(`X-Rate-Limit-${rule}-State`))) {
        worst = Math.max(worst, activeRestrict);
      }
    }
    return worst;
  }

  private setCooldown(sec: number): void {
    this.cooldownUntilMs = Math.max(this.cooldownUntilMs, this.nowMs() + sec * 1000);
  }
}

/** Process-wide limiter shared by every trade-API call path. */
export const sharedTradeRateLimiter = new TradeRateLimiter();
