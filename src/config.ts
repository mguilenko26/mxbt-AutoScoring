/** Конфигурация из переменных окружения (см. .env.example и deploy/env.production.example). */
export interface WebhookConfig {
  /** Публичный адрес: https://bot.example.com */
  domain: string;
  /** Путь, на который MAX присылает события: /max/webhook */
  path: string;
  /** Значение заголовка X-Max-Bot-Api-Secret (5–256 символов [a-zA-Z0-9_-]). */
  secret: string;
}

export interface AppConfig {
  maxBotToken: string;
  /** Адрес API MAX; меняется только для тестов со стабом API. */
  maxApiUrl?: string;
  /** polling — для разработки; webhook — для продакшена (нужен публичный HTTPS). */
  maxMode: 'polling' | 'webhook';
  webhook?: WebhookConfig;
  /** polling: разрешить удалить существующие webhook-подписки бота. */
  dropWebhooks: boolean;
  /** Адрес HTTP-сервера бота. В продакшене — 127.0.0.1 (снаружи доступ только через nginx). */
  botHttpHost: string;
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

const SECRET_RE = /^[a-zA-Z0-9_-]{5,256}$/;

export function loadConfig(env = process.env): AppConfig {
  const maxMode = env.MAX_MODE === 'webhook' ? 'webhook' : 'polling';
  let webhook: WebhookConfig | undefined;
  if (maxMode === 'webhook') {
    const domain = required(env, 'MAX_WEBHOOK_DOMAIN').replace(/\/+$/, '');
    if (!/^https:\/\/[^/:]+$/.test(domain)) {
      throw new Error('MAX_WEBHOOK_DOMAIN должен быть вида https://bot.example.com (только HTTPS, без пути и порта)');
    }
    const secret = required(env, 'MAX_WEBHOOK_SECRET');
    if (!SECRET_RE.test(secret)) throw new Error('MAX_WEBHOOK_SECRET: 5–256 символов, только латиница, цифры, «_» и «-»');
    const path = env.MAX_WEBHOOK_PATH || '/max/webhook';
    if (!path.startsWith('/')) throw new Error('MAX_WEBHOOK_PATH должен начинаться с «/»');
    webhook = { domain, path, secret };
  }
  return {
    maxBotToken: required(env, 'MAX_BOT_TOKEN'),
    maxApiUrl: env.MAX_API_URL || undefined,
    maxMode,
    webhook,
    dropWebhooks: env.MAX_DROP_WEBHOOKS === '1',
    botHttpHost: env.BOT_HTTP_HOST || '0.0.0.0',
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

export const UPDATE_TYPES = ['bot_started', 'bot_stopped', 'message_created', 'message_callback'] as const;
