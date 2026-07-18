import { z } from 'zod';
import type { Game, League } from '../../domain/types.js';

const leaguesSchema = z.array(z.object({ id: z.string(), name: z.string() }));

export type FetchFn = (url: string, init: { headers: Record<string, string> }) => Promise<Response>;

export interface NinjaClientOptions {
  readonly fetchFn?: FetchFn;
  readonly baseUrl?: string;
  readonly userAgent: string;
}

const DEFAULT_BASE_URL = 'https://poe.ninja';

/** Thin poe.ninja PoE2 economy API client. Identifies itself via User-Agent
 * per API etiquette; callers own caching/cadence (PRD: MCP never triggers
 * upstream calls — only the ingestion path uses this client). */
export class NinjaClient {
  private readonly fetchFn: FetchFn;
  private readonly baseUrl: string;
  private readonly userAgent: string;

  constructor(opts: NinjaClientOptions) {
    this.fetchFn = opts.fetchFn ?? ((url, init) => fetch(url, init));
    this.baseUrl = opts.baseUrl ?? DEFAULT_BASE_URL;
    this.userAgent = opts.userAgent;
  }

  async getLeagues(game: Game): Promise<readonly League[]> {
    const body = await this.getJson(`/${game}/api/economy/leagues`);
    const parsed = leaguesSchema.safeParse(body);
    if (!parsed.success) throw new Error('poe.ninja leagues response did not match expected shape');
    return parsed.data;
  }

  async getExchangeOverview(game: Game, league: string, type: string): Promise<unknown> {
    const params = new URLSearchParams({ league, type });
    return this.getJson(`/${game}/api/economy/exchange/current/overview?${params.toString()}`);
  }

  private async getJson(path: string): Promise<unknown> {
    const url = `${this.baseUrl}${path}`;
    const res = await this.fetchFn(url, { headers: { 'User-Agent': this.userAgent } });
    if (!res.ok) {
      throw new Error(`poe.ninja request failed (${res.status}) for ${url}`);
    }
    return res.json();
  }
}
