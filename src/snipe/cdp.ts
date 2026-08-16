import type { TravelClickResult, TravelPage } from './travel.js';

export interface CdpSocket {
  on(event: 'open', listener: () => void): this;
  on(event: 'message', listener: (data: Buffer | string) => void): this;
  on(event: 'close', listener: () => void): this;
  on(event: 'error', listener: (error: Error) => void): this;
  send(data: string): void;
  close(): void;
}

export type OpenCdpSocket = (url: string) => CdpSocket | Promise<CdpSocket>;

interface CdpTarget {
  readonly id: string;
  readonly type: string;
  readonly url: string;
  readonly webSocketDebuggerUrl: string;
}

interface CdpResponse {
  readonly id?: number;
  readonly method?: string;
  readonly params?: unknown;
  readonly result?: unknown;
  readonly error?: { readonly message?: string };
}

interface PendingCommand {
  readonly method: string;
  readonly resolve: (value: unknown) => void;
  readonly reject: (error: Error) => void;
  readonly timer: ReturnType<typeof setTimeout>;
}

interface EventWaiter {
  readonly resolve: (params: unknown) => void;
  readonly reject: (error: Error) => void;
  readonly timer: ReturnType<typeof setTimeout>;
}

class CdpConnection {
  private nextId = 0;
  private readonly pending = new Map<number, PendingCommand>();
  private readonly eventWaiters = new Map<string, Set<EventWaiter>>();
  private readonly eventListeners = new Map<string, Set<(params: unknown) => void>>();
  private closed = false;

  constructor(
    private readonly socket: CdpSocket,
    private readonly timeoutMs: number,
  ) {
    socket.on('message', (data) => this.onMessage(data));
    socket.on('close', () => this.dispose(new Error('Chrome CDP page connection closed')));
    socket.on('error', (error) => this.dispose(error));
  }

  send(method: string, params?: unknown): Promise<unknown> {
    if (this.closed) return Promise.reject(new Error('Chrome CDP page connection is closed'));
    const id = ++this.nextId;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`Chrome CDP timed out after ${this.timeoutMs}ms waiting for ${method}`));
      }, this.timeoutMs);
      this.pending.set(id, { method, resolve, reject, timer });
      try {
        this.socket.send(JSON.stringify({ id, method, ...(params === undefined ? {} : { params }) }));
      } catch (error) {
        clearTimeout(timer);
        this.pending.delete(id);
        reject(error instanceof Error ? error : new Error(String(error)));
      }
    });
  }

  /** Persistent event subscription (waitFor resolves once; this keeps firing). */
  on(method: string, listener: (params: unknown) => void): void {
    const listeners = this.eventListeners.get(method) ?? new Set<(params: unknown) => void>();
    listeners.add(listener);
    this.eventListeners.set(method, listeners);
  }

  waitFor(method: string): Promise<unknown> {
    if (this.closed) return Promise.reject(new Error('Chrome CDP page connection is closed'));
    return new Promise((resolve, reject) => {
      const listeners = this.eventWaiters.get(method) ?? new Set<EventWaiter>();
      let waiter: EventWaiter;
      const timer = setTimeout(() => {
        listeners.delete(waiter);
        reject(new Error(`Chrome CDP timed out after ${this.timeoutMs}ms waiting for ${method}`));
      }, this.timeoutMs);
      waiter = { resolve, reject, timer };
      listeners.add(waiter);
      this.eventWaiters.set(method, listeners);
    });
  }

  dispose(error = new Error('Chrome CDP page connection closed')): void {
    if (this.closed) return;
    this.closed = true;
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timer);
      pending.reject(error);
    }
    this.pending.clear();
    for (const waiters of this.eventWaiters.values()) {
      for (const waiter of waiters) {
        clearTimeout(waiter.timer);
        waiter.reject(error);
      }
    }
    this.eventWaiters.clear();
    try {
      this.socket.close();
    } catch {
      // The page or Chrome may already have closed the socket.
    }
  }

  private onMessage(data: Buffer | string): void {
    let message: CdpResponse;
    try {
      message = JSON.parse(data.toString()) as CdpResponse;
    } catch {
      return;
    }
    if (message.id !== undefined) {
      const pending = this.pending.get(message.id);
      if (pending === undefined) return;
      clearTimeout(pending.timer);
      this.pending.delete(message.id);
      if (message.error !== undefined) {
        pending.reject(new Error(`${pending.method}: ${message.error.message ?? 'CDP command failed'}`));
      } else {
        pending.resolve(message.result);
      }
      return;
    }
    if (message.method !== undefined) {
      for (const listener of this.eventListeners.get(message.method) ?? []) listener(message.params);
      const waiters = this.eventWaiters.get(message.method);
      if (waiters === undefined) return;
      for (const waiter of [...waiters]) {
        clearTimeout(waiter.timer);
        waiters.delete(waiter);
        waiter.resolve(message.params);
      }
      if (waiters.size === 0) this.eventWaiters.delete(message.method);
    }
  }
}

