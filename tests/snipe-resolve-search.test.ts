import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, test, vi } from 'vitest';
import { decodeQuerySlug, isCompressedQuerySlug, resolveSearchIds } from '../src/snipe/resolve-search.js';

// Real Better Trading export slug (Headhunter map-reward search, old
// gzip OS/version byte 0x0a that the site migrates lossily).
const HEADHUNTER = 'H4sIAAAAAAAACl2NUQqAIBAF7_K-O4En6A4RseVGgamsKxHi3cO-qvkb5mMKkpLmBFMQou7BwyDxkoVmx6jd0xPMUKBXZBiQt-iw7k5ZWhjr-NKCg-L00l9ZwhEdt9EkfJLYz7lnslv2yoLauAGHcMZZnwAAAA';
const search = (searchId: string) => ({ realm: 'trade' as const, league: 'Covens', searchId });
const cachePath = () => join(mkdtempSync(join(tmpdir(), 'exilium-resolve-')), 'search-ids.json');
const ok = (id: string) => new Response(JSON.stringify({ id, result: [] }), { status: 200 });

describe('compressed search slugs', () => {
  test('decodes the full query, filters included', () => {
    expect(isCompressedQuerySlug(HEADHUNTER)).toBe(true);
    expect(isCompressedQuerySlug('Z6EnYYr0uQ')).toBe(false);
    expect(decodeQuerySlug(HEADHUNTER)).toMatchObject({
      filters: { map_filters: { filters: { map_completion_reward: { option: 'Headhunter' } } } },
    });
  });

  test('POSTs the decoded query once, swaps in the id, and caches it', async () => {
    const path = cachePath();
    const post = vi.fn().mockResolvedValue(ok('NewId123'));
    const first = await resolveSearchIds([search(HEADHUNTER), search('Z6EnYYr0uQ')], { cachePath: path, post, log: () => {} });
    expect(first.map((s) => s.searchId)).toEqual(['NewId123', 'Z6EnYYr0uQ']);
    expect(post).toHaveBeenCalledTimes(1);
    const [url, body] = post.mock.calls[0]!;
    expect(url).toBe('https://www.pathofexile.com/api/trade/search/Covens');
    expect(JSON.parse(body).query.filters.map_filters.filters.map_completion_reward.option).toBe('Headhunter');

    const again = await resolveSearchIds([search(HEADHUNTER)], { cachePath: path, post, log: () => {} });
    expect(again[0]!.searchId).toBe('NewId123');
    expect(post).toHaveBeenCalledTimes(1);
    expect(Object.values(JSON.parse(readFileSync(path, 'utf8')))).toEqual(['NewId123']);
  });

  test('a different league resolves separately', async () => {
    const path = cachePath();
    const post = vi.fn().mockResolvedValueOnce(ok('A')).mockResolvedValueOnce(ok('B'));
    await resolveSearchIds([search(HEADHUNTER)], { cachePath: path, post, log: () => {} });
    const other = await resolveSearchIds([{ ...search(HEADHUNTER), league: 'Standard' }], { cachePath: path, post, log: () => {} });
    expect(other[0]!.searchId).toBe('B');
  });

  test('failures keep the slug, log, and never throw', async () => {
    const path = cachePath();
    writeFileSync(path, 'not json');
    const log = vi.fn();
    const out = await resolveSearchIds([search(HEADHUNTER), search('H4sIgarbage')], {
      cachePath: path, post: vi.fn().mockResolvedValue(new Response('', { status: 500 })), log,
    });
    expect(out.map((s) => s.searchId)).toEqual([HEADHUNTER, 'H4sIgarbage']);
    expect(log).toHaveBeenCalledTimes(2);
  });

  test('a 429 stops further resolution for the session instead of retrying each search', async () => {
    const other = 'H4sIAAAAAAAACl2NQQqEMBAEvyJ99gX5hrAXERl1hEBiQmaCLCF_l3hS-1ZdhyoQJc0CUxCi2nDAQHjNiRbHqP3tBWYs0H9kGNCxocdunXJqYqrTAws8xfmBH7MGHx230Jz4pLS9ykNenPXc_ay0o7ZdgUd3SaMAAAA';
    const post = vi.fn().mockResolvedValue(new Response('', { status: 429 }));
    const log = vi.fn();
    const out = await resolveSearchIds([search(HEADHUNTER), search(other)], { cachePath: cachePath(), post, log });
    expect(post).toHaveBeenCalledTimes(1);
    expect(out.map((s) => s.searchId)).toEqual([HEADHUNTER, other]);
    expect(String(log.mock.calls.at(-1)![0])).toMatch(/rate.limit/i);
  });

  test('no compressed slugs means no network and no cache file', async () => {
    const post = vi.fn();
    const input = [search('Z6EnYYr0uQ')];
    expect(await resolveSearchIds(input, { cachePath: cachePath(), post, log: () => {} })).toBe(input);
    expect(post).not.toHaveBeenCalled();
  });
});
