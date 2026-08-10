import { describe, expect, test } from 'vitest';
import { createCdpPage, type CdpSocket } from '../src/snipe/cdp.js';

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

function harness(options: { evaluateValues?: boolean[]; stallMethod?: string } = {}) {
  const socket = new FakeSocket();
  const evaluateValues = [...(options.evaluateValues ?? [true])];
  socket.onSend = (message) => {
    if (message.method === options.stallMethod) return;
    queueMicrotask(() => {
      if (message.method === 'Runtime.evaluate') {
        socket.respond(message.id, { result: { type: 'boolean', value: evaluateValues.shift() ?? false } });
      } else {
        socket.respond(message.id);
        if (message.method === 'Page.navigate' || message.method === 'Page.reload') {
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
  });
  return { socket, fetchCalls, create };
}

describe('direct CDP page control', () => {
  test('creates one native target, navigates, evaluates, reloads once, and clicks', async () => {
    const testHarness = harness({ evaluateValues: [false, true] });
    const page = await testHarness.create;
    expect(testHarness.fetchCalls).toEqual([{
      url: 'http://127.0.0.1:9222/json/new?about%3Ablank',
      method: 'PUT',
    }]);
    expect(testHarness.socket.sent.slice(0, 2).map((message) => message.method)).toEqual(['Page.enable', 'Runtime.enable']);

    await page.goto('https://www.pathofexile.com/trade/search/Allflame/abc');
    expect(page.url()).toBe('https://www.pathofexile.com/trade/search/Allflame/abc');
    expect(await page.clickTravelButton('listing-1')).toBe(true);
    expect(testHarness.socket.sent.map((message) => message.method)).toEqual([
      'Page.enable',
      'Runtime.enable',
      'Page.navigate',
      'Runtime.evaluate',
      'Page.reload',
      'Runtime.evaluate',
    ]);
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
