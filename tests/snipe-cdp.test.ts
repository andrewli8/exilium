import { describe, expect, test } from 'vitest';
import { clickExpression, createCdpPage, type CdpSocket } from '../src/snipe/cdp.js';

class FakeSocket implements CdpSocket {
  readonly sent: Array<{ id: number; method: string; params?: unknown }> = [];
  private readonly listeners = new Map<string, Array<(...args: any[]) => void>>();
  onSend: (message: { id: number; method: string; params?: unknown }) => void = () => undefined;

  on(event: 'open' | 'message' | 'close' | 'error', listener: (...args: any[]) => void): this {
    const listeners = this.listeners.get(event) ?? [];
    listeners.push(listener);
    this.listeners.set(event, listeners);
    return this;
  }

  send(data: string): void {
    const message = JSON.parse(data) as { id: number; method: string; params?: unknown };
    this.sent.push(message);
    this.onSend(message);
  }

  close(): void {
    this.emit('close');
  }

  emit(event: string, ...args: unknown[]): void {
    for (const listener of this.listeners.get(event) ?? []) listener(...args);
  }

  respond(id: number, result: unknown = {}): void {
    this.emit('message', Buffer.from(JSON.stringify({ id, result })));
  }

  event(method: string, params: unknown = {}): void {
    this.emit('message', Buffer.from(JSON.stringify({ method, params })));
  }
}

function harness(options: {
  evaluateValues?: Array<'clicked' | 'gone' | 'unavailable'>;
  stallMethod?: string;
  onTradeFetchBody?: (url: string, body: string) => void;
  onDisconnect?: () => void;
  responseBodies?: Record<string, { body: string; base64Encoded?: boolean }>;
  suppressLoadEvent?: boolean;
} = {}) {
  const socket = new FakeSocket();
  const evaluateValues = [...(options.evaluateValues ?? ['clicked'])];
  socket.onSend = (message) => {
    if (message.method === options.stallMethod) return;
    queueMicrotask(() => {
      if (message.method === 'Runtime.evaluate') {
        socket.respond(message.id, { result: { type: 'string', value: evaluateValues.shift() ?? 'gone' } });
      } else if (message.method === 'Network.getResponseBody') {
        const requestId = (message.params as { requestId: string }).requestId;
        const stored = options.responseBodies?.[requestId];
        if (stored === undefined) socket.emit('message', Buffer.from(JSON.stringify({ id: message.id, error: { message: 'No resource with given identifier' } })));
        else socket.respond(message.id, { body: stored.body, base64Encoded: stored.base64Encoded ?? false });
      } else {
        socket.respond(message.id);
        if ((message.method === 'Page.navigate' || message.method === 'Page.reload') && options.suppressLoadEvent !== true) {
          socket.event('Page.loadEventFired');
        }
      }
    });
  };
  const fetchCalls: Array<{ url: string; method: string | undefined }> = [];
  const fetchFn = async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
    fetchCalls.push({ url: String(input), method: init?.method });
    return new Response(JSON.stringify({
      id: 'owned-target',
      type: 'page',
      url: 'about:blank',
      webSocketDebuggerUrl: 'ws://127.0.0.1:9222/devtools/page/owned-target',
    }), { status: 200, headers: { 'content-type': 'application/json' } });
  };
  const create = createCdpPage({
    cdpUrl: 'http://127.0.0.1:9222',
    fetchFn,
    openSocket: () => {
      setTimeout(() => socket.emit('open'), 0);
      return socket;
    },
    timeoutMs: 50,
    log: () => undefined,
    ...(options.onTradeFetchBody === undefined ? {} : { onTradeFetchBody: options.onTradeFetchBody }),
    ...(options.onDisconnect === undefined ? {} : { onDisconnect: options.onDisconnect }),
  });
  return { socket, fetchCalls, create };
}

const flush = () => new Promise((resolve) => setTimeout(resolve, 10));

describe('travel click script', () => {
  test('clicks through the In Demand teleport confirmation', () => {
    const expression = clickExpression('listing-1');
    // The row's own button relabels to "In Demand. Teleport anyway?" and
    // must be clicked a second time.
    expect(expression).toContain('/in demand|teleport anyway/i');
    // New buttons are matched too, snapshotting existing ones so other rows'
    // Travel buttons can never be mistaken for the confirmation dialog.
    expect(expression).toContain('const before = new Set(document.querySelectorAll(\'button\'))');
    expect(expression).toContain('!before.has(element)');
    expect(expression).toContain('/in demand|teleport|travel|confirm|yes/i');
  });
});

