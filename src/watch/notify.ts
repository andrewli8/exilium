export interface Notifier {
  notify(title: string, message: string): Promise<void>;
}

export type ExecFn = (command: string, args: readonly string[]) => Promise<unknown>;

export interface NotifierOptions {
  readonly platform: NodeJS.Platform;
  readonly execFn: ExecFn;
  readonly fetchFn: (url: string, init: { method: string; headers: Record<string, string>; body: string }) => Promise<Response>;
  readonly webhookUrl?: string | undefined;
  readonly log: (message: string) => void;
}

function osascriptCommand(title: string, message: string): readonly string[] {
  const esc = (s: string) => s.replaceAll('\\', '\\\\').replaceAll('"', '\\"');
  return ['-e', `display notification "${esc(message)}" with title "${esc(title)}"`];
}

/** Composite notifier: desktop notification (macOS osascript / Linux
 * notify-send) plus optional Discord-compatible webhook. Channel failures are
 * logged, never thrown — a broken channel must not kill the watch loop. */
export function createNotifier(opts: NotifierOptions): Notifier {
  return {
    async notify(title: string, message: string): Promise<void> {
      try {
        if (opts.platform === 'darwin') {
          await opts.execFn('osascript', osascriptCommand(title, message));
        } else if (opts.platform === 'linux') {
          await opts.execFn('notify-send', [title, message]);
        }
      } catch (err) {
        opts.log(`desktop notification failed: ${err instanceof Error ? err.message : String(err)}`);
      }
      if (opts.webhookUrl !== undefined) {
        try {
          const res = await opts.fetchFn(opts.webhookUrl, {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ content: `**${title}**\n${message}` }),
          });
          if (!res.ok) opts.log(`webhook returned ${res.status}`);
        } catch (err) {
          opts.log(`webhook failed: ${err instanceof Error ? err.message : String(err)}`);
        }
      }
    },
  };
}