export interface CdpTravelPage extends TravelPage {
  /** allowReload: false keeps a browser-live tab intact — reloading would
   * discard the rows the live stream has accumulated. */
  clickTravelButton(listingId: string, options?: { readonly allowReload?: boolean }): Promise<TravelClickResult>;
  close(): Promise<void>;
  /** Best-effort page-world evaluation (browser-live uses it to kick off the
   * initial search). Optional so lightweight fakes stay small. */
  evaluate?(expression: string): Promise<unknown>;
}

export interface CreateCdpPageOptions {
  readonly cdpUrl: string;
  readonly fetchFn?: typeof fetch;
  readonly openSocket?: OpenCdpSocket;
  readonly timeoutMs?: number;
  readonly log: (message: string) => void;
  /** Browser-live capture: receives the body of every trade fetch XHR the
   * page itself performs (`/api/trade{,2}/fetch/...`). Enabling this turns
   * on the CDP Network domain for the tab. */
  readonly onTradeFetchBody?: (url: string, body: string) => void;
  /** Fired once if the page socket drops without an explicit close(). */
  readonly onDisconnect?: () => void;
  /** Raw frames of the page's own WebSockets (the live-search stream) — they
   * arrive BEFORE the page's handler runs or its detail fetch starts. */
  readonly onWebSocketFrame?: (payload: string) => void;
}

const TRADE_FETCH_PATTERN = /\/api\/trade2?\/fetch\//;
const MAX_PENDING_BODIES = 200;

async function defaultOpenSocket(url: string): Promise<CdpSocket> {
  const { default: WebSocket } = await import('ws');
  return new WebSocket(url) as unknown as CdpSocket;
}

async function waitForOpen(socket: CdpSocket, timeoutMs: number): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`Chrome CDP socket did not open within ${timeoutMs}ms`)), timeoutMs);
    socket.on('open', () => {
      clearTimeout(timer);
      resolve();
    });
    socket.on('error', (error) => {
      clearTimeout(timer);
      reject(error);
    });
  });
}

function targetUrl(cdpUrl: string): string {
  const base = cdpUrl.endsWith('/') ? cdpUrl : `${cdpUrl}/`;
  return new URL('json/new?about%3Ablank', base).toString();
}

/** How long the in-page click script polls for the row before giving up.
 * Must stay below the CDP command timeout (default 6s) with headroom. */
const CLICK_POLL_DEADLINE_MS = 4_000;
const CLICK_POLL_INTERVAL_MS = 100;
/** After the row click, an in-demand listing asks "In Demand. Teleport
 * anyway?" — wait this long for the prompt and click it too. The prompt
 * appears after a server round-trip, so give it real time. */
const CONFIRM_WAIT_MS = 4_000;

