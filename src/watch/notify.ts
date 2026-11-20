import { WEBHOOK_TIMEOUT_MS } from '../snipe/webhook.js';

export interface Notifier {
  notify(title: string, message: string): Promise<void>;
}

export type ExecFn = (command: string, args: readonly string[]) => Promise<unknown>;

export interface NotifierOptions {
  readonly platform: NodeJS.Platform;
  readonly execFn: ExecFn;
  readonly fetchFn: (url: string, init: { method: string; headers: Record<string, string>; body: string; signal?: AbortSignal }) => Promise<Response>;
  readonly webhookUrl?: string | undefined;
  readonly log: (message: string) => void;
}

function osascriptCommand(title: string, message: string): readonly string[] {
  const esc = (s: string) => s.replaceAll('\\', '\\\\').replaceAll('"', '\\"');
  return ['-e', `display notification "${esc(message)}" with title "${esc(title)}"`];
}

/** Best-effort Windows toast via a PowerShell balloon. Failures are swallowed
 * by the caller; the terminal print and Discord webhook are the reliable
 * channels on Windows. */
function powershellCommand(title: string, message: string): readonly string[] {
  const q = (s: string) => `'${s.replaceAll("'", "''")}'`;
  const script =
    'Add-Type -AssemblyName System.Windows.Forms;' +
    '$b = New-Object System.Windows.Forms.NotifyIcon;' +
    '$b.Icon = [System.Drawing.SystemIcons]::Information; $b.Visible = $true;' +
    `$b.ShowBalloonTip(6000, ${q(title)}, ${q(message)}, 'Info');` +
    'Start-Sleep -Milliseconds 3000; $b.Dispose()';
  return ['-NoProfile', '-NonInteractive', '-WindowStyle', 'Hidden', '-Command', script];
}

/** Composite notifier: desktop notification (macOS osascript / Linux
 * notify-send / Windows PowerShell toast) plus optional Discord webhook. Channel failures are
 * logged, never thrown — a broken channel must not kill the watch loop. */
export function createNotifier(opts: NotifierOptions): Notifier {
  const desktop = async (title: string, message: string): Promise<void> => {
    try {
      if (opts.platform === 'darwin') {
        await opts.execFn('osascript', osascriptCommand(title, message));
      } else if (opts.platform === 'linux') {
        await opts.execFn('notify-send', [title, message]);
      } else if (opts.platform === 'win32') {
        await opts.execFn('powershell', powershellCommand(title, message));
      }
    } catch (err) {
      opts.log(`desktop notification failed: ${err instanceof Error ? err.message : String(err)}`);
    }
  };
  const webhook = async (title: string, message: string): Promise<void> => {
    if (opts.webhookUrl === undefined) return;
    try {
      const res = await opts.fetchFn(opts.webhookUrl, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ content: `**${title}**\n${message}` }),
        signal: AbortSignal.timeout(WEBHOOK_TIMEOUT_MS),
      });
      if (!res.ok) opts.log(`webhook returned ${res.status}`);
    } catch (err) {
      opts.log(`webhook failed: ${err instanceof Error ? err.message : String(err)}`);
    }
  };
  return {
    async notify(title: string, message: string): Promise<void> {
      // Channels run concurrently: the Windows toast is a PowerShell cold
      // start plus a 3s sleep, and the webhook must not queue behind it.
      await Promise.all([desktop(title, message), webhook(title, message)]);
    },
  };
}
