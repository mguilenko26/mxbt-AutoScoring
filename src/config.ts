/** Конфигурация из переменных окружения (см. .env.example). */
export interface AppConfig {
  maxBotToken: string;
  /** polling — для разработки; webhook — для продакшена (нужен публичный HTTPS). */
  maxMode: 'polling' | 'webhook';
  webhook?: { domain: string; port: number; path?: string; secret?: string };
  /** polling: разрешить удалить существующие webhook-подписки бота. */
  dropWebhooks: boolean;
  botHttpPort: number;
  mocksBaseUrl: string;
  paymentWebhookSecret: string;
  paymentShortcuts: boolean;
  policyUrl: string;
  progressIntervalMs: number;
  pricingPollMs: number;
  scoringTimeoutMs: number;
}

function required(env: NodeJS.ProcessEnv, name: string): string {
  const v = env[name];
  if (!v) throw new Error(`Не задана переменная окружения ${name} (см. .env.example)`);
  return v;
}

export function loadConfig(env = process.env): AppConfig {
  const maxMode = env.MAX_MODE === 'webhook' ? 'webhook' : 'polling';
  return {
    maxBotToken: required(env, 'MAX_BOT_TOKEN'),
    maxMode,
    webhook: maxMode === 'webhook'
      ? {
          domain: required(env, 'MAX_WEBHOOK_DOMAIN'),
          port: Number(env.MAX_WEBHOOK_PORT ?? 3001),
          path: env.MAX_WEBHOOK_PATH,
          secret: env.MAX_WEBHOOK_SECRET,
        }
      : undefined,
    dropWebhooks: env.MAX_DROP_WEBHOOKS === '1',
    botHttpPort: Number(env.BOT_HTTP_PORT ?? 3000),
    mocksBaseUrl: env.MOCKS_BASE_URL ?? `http://localhost:${env.MOCKS_PORT ?? 4000}`,
    paymentWebhookSecret: env.PAYMENT_WEBHOOK_SECRET ?? 'mock-secret',
    paymentShortcuts: env.PAYMENT_SHORTCUTS !== '0',
    policyUrl: env.POLICY_URL ?? 'https://example.com/privacy',
    progressIntervalMs: Number(env.PROGRESS_INTERVAL_MS ?? 2000),
    pricingPollMs: Number(env.PRICING_POLL_MS ?? 2000),
    scoringTimeoutMs: Number(env.SCORING_TIMEOUT_MS ?? 10 * 60_000),
  };
}
