import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { basename, extname, join, relative, sep } from 'node:path';
import { z } from 'zod';
import { parseTradeUrl } from '../trade/live-search.js';

/** Loader for the user's "BetterTrading" folder: a directory of saved trade
 * searches to snipe. Accepts plain URL lists, structured JSON, and export
 * strings from the Better Trading browser extension
 * (exile-center/better-trading), whose folders serialize as
 * `3:<base64 JSON>` with trades at `trs[].loc = "version:type:slug"`. */

export interface SnipeTarget {
  readonly label: string;
  readonly realm: 'trade' | 'trade2';
  readonly searchId: string;
  /** League from the source URL/JSON; null when league-agnostic (extension
   * slugs carry no league — the engine applies the configured one). */
  readonly league: string | null;
  /** Better Trading folder title (or source file stem) this search came
   * from — the configure UI groups searches by it. */
  readonly group?: string;
  /** Skip listings priced above this (per-target override). */
  readonly maxBuy?: { readonly amount: number; readonly currency: string };
  /** Per-target minimum profit margin override, percent. */
  readonly minMarginPct?: number;
}

export interface FolderFile {
  readonly path: string;
  readonly content: string;
}

const locationString = z
  .string()
  .transform((loc) => loc.split(':'))
  .pipe(z.array(z.string()).min(2).max(3));

const exportV3Schema = z.object({
  tit: z.string().default(''),
  trs: z.array(z.object({ tit: z.string().default(''), loc: locationString })),
});

const exportV2Schema = z.object({
  title: z.string().default(''),
  trades: z.array(
    z.object({
      title: z.string().default(''),
      location: z.object({ slug: z.string(), version: z.string().optional() }),
    }),
  ),
});

interface DecodedTrade {
  readonly folderTitle: string;
  readonly tradeTitle: string;
  readonly slug: string;
  readonly version: string;
}

function decodePayload(json: unknown): readonly DecodedTrade[] | null {
  const v3 = exportV3Schema.safeParse(json);
  if (v3.success) {
    return v3.data.trs.map((t) => {
      // loc is "version:type:slug", or "type:slug" in the oldest payloads.
      const parts = t.loc;
      const slug = parts[parts.length - 1]!;
      const version = parts.length === 3 ? parts[0]! : '1';
      return { folderTitle: v3.data.tit, tradeTitle: t.tit, slug, version };
    });
  }
  const v2 = exportV2Schema.safeParse(json);
  if (v2.success) {
    return v2.data.trades.map((t) => ({
      folderTitle: v2.data.title,
      tradeTitle: t.title,
      slug: t.location.slug,
      version: t.location.version ?? '1',
    }));
  }
  return null;
}

function toTarget(trade: DecodedTrade): SnipeTarget {
  const label = [trade.folderTitle, trade.tradeTitle].filter((s) => s !== '').join(' · ');
  return {
    label: label === '' ? trade.slug : label,
    realm: trade.version === '2' ? 'trade2' : 'trade',
    searchId: trade.slug,
    league: null,
    ...(trade.folderTitle === '' ? {} : { group: trade.folderTitle }),
  };
}

const EXPORT_PATTERN = /^([23]):([A-Za-z0-9+/=_-]+)$/;

/** Decode one Better Trading folder-export string into snipe targets. */
export function decodeBetterTradingExport(exportString: string): readonly SnipeTarget[] {
  const match = EXPORT_PATTERN.exec(exportString.trim());
  if (match === null) {
    throw new Error('Not a Better Trading export string — expected "2:<base64>" or "3:<base64>" as copied from the extension\'s folder export.');
  }
  let json: unknown;
  try {
    json = JSON.parse(Buffer.from(match[2]!, 'base64').toString('utf8'));
  } catch {
    throw new Error('Better Trading export did not decode to JSON — re-copy it from the extension.');
  }
  const trades = decodePayload(json);
  if (trades === null) {
    throw new Error('Better Trading export decoded, but its shape was not recognized (expected folder with trades).');
  }
  return trades.map(toTarget);
}

const URL_IN_TEXT = /https?:\/\/(?:www\.)?pathofexile\.com\/trade2?\/search\/\S+/g;