/** Exported for tests only. */
export function clickExpression(listingId: string): string {
  // The trade site is an SPA: the load event fires long before the result
  // rows exist, so the click must wait for the row to stream in.
  return `(async () => {
    const listingId = ${JSON.stringify(listingId)};
    const deadline = Date.now() + ${CLICK_POLL_DEADLINE_MS};
    const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
    const confirmDialog = async (row) => {
      // In-demand listings ask again after the first click: the row's own
      // button relabels to "In Demand. Teleport anyway?" (or a dialog pops).
      // Click through it. For NEW buttons, only ones that appeared after our
      // click count — pre-existing Travel buttons belong to other rows.
      const before = new Set(document.querySelectorAll('button'));
      const confirmDeadline = Date.now() + ${CONFIRM_WAIT_MS};
      const confirmText = /in demand|teleport|travel|confirm|yes/i;
      while (Date.now() < confirmDeadline) {
        await sleep(${CLICK_POLL_INTERVAL_MS});
        const relabeled = Array.from(row.querySelectorAll('button'))
          .find((element) => element instanceof HTMLButtonElement && !element.disabled
            && /in demand|teleport anyway/i.test(element.textContent || ''));
        if (relabeled) {
          relabeled.click();
          return;
        }
        const fresh = Array.from(document.querySelectorAll('button'))
          .filter((element) => !before.has(element) && element instanceof HTMLButtonElement && !element.disabled)
          .find((element) => confirmText.test((element.textContent || '').trim()));
        if (fresh) {
          fresh.click();
          return;
        }
      }
    };
    for (;;) {
      const row = Array.from(document.querySelectorAll('[data-id]'))
        .find((element) => element.getAttribute('data-id') === listingId);
      if (row) {
        const direct = row.querySelector('button.direct-btn');
        const button = direct || Array.from(row.querySelectorAll('button'))
          .find((element) => element.textContent && element.textContent.trim() === 'Travel to Hideout');
        if (button instanceof HTMLButtonElement && !button.disabled) {
          const beforeConfirm = confirmDialog(row);
          button.click();
          await beforeConfirm;
          return 'clicked';
        }
        if (Date.now() >= deadline) return 'unavailable';
      } else if (Date.now() >= deadline) {
        return 'gone';
      }
      await sleep(${CLICK_POLL_INTERVAL_MS});
    }
  })()`;
}

