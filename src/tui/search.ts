/** Token-AND substring match: every whitespace-separated word in the query
 * must appear somewhere in the haystack. This is what lets "empower 4" match
 * "Awakened Empower Support (4)" — the words don't need to be contiguous, so
 * a gem's base name and its level/quality variant match independently. */
export function matchesSearch(haystack: string, query: string): boolean {
  const tokens = query.toLowerCase().split(/\s+/).filter((t) => t !== '');
  if (tokens.length === 0) return true;
  const hay = haystack.toLowerCase();
  return tokens.every((t) => hay.includes(t));
}
