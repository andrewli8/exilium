import { describe, expect, test } from 'vitest';
import { resolveGlyphs, foldWith } from '../src/tui/glyphs.js';

const env = (o: Record<string, string> = {}): NodeJS.ProcessEnv => o;

describe('resolveGlyphs', () => {
  test('mac and linux get the full unicode set', () => {
    expect(resolveGlyphs({ platform: 'darwin', env: env() }).select).toBe('▶');
    expect(resolveGlyphs({ platform: 'linux', env: env() }).border).toBe('round');
    expect(resolveGlyphs({ platform: 'linux', env: env() }).spark[7]).toBe('█');
  });

  test('a bare legacy Windows console falls back to ASCII-safe glyphs', () => {
    const g = resolveGlyphs({ platform: 'win32', env: env() });
    expect(g.select).toBe('>');
    expect(g.sortDesc).toBe('v');
    expect(g.times).toBe('x');
    expect(g.border).toBe('single'); // round corners are not cp437-safe
    expect(g.spark.every((c) => c.charCodeAt(0) < 128)).toBe(true);
  });

  test('modern Windows terminals keep unicode', () => {
    expect(resolveGlyphs({ platform: 'win32', env: env({ WT_SESSION: 'abc' }) }).select).toBe('▶');
    expect(resolveGlyphs({ platform: 'win32', env: env({ TERM_PROGRAM: 'vscode' }) }).select).toBe('▶');
    expect(resolveGlyphs({ platform: 'win32', env: env({ ConEmuANSI: 'ON' }) }).select).toBe('▶');
    expect(resolveGlyphs({ platform: 'win32', env: env({ WSL_DISTRO_NAME: 'Ubuntu' }) }).select).toBe('▶');
  });

  test('EXILIUM_ASCII forces ASCII anywhere and wins over everything', () => {
    expect(resolveGlyphs({ platform: 'darwin', env: env({ EXILIUM_ASCII: '1' }) }).select).toBe('>');
    expect(resolveGlyphs({ platform: 'win32', env: env({ WT_SESSION: 'x', EXILIUM_ASCII: '1' }) }).select).toBe('>');
  });

  test('EXILIUM_UNICODE forces unicode on a legacy console', () => {
    expect(resolveGlyphs({ platform: 'win32', env: env({ EXILIUM_UNICODE: '1' }) }).select).toBe('▶');
  });
});

describe('foldWith', () => {
  test('unicode mode leaves the string untouched', () => {
    expect(foldWith(false, '▶ 50× · ↵ trade')).toBe('▶ 50× · ↵ trade');
  });

  test('ASCII mode maps every known glyph and leaves plain text intact', () => {
    expect(foldWith(true, '▶ Divine Orb')).toBe('> Divine Orb');
    expect(foldWith(true, '50× · ÷20')).toBe('50x | /20');
    expect(foldWith(true, '↑↓ scroll · ↵ open')).toBe('^v scroll | Enter open');
    expect(foldWith(true, 'edge ≥ 5% ± 1')).toBe('edge >= 5% +/- 1');
  });

  test('ASCII mode never emits a byte above 127', () => {
    const out = foldWith(true, '▶▌↵↑↓←→▲▼●·—–…×÷Δ⚠≥≤≈±▁▂▃▄▅▆▇█');
    expect([...out].every((c) => c.charCodeAt(0) < 128)).toBe(true);
  });
});