export async function createCdpPage(options: CreateCdpPageOptions): Promise<CdpTravelPage> {
  // Must exceed the click script's worst case: row poll (4s) + confirm wait
  // (2.5s), with headroom for slow pages.
  const timeoutMs = options.timeoutMs ?? 12_000;
  const fetchFn = options.fetchFn ?? fetch;
  let response: Response;
  try {
    response = await fetchFn(targetUrl(options.cdpUrl), {
      method: 'PUT',
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch (error) {
    throw new Error(`Chrome unavailable at ${options.cdpUrl}: ${error instanceof Error ? error.message : String(error)}`);
  }
  if (!response.ok) throw new Error(`Chrome target creation failed with HTTP ${response.status}`);
  const target = await response.json() as Partial<CdpTarget>;
  if (typeof target.webSocketDebuggerUrl !== 'string') {
    throw new Error('Chrome target response did not include a page WebSocket URL');
  }
  const socket = await (options.openSocket ?? defaultOpenSocket)(target.webSocketDebuggerUrl);
  await waitForOpen(socket, timeoutMs);
  const connection = new CdpConnection(socket, timeoutMs);
  await Promise.all([connection.send('Page.enable'), connection.send('Runtime.enable')]);
  // Focus emulation keeps background/occluded tabs fully responsive even
  // when Chrome was NOT launched with the anti-throttling flags (they only
  // apply at launch, and users rarely relaunch). The owner judged the
  // v0.2.7 behavior — emulation ON — the smoothest; its CPU cost is
  // acceptable.
  void connection.send('Emulation.setFocusEmulationEnabled', { enabled: true }).catch(() => undefined);
  let currentUrl = typeof target.url === 'string' ? target.url : 'about:blank';
  let closed = false;
  if (options.onDisconnect !== undefined) {
    const onDisconnect = options.onDisconnect;
    let disconnectNotified = false;
    socket.on('close', () => {
      if (closed || disconnectNotified) return;
      disconnectNotified = true;
      onDisconnect();
    });
  }
  if (options.onTradeFetchBody !== undefined) {
    const onBody = options.onTradeFetchBody;
    const pendingBodies = new Map<string, string>();
    connection.on('Network.responseReceived', (params) => {
      const event = params as { requestId?: unknown; response?: { url?: unknown } };
      const url = event.response?.url;
      if (typeof event.requestId !== 'string' || typeof url !== 'string') return;
      if (!TRADE_FETCH_PATTERN.test(url)) return;
      pendingBodies.set(event.requestId, url);
      while (pendingBodies.size > MAX_PENDING_BODIES) {
        const oldest = pendingBodies.keys().next().value;
        if (oldest === undefined) break;
        pendingBodies.delete(oldest);
      }
    });
    const readBody = async (requestId: string, url: string): Promise<void> => {
      // Chrome can evict a response body before we ask for it — retry once
      // after a beat rather than silently losing the listings inside it.
      for (let attempt = 0; ; attempt += 1) {
        try {
          const payload = await connection.send('Network.getResponseBody', { requestId }) as { body?: unknown; base64Encoded?: unknown };
          if (typeof payload.body !== 'string') return;
          onBody(url, payload.base64Encoded === true
            ? Buffer.from(payload.body, 'base64').toString('utf8')
            : payload.body);
          return;
        } catch (error) {
          if (attempt >= 1) {
            options.log(`browser-live: could not read a trade fetch body: ${error instanceof Error ? error.message : String(error)}`);
            return;
          }
          await new Promise((resolve) => setTimeout(resolve, 150));
        }
      }
    };
    connection.on('Network.loadingFinished', (params) => {
      const event = params as { requestId?: unknown };
      if (typeof event.requestId !== 'string') return;
      const url = pendingBodies.get(event.requestId);
      if (url === undefined) return;
      pendingBodies.delete(event.requestId);
      void readBody(event.requestId, url);
    });
    // Generous buffers so bodies survive until we read them.
    await connection.send('Network.enable', { maxTotalBufferSize: 50_000_000, maxResourceBufferSize: 10_000_000 });
  }
  if (options.onWebSocketFrame !== undefined) {
    const onFrame = options.onWebSocketFrame;
    connection.on('Network.webSocketFrameReceived', (params) => {
      const event = params as { response?: { payloadData?: unknown } };
      if (typeof event.response?.payloadData === 'string') onFrame(event.response.payloadData);
    });
    if (options.onTradeFetchBody === undefined) {
      await connection.send('Network.enable', { maxTotalBufferSize: 50_000_000, maxResourceBufferSize: 10_000_000 });
    }
  }

  // The load event is best-effort: the trade site is a heavy SPA whose load
  // can outlast the CDP timeout, especially with several tabs opening at
  // once. Navigation has been issued and network capture keeps flowing, so a
  // late load event must never tear the tab down.
  const waitForLoad = async (command: Promise<unknown>): Promise<void> => {
    const loaded = connection.waitFor('Page.loadEventFired').then(() => 'loaded' as const, () => 'timeout' as const);
    await command;
    if (await loaded === 'timeout') {
      options.log('Chrome page load event is late — continuing; the tab keeps loading and capture stays attached.');
    }
  };
  const evaluateClick = async (listingId: string): Promise<TravelClickResult> => {
    const result = await connection.send('Runtime.evaluate', {
      expression: clickExpression(listingId),
      returnByValue: true,
      awaitPromise: true,
    }) as { result?: { value?: unknown }; exceptionDetails?: unknown };
    if (result.exceptionDetails !== undefined) throw new Error('Chrome could not inspect the trade listing row');
    const value = result.result?.value;
    return value === 'clicked' || value === 'gone' || value === 'unavailable' ? value : 'unavailable';
  };

  options.log(`Travel controller attached directly to Chrome at ${options.cdpUrl}.`);
  return {
    url: () => currentUrl,
    async goto(url: string) {
      await waitForLoad(connection.send('Page.navigate', { url }));
      currentUrl = url;
    },
    async clickTravelButton(listingId: string, clickOptions?: { readonly allowReload?: boolean }) {
      const first = await evaluateClick(listingId);
      if (first !== 'gone' || clickOptions?.allowReload === false) return first;
      await waitForLoad(connection.send('Page.reload', { ignoreCache: true }));
      return evaluateClick(listingId);
    },
    async evaluate(expression: string) {
      const result = await connection.send('Runtime.evaluate', {
        expression,
        returnByValue: true,
        awaitPromise: true,
      }) as { result?: { value?: unknown } };
      return result.result?.value;
    },
    async close() {
      if (closed) return;
      closed = true;
      // Page.close over the socket races the socket teardown and can lose —
      // an about:blank tab survives every time it does. Chrome's HTTP
      // endpoint closes the target regardless of our socket's state.
      void connection.send('Page.close').catch(() => undefined);
      if (typeof target.id === 'string') {
        const base = options.cdpUrl.endsWith('/') ? options.cdpUrl : `${options.cdpUrl}/`;
        void fetchFn(new URL(`json/close/${target.id}`, base).toString(), {
          signal: AbortSignal.timeout(2_000),
        }).catch(() => undefined);
      }
      connection.dispose();
    },
  };
}