describe('direct CDP page control', () => {
  test('creates one native target, navigates, evaluates, reloads once, and clicks', async () => {
    const testHarness = harness({ evaluateValues: ['gone', 'clicked'] });
    const page = await testHarness.create;
    expect(testHarness.fetchCalls).toEqual([{
      url: 'http://127.0.0.1:9222/json/new?about%3Ablank',
      method: 'PUT',
    }]);
    expect(testHarness.socket.sent.slice(0, 2).map((message) => message.method)).toEqual(['Page.enable', 'Runtime.enable']);

    await page.goto('https://www.pathofexile.com/trade/search/Allflame/abc');
    expect(page.url()).toBe('https://www.pathofexile.com/trade/search/Allflame/abc');
    expect(await page.clickTravelButton('listing-1')).toBe('clicked');
    expect(testHarness.socket.sent.map((message) => message.method)).toEqual([
      'Page.enable',
      'Runtime.enable',
      'Page.navigate',
      'Runtime.evaluate',
      'Page.reload',
      'Runtime.evaluate',
    ]);
  });

  test('a slow SPA load event does not fail navigation or tear the tab down', async () => {
    const testHarness = harness({ suppressLoadEvent: true });
    const page = await testHarness.create;
    await expect(page.goto('https://www.pathofexile.com/trade/search/Allflame/abc/live')).resolves.toBeUndefined();
    expect(page.url()).toBe('https://www.pathofexile.com/trade/search/Allflame/abc/live');
    expect(testHarness.socket.sent.some((message) => message.method === 'Page.close')).toBe(false);
  });

  test('clickTravelButton with allowReload false never reloads the page', async () => {
    const testHarness = harness({ evaluateValues: ['gone'] });
    const page = await testHarness.create;
    expect(await page.clickTravelButton('listing-1', { allowReload: false })).toBe('gone');
    expect(testHarness.socket.sent.some((message) => message.method === 'Page.reload')).toBe(false);
  });

  test('evaluate runs an expression in the page and returns its value', async () => {
    const testHarness = harness({ evaluateValues: ['clicked'] });
    const page = await testHarness.create;
    expect(await page.evaluate?.('1 + 1')).toBe('clicked');
  });

  test('captures the trade fetch bodies the page itself requests', async () => {
    const captured: Array<{ url: string; body: string }> = [];
    const testHarness = harness({
      onTradeFetchBody: (url, body) => captured.push({ url, body }),
      responseBodies: { 'req-1': { body: '{"result":[]}' } },
    });
    await testHarness.create;
    expect(testHarness.socket.sent.some((message) => message.method === 'Network.enable')).toBe(true);

    testHarness.socket.event('Network.responseReceived', {
      requestId: 'req-1',
      response: { url: 'https://www.pathofexile.com/api/trade/fetch/abc,def?query=xyz' },
    });
    testHarness.socket.event('Network.loadingFinished', { requestId: 'req-1' });
    await flush();
    expect(captured).toEqual([{
      url: 'https://www.pathofexile.com/api/trade/fetch/abc,def?query=xyz',
      body: '{"result":[]}',
    }]);
  });

  test('ignores non-trade network responses and decodes base64 bodies', async () => {
    const captured: Array<{ url: string; body: string }> = [];
    const testHarness = harness({
      onTradeFetchBody: (url, body) => captured.push({ url, body }),
      responseBodies: { 'trade': { body: Buffer.from('{"result":[]}').toString('base64'), base64Encoded: true } },
    });
    await testHarness.create;
    testHarness.socket.event('Network.responseReceived', {
      requestId: 'other',
      response: { url: 'https://www.pathofexile.com/api/trade/data/stats' },
    });
    testHarness.socket.event('Network.loadingFinished', { requestId: 'other' });
    testHarness.socket.event('Network.responseReceived', {
      requestId: 'trade',
      response: { url: 'https://www.pathofexile.com/api/trade2/fetch/ghi?query=xyz' },
    });
    testHarness.socket.event('Network.loadingFinished', { requestId: 'trade' });
    await flush();
    expect(captured).toEqual([{
      url: 'https://www.pathofexile.com/api/trade2/fetch/ghi?query=xyz',
      body: '{"result":[]}',
    }]);
  });

  test('reports socket disconnects through onDisconnect', async () => {
    let disconnects = 0;
    const testHarness = harness({ onDisconnect: () => { disconnects += 1; } });
    const page = await testHarness.create;
    testHarness.socket.emit('close');
    await flush();
    expect(disconnects).toBe(1);
    await page.close();
    expect(disconnects).toBe(1);
  });

  test('times out a stalled CDP command with a bounded error', async () => {
    const testHarness = harness({ stallMethod: 'Page.navigate' });
    const page = await testHarness.create;
    await expect(page.goto('https://example.test/stalled')).rejects.toThrow(/timed out.*Page\.navigate/i);
  });

  test('close interrupts pending commands and closes only the owned page socket', async () => {
    const testHarness = harness({ stallMethod: 'Page.navigate' });
    const page = await testHarness.create;
    const navigation = page.goto('https://example.test/stalled');
    await Promise.resolve();
    await page.close();
    await expect(navigation).rejects.toThrow(/closed/i);
    expect(testHarness.socket.sent.some((message) => message.method === 'Page.close')).toBe(true);
  });
});