function labelFromLine(line: string, url: string, fallback: string): string {
  const withoutUrl = line.replace(url, '').replace(/\|/g, ' ').trim();
  return withoutUrl === '' ? fallback : withoutUrl;
}

/** Extract targets from a plain-text file: one trade URL per line with an
 * optional `| label`, plus any embedded extension export strings. */
export function targetsFromText(content: string, fileStem: string): readonly SnipeTarget[] {
  const targets: SnipeTarget[] = [];
  for (const rawLine of content.split('\n')) {
    const line = rawLine.trim();
    if (line === '' || line.startsWith('#')) continue;
    if (EXPORT_PATTERN.test(line)) {
      targets.push(...decodeBetterTradingExport(line));
      continue;
    }
    for (const url of line.match(URL_IN_TEXT) ?? []) {
      const parsed = parseTradeUrl(url);
      targets.push({
        label: labelFromLine(line, url, fileStem),
        realm: parsed.realm,
        searchId: parsed.searchId,
        league: parsed.league,
      });
    }
  }
  return targets;
}

const jsonTargetSchema = z
  .object({
    label: z.string().optional(),
    url: z.string().optional(),
    slug: z.string().optional(),
    realm: z.enum(['trade', 'trade2']).optional(),
    league: z.string().optional(),
    maxBuy: z.object({ amount: z.number().positive(), currency: z.string().min(1) }).optional(),
    minMarginPct: z.number().optional(),
  })
  .refine((t) => t.url !== undefined || t.slug !== undefined, {
    message: 'each target needs a url or slug',
  });

const jsonFileSchema = z.union([
  z.object({ targets: z.array(jsonTargetSchema) }).transform((o) => o.targets),
  z.array(jsonTargetSchema),
]);

/** Parse a structured JSON file: `{ targets: [...] }` or a bare array, each
 * entry a url or slug with optional per-target maxBuy / minMarginPct. */
export function targetsFromJson(content: string, fileStem: string): readonly SnipeTarget[] {
  const parsed = jsonFileSchema.safeParse(JSON.parse(content));
  if (!parsed.success) {
    throw new Error(`invalid snipe JSON: ${parsed.error.issues[0]?.message ?? 'unknown error'}`);
  }
  return parsed.data.map((t) => {
    const fromUrl = t.url === undefined ? null : parseTradeUrl(t.url);
    return {
      label: t.label ?? fileStem,
      realm: fromUrl?.realm ?? t.realm ?? 'trade',
      searchId: fromUrl?.searchId ?? t.slug!,
      league: fromUrl?.league ?? t.league ?? null,
      ...(t.maxBuy === undefined ? {} : { maxBuy: t.maxBuy }),
      ...(t.minMarginPct === undefined ? {} : { minMarginPct: t.minMarginPct }),
    };
  });
}

/** Validate one import source with the same parsers used by folder loading.
 * A lone extension export is decoded directly so its actionable error is not
 * flattened into an empty text file. */
export function parseSnipeSource(content: string, sourceName: string): readonly SnipeTarget[] {
  const trimmed = content.trim();
  const targets = EXPORT_PATTERN.test(trimmed)
    ? decodeBetterTradingExport(trimmed)
    : sourceName.toLowerCase().endsWith('.json')
      ? targetsFromJson(content, fileStem(sourceName))
      : targetsFromText(content, fileStem(sourceName));
  if (targets.length === 0) throw new Error(`No trade searches found in ${sourceName}`);
  return targets;
}

function fileStem(path: string): string {
  return basename(path, extname(path));
}

/** Parse every folder file into targets. Malformed files warn and are
 * skipped — one bad bookmark file must not kill the whole snipe session.
 * Duplicate searches (same realm+id) keep the first occurrence. */
