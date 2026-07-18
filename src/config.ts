export interface ExiliumConfig {
  readonly dbPath: string;
  readonly userAgent: string;
  readonly league: string | null;
  readonly categories: readonly string[];
  readonly dashboardPort: number;
}

const DEFAULT_CATEGORIES = ['Currency', 'Runes', 'Essences', 'Delirium', 'Ritual', 'Expedition', 'Breach'] as const;

/** Read configuration from the environment with sane defaults.
 * EXILIUM_CONTACT should be set so poe.ninja can reach us (API etiquette). */
export function loadConfig(env: NodeJS.ProcessEnv): ExiliumConfig {
  const contact = env['EXILIUM_CONTACT'] ?? 'unset-contact';
  return {
    dbPath: env['EXILIUM_DB'] ?? 'exilium.db',
    userAgent: `Exilium/0.1.0 (contact: ${contact})`,
    league: env['EXILIUM_LEAGUE'] ?? null,
    categories: DEFAULT_CATEGORIES,
    dashboardPort: Number(env['EXILIUM_PORT'] ?? 4321),
  };
}
