import {
  RateLimitError,
  TradeRateLimiter,
  type RateLimitHealth,
} from './rate-limit.js';

export type TradeRequestPriority = 'live' | 'interactive' | 'seed';

export interface TradeSchedulerHealth extends RateLimitHealth {
  readonly state: 'ready' | 'cooldown' | 'rate-limited';
  readonly queued: number;
}

interface TradeResponseLike {
  readonly status: number;
  readonly headers: { get(name: string): string | null };
}

interface ScheduledRequest<T extends TradeResponseLike> {
  readonly priority: TradeRequestPriority;
  readonly operation: () => Promise<T>;
  readonly signal: AbortSignal | undefined;
  readonly resolve: (value: T) => void;
  readonly reject: (reason: unknown) => void;
}

export interface TradeRequestSchedulerOptions {
  readonly limiter?: TradeRateLimiter;
  readonly wait?: (milliseconds: number, signal?: AbortSignal) => Promise<void>;
}

const PRIORITIES: readonly TradeRequestPriority[] = ['live', 'interactive', 'seed'];

function abortError(): Error {
  const error = new Error('Trade request cancelled');
  error.name = 'AbortError';
  return error;
}

function defaultWait(milliseconds: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted === true) {
      reject(abortError());
      return;
    }
    const timer = setTimeout(done, milliseconds);
    const abort = (): void => {
      clearTimeout(timer);
      signal?.removeEventListener('abort', abort);
      reject(abortError());
    };
    function done(): void {
      signal?.removeEventListener('abort', abort);
      resolve();
    }
    signal?.addEventListener('abort', abort, { once: true });
  });
}

export class TradeRequestScheduler {
  private readonly limiter: TradeRateLimiter;
  private readonly wait: (milliseconds: number, signal?: AbortSignal) => Promise<void>;
  private readonly queues = new Map<TradeRequestPriority, ScheduledRequest<TradeResponseLike>[]>(
    PRIORITIES.map((priority) => [priority, []]),
  );
  private readonly listeners = new Set<(health: TradeSchedulerHealth) => void>();
  private running = false;
  private lastLimited = false;

  constructor(options: TradeRequestSchedulerOptions = {}) {
    this.limiter = options.limiter ?? new TradeRateLimiter();
    this.wait = options.wait ?? defaultWait;
  }

  schedule<T extends TradeResponseLike>(
    priority: TradeRequestPriority,
    operation: () => Promise<T>,
    signal?: AbortSignal,
  ): Promise<T> {
    if (signal?.aborted === true) return Promise.reject(abortError());
    return new Promise<T>((resolve, reject) => {
      const request: ScheduledRequest<TradeResponseLike> = {
        priority,
        operation,
        signal,
        resolve: (response) => resolve(response as T),
        reject,
      };
      this.queues.get(priority)!.push(request);
      this.publish();
      void this.drain();
    });
  }

  health(): TradeSchedulerHealth {
    const rate = this.limiter.health();
    return {
      ...rate,
      state: rate.cooldownRemainingSec > 0
        ? this.lastLimited ? 'rate-limited' : 'cooldown'
        : 'ready',
      queued: [...this.queues.values()].reduce((total, queue) => total + queue.length, 0),
    };
  }

  subscribe(listener: (health: TradeSchedulerHealth) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  private next(): ScheduledRequest<TradeResponseLike> | undefined {
    for (const priority of PRIORITIES) {
      const request = this.queues.get(priority)!.shift();
      if (request !== undefined) return request;
    }
    return undefined;
  }

  private async admit(signal?: AbortSignal): Promise<void> {
    for (;;) {
      if (signal?.aborted === true) throw abortError();
      try {
        this.limiter.gate();
        return;
      } catch (error) {
        if (!(error instanceof RateLimitError)) throw error;
        this.publish();
        await this.wait(error.retryAfterSec * 1_000, signal);
      }
    }
  }

  private async drain(): Promise<void> {
    if (this.running) return;
    this.running = true;
    try {
      for (let request = this.next(); request !== undefined; request = this.next()) {
        try {
          await this.admit(request.signal);
          if (request.signal?.aborted === true) throw abortError();
          const response = await request.operation();
          this.limiter.observe(response);
          this.lastLimited = response.status === 429;
          this.publish();
          request.resolve(response);
        } catch (error) {
          request.reject(error);
        }
      }
    } finally {
      this.running = false;
      this.publish();
      if (this.health().queued > 0) void this.drain();
    }
  }

  private publish(): void {
    const health = this.health();
    for (const listener of this.listeners) listener(health);
  }
}

export const sharedTradeRequestScheduler = new TradeRequestScheduler();

export function resolveTradeRequestScheduler(
  scheduler: TradeRequestScheduler | undefined,
  limiter: TradeRateLimiter | undefined,
): TradeRequestScheduler {
  return scheduler ?? (limiter === undefined
    ? sharedTradeRequestScheduler
    : new TradeRequestScheduler({ limiter }));
}