export function loadSnipeFolder(
  files: readonly FolderFile[],
  warn: (message: string) => void,
  root?: string,
): readonly SnipeTarget[] {
  const all: SnipeTarget[] = [];
  for (const file of files) {
    try {
      let parsed = file.path.toLowerCase().endsWith('.json')
        ? targetsFromJson(file.content, fileStem(file.path))
        : targetsFromText(file.content, fileStem(file.path));
      if (root !== undefined) {
        // A file inside a subdirectory belongs to that directory's folder —
        // the directory wins over the payload title, so two imports of
        // same-titled Better Trading folders stay distinct groups.
        const rel = relative(root, file.path);
        const segments = rel.split(sep);
        if (!rel.startsWith('..') && segments.length > 1 && segments[0] !== '') {
          const dirGroup = segments[0]!;
          parsed = parsed.map((target) => ({ ...target, group: dirGroup }));
        }
      }
      all.push(...parsed);
    } catch (err) {
      warn(`skipping ${file.path}: ${err instanceof Error ? err.message : String(err)}`);
    }
  }
  const seen = new Set<string>();
  return all.filter((t) => {
    const key = `${t.realm}:${t.searchId}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

export interface ResolveFolderOptions {
  /** Explicit choice: --folder flag, else the env/file-resolved
   * config.snipe.folder. Env precedence lives in config.ts only. */
  readonly flagValue?: string | undefined;
  readonly cwd: string;
  readonly home: string;
  readonly exists?: (path: string) => boolean;
}

/** Where the BetterTrading folder lives: explicit choice → ./BetterTrading
 * (if present) → ~/.exilium/BetterTrading (scaffolded by the CLI when
 * missing). */
export function resolveSnipeFolder(opts: ResolveFolderOptions): string {
  const exists = opts.exists ?? existsSync;
  if (opts.flagValue !== undefined && opts.flagValue !== '') return opts.flagValue;
  const inCwd = join(opts.cwd, 'BetterTrading');
  if (exists(inCwd)) return inCwd;
  return join(opts.home, '.exilium', 'BetterTrading');
}

const SCAFFOLD_README = `Your BetterTrading folder — searches saved here are available in the per-run \`exilium snipe\` picker.

Three formats, mix freely (subfolders up to 3 deep are read too):

1. Plain text (.txt/.md): one trade search URL per line, optional "| label".
   https://www.pathofexile.com/trade/search/Allflame/AbC123xyz | Foil Mageblood under 140div

2. Better Trading extension exports (.txt/.bt): paste a folder export string
   ("3:..." from the extension's Export button) on its own line.

3. Structured JSON (.json) with per-search rules:
   { "targets": [ { "label": "Cheap Valdo boxes",
                    "url": "https://www.pathofexile.com/trade/search/Allflame/AbC123xyz",
                    "maxBuy": { "amount": 30, "currency": "divine" },
                    "minMarginPct": 25 } ] }

Lines starting with # are comments. Searches default to the Allflame league
regardless of the league in the URL (search ids are league-portable);
use --keep-league to keep each URL's own league.
`;

const SCAFFOLD_SAMPLE = `# Uncomment (remove the leading #) and replace with your own searches:
# https://www.pathofexile.com/trade/search/Allflame/AbC123xyz | Foil uniques under value
# 3:PASTE_A_BETTER_TRADING_EXPORT_STRING_HERE
`;

/** First-run scaffold: create the folder with a README and a commented
 * sample so `exilium snipe` has something to point the user at. Returns the
 * files written. */
export function scaffoldSnipeFolder(dir: string): readonly string[] {
  mkdirSync(dir, { recursive: true });
  const files = [
    { path: join(dir, 'README.txt'), content: SCAFFOLD_README },
    { path: join(dir, 'my-snipes.txt'), content: SCAFFOLD_SAMPLE },
  ];
  for (const f of files) writeFileSync(f.path, f.content, { flag: 'wx' });
  return files.map((f) => f.path);
}

const READABLE_EXTENSIONS = new Set(['.txt', '.md', '.bt', '.json']);
const MAX_DEPTH = 3;

/** Read every parseable file under the folder (depth ≤ 3; hidden files and
 * READMEs skipped — READMEs document formats with example URLs that must
 * never become live targets). */
export function readSnipeFolderFiles(dir: string, depth = 0): readonly FolderFile[] {
  if (depth > MAX_DEPTH) return [];
  const files: FolderFile[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.name.startsWith('.') || /^readme\./i.test(entry.name)) continue;
    const path = join(dir, entry.name);
    if (entry.isDirectory()) {
      files.push(...readSnipeFolderFiles(path, depth + 1));
    } else if (READABLE_EXTENSIONS.has(extname(entry.name).toLowerCase())) {
      files.push({ path, content: readFileSync(path, 'utf8') });
    }
  }
  return files;
}
