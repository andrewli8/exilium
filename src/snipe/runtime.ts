import type { SnipeAlert } from './engine.js';
import { runSnipe, type SnipeDeps, type SnipeFlags } from './run.js';
import type { SnipeConsoleOptions } from './console.js';
import type { SnipeStore } from './store.js';
import type { TravelResult } from './travel.js';

type RunSnipe = (flags: SnipeFlags, deps: SnipeDeps) => Promise<void>;

export interface StartSnipeRuntimeOptions {
  readonly flags: SnipeFlags;
  readonly store: SnipeStore;
}

export interface StartSnipeRuntimeDeps {
  readonly run?: RunSnipe;
  readonly snipeDeps?: SnipeDeps;
}

export interface SnipeRuntimeHandle {
  readonly store: SnipeStore;
  travel(listingId: string): Promise<TravelResult>;
  stop(): Promise<void>;
}

export async function startSnipeRuntime(
  options: StartSnipeRuntimeOptions,
  deps: StartSnipeRuntimeDeps,
): Promise<SnipeRuntimeHandle> {
  const run = deps.run ?? runSnipe;
  let consoleOptions: SnipeConsoleOptions | undefined;
  let resolveReady!: () => void;
  const ready = new Promise<void>((resolve) => { resolveReady = resolve; });
  let resolveExit!: () => void;
  const exit = new Promise<void>((resolve) => { resolveExit = resolve; });
  let stopped = false;

  const running = run(options.flags, {
    ...(deps.snipeDeps ?? {} as SnipeDeps),
    store: options.store,
    makeConsole: (viewOptions) => {
      consoleOptions = viewOptions;
      resolveReady();
      return {
        addAlert: (alert: SnipeAlert) => options.store.ingest(alert),
        waitUntilExit: () => exit,
        close: () => undefined,
      };
    },
  });

  await Promise.race([
    ready,
    running.then(() => { throw new Error('Snipe runtime stopped before monitoring started'); }),
  ]);

  return {
    store: options.store,
    async travel(listingId) {
      const entry = options.store.snapshot().queue.entries.find((candidate) => candidate.alert.listingId === listingId);
      if (entry === undefined) return { action: 'gone', detail: 'listing is no longer in the queue' };
      options.store.dispatch({ type: 'travel-start', listingId });
      try {
        const result = await consoleOptions!.onTravel(entry.alert);
        if (result.action === 'traveled') {
          options.store.dispatch({ type: 'travel-success', listingId, detail: result.detail });
        } else if (result.action === 'gone') {
          options.store.dispatch({ type: 'remove-gone', listingId });
        } else {
          options.store.dispatch({ type: 'travel-failure', listingId, detail: result.technicalDetail ?? result.detail });
        }
        return result;
      } catch (error) {
        const detail = error instanceof Error ? error.message : String(error);
        options.store.dispatch({ type: 'travel-failure', listingId, detail });
        return { action: 'failed', detail, technicalDetail: detail };
      }
    },
    async stop() {
      if (!stopped) {
        stopped = true;
        consoleOptions?.onExit?.();
        resolveExit();
      }
      await running;
    },
  };
}
