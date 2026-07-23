/** Glyph set for the terminal UI, with an ASCII-safe fallback.
 *
 * Path of Exile is mostly played on Windows, and the default Windows console
 * (cmd.exe / legacy conhost) does not reliably render the box-drawing, arrow,
 * and block characters a modern TUI leans on — they come out as mojibake. We
 * emit UTF-8, so anything outside ASCII is a gamble there. Modern terminals
 * (Windows Terminal, VS Code, ConEmu, WSL, and every mac/Linux terminal) are
 * fine, so the rule is: use the pretty glyphs everywhere except a bare legacy
 * Windows console, where we swap in ASCII that always renders. Override either
 * way with EXILIUM_ASCII=1 or EXILIUM_UNICODE=1. */

export interface Glyphs {
  readonly select: string; // selected-row marker
  readonly cursor: string; // text-input caret
  readonly enterKey: string; // the Enter key in hints
  readonly up: string;
  readonly down: string;
  readonly left: string;
  readonly right: string;
  readonly upDown: string;
  readonly leftRight: string;
  readonly sortAsc: string;
  readonly sortDesc: string;
  readonly sep: string; // inline separator between hint items
  readonly freshDot: string; // data-freshness status dot
  readonly delta: string; // column-header change marker ("" in ASCII)
  readonly times: string; // multiplier ×
  readonly over: string; // division ÷
  readonly spark: readonly string[]; // sparkline height ramp, low to high
  readonly border: 'round' | 'single'; // Ink box border style
  readonly ascii: boolean; // true when the ASCII-safe set is active
}

/** Every non-ASCII character the UI can emit, mapped to an ASCII stand-in.
 * Applied by fold() only in ASCII mode, so a legacy Windows console never
 * receives a byte it cannot render. Anything not listed folds to '?'. */
const FOLD_MAP: Record<string, string> = {
  '·': '|', '—': '-', '–': '-', '…': '...',
  '↑': '^', '↓': 'v', '←': '<', '→': '>', '↔': '<->', '↵': 'Enter',
  '▲': '^', '▼': 'v', '▶': '>', '●': '*', '▌': '_',
  '×': 'x', '÷': '/', 'Δ': 'd', '⚠': '(!)',
  '≥': '>=', '≤': '<=', '≈': '~', '±': '+/-',
  '▁': '.', '▂': '.', '▃': ':', '▄': ':', '▅': '=', '▆': '=', '▇': '#', '█': '#',
};

export function foldWith(ascii: boolean, s: string): string {
  return ascii ? s.replace(/[^\x00-\x7F]/g, (ch) => FOLD_MAP[ch] ?? '?') : s;
}

const UNICODE: Glyphs = {
  select: '▶',
  cursor: '▌',
  enterKey: '↵',
  up: '↑',
  down: '↓',
  left: '←',
  right: '→',
  upDown: '↑↓',
  leftRight: '←→',
  sortAsc: '▲',
  sortDesc: '▼',
  sep: '·',
  freshDot: '●',
  delta: 'Δ',
  times: '×',
  over: '÷',
  spark: ['▁', '▂', '▃', '▄', '▅', '▆', '▇', '█'],
  border: 'round',
  ascii: false,
};

const ASCII: Glyphs = {
  select: '>',
  cursor: '_',
  enterKey: 'Enter',
  up: '^',
  down: 'v',
  left: '<',
  right: '>',
  upDown: '^v',
  leftRight: '<>',
  sortAsc: '^',
  sortDesc: 'v',
  sep: '|',
  freshDot: '*',
  delta: '',
  times: 'x',
  over: '/',
  spark: ['.', ':', '-', '=', '+', '*', '#', '@'],
  border: 'single',
  ascii: true,
};

function truthy(v: string | undefined): boolean {
  return v !== undefined && v !== '' && v !== '0' && v.toLowerCase() !== 'false';
}

export function resolveGlyphs(deps: { platform: NodeJS.Platform; env: NodeJS.ProcessEnv }): Glyphs {
  const { platform, env } = deps;
  if (truthy(env['EXILIUM_ASCII'])) return ASCII;
  if (truthy(env['EXILIUM_UNICODE'])) return UNICODE;
  if (platform === 'win32') {
    const modernTerminal =
      truthy(env['WT_SESSION']) || // Windows Terminal
      truthy(env['WSL_DISTRO_NAME']) || // WSL
      truthy(env['TERM_PROGRAM']) || // VS Code and others
      env['ConEmuANSI'] === 'ON'; // ConEmu / Cmder
    return modernTerminal ? UNICODE : ASCII;
  }
  return UNICODE;
}

/** Resolved once from the current process; the UI imports this directly. */
export const glyphs: Glyphs = resolveGlyphs({ platform: process.platform, env: process.env });

/** Fold a string to ASCII when the active glyph set is ASCII; otherwise pass
 * it through unchanged. Wrap any UI text that may contain non-ASCII glyphs. */
export function fold(s: string): string {
  return foldWith(glyphs.ascii, s);
}
