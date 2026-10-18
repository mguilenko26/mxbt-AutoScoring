/**
 * Точка входа бота: MAX (polling или webhook) + HTTP-сервер (webhook MAX, уведомления эквайера, /health).
 * Запуск: npm run bot (mock-сервисы должны быть запущены: npm run mocks) или npm run dev — всё сразу.
 */
import type { Server } from 'node:http';
import { Bot } from '@maxhub/max-bot-api';
import { InsuranceBot } from './bot/insurance-bot.js';
import { MemorySessionStore } from './bot/session.js';
import { loadConfig, UPDATE_TYPES, type AppConfig } from './config.js';
import { createBotHttpServer, type MaxWebhookRoute } from './http.js';
import { MaxMessenger, toInboundEvent } from './messenger/max.js';
import { createHttpServices } from './services/http.js';
import { installExtraCa } from './tls-ca.js';

export async function startBot(cfg: AppConfig = loadConfig()) {
  installExtraCa(); // сертификаты Минцифры из ca/ — до первого запроса к API MAX
  const bot = new Bot(cfg.maxBotToken, cfg.maxApiUrl ? { clientOptions: { baseUrl: cfg.maxApiUrl } } : undefined);
  const services = createHttpServices({ mocksBaseUrl: cfg.mocksBaseUrl, paymentWebhookSecret: cfg.paymentWebhookSecret });

  const insurance = new InsuranceBot({
    messenger: new MaxMessenger(bot),
    services,
    store: new MemorySessionStore(), // TODO: Redis/Postgres — сейчас состояние теряется при перезапуске
    config: {
      botToken: cfg.maxBotToken,
      policyUrl: cfg.policyUrl,
      progressIntervalMs: cfg.progressIntervalMs,
      pricingPollMs: cfg.pricingPollMs,
      scoringTimeoutMs: cfg.scoringTimeoutMs,
      paymentShortcuts: cfg.paymentShortcuts,
    },
    simulatePayment: (id, outcome) => services.payments.simulate(id, outcome),
  });

  bot.use(async (ctx) => {
    const event = toInboundEvent(ctx.update as never);
    if (event) await insurance.handle(event);
  });
  bot.catch((err) => console.error('[max] unhandled error', err));

  const info = await bot.api.getMyInfo();
  bot.botInfo = info;

  // Маршрут для событий MAX: принимает тот же HTTP-сервер бота (в продакшене он слушает 127.0.0.1 за nginx).
  let maxWebhook: MaxWebhookRoute | undefined;
  if (cfg.maxMode === 'webhook') {
    const { domain, path, secret } = cfg.webhook!;
    maxWebhook = { path, handler: bot.webhookCallback({ domain, path, secret }) };
  }

  const server = createBotHttpServer(insurance, services.payments, console, maxWebhook);
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(cfg.botHttpPort, cfg.botHttpHost, resolve);
  });
  console.log(`[bot] HTTP ${cfg.botHttpHost}:${cfg.botHttpPort} — /health, /payments/webhook${maxWebhook ? `, ${maxWebhook.path}` : ''}`);

  await bot.api.setMyCommands([{ name: 'start', description: 'Рассчитать страховку двигателя и КПП' }]).catch((e) => {
    console.warn('[max] setMyCommands failed', e?.message ?? e);
  });

  const subs = await bot.api.getSubscriptions();

  if (cfg.maxMode === 'webhook') {
    const url = `${cfg.webhook!.domain}${cfg.webhook!.path}`;
    const res = await bot.api.subscribe(url, cfg.webhook!.secret, [...UPDATE_TYPES]);
    if (res && res.success === false) throw new Error(`MAX не принял webhook ${url}: ${res.message ?? 'ошибка'}`);
    // Одновременно может работать только один способ доставки — оставляем только свою подписку.
    for (const s of subs.filter((x) => x.url !== url)) {
      console.warn(`[max] удаляю чужую webhook-подписку ${s.url}`);
      await bot.api.unsubscribe(s.url).catch((e) => console.warn('[max] unsubscribe failed', e?.message ?? e));
    }
    console.log(`[max] bot @${info.username} (${info.user_id}) — webhook ${url}`);
  } else {
    // В режиме polling библиотека MAX удаляет ВСЕ webhook-подписки бота. Не делаем этого молча:
    // webhook может обслуживать другой сервис (например, продакшен).
    if (subs.length > 0 && !cfg.dropWebhooks) {
      console.error(
        `[max] У бота @${info.username} настроен webhook:\n${subs.map((s) => `   • ${s.url}`).join('\n')}\n` +
          '[max] В режиме polling он будет удалён, и события перестанут приходить на этот адрес.\n' +
          '[max] Чтобы продолжить: удалите подписки (npm run webhooks -- delete-all) или задайте MAX_DROP_WEBHOOKS=1 в .env.',
      );
      process.exit(2);
    }
    if (subs.length > 0) console.warn(`[max] удаляю webhook-подписки: ${subs.map((s) => s.url).join(', ')}`);
    console.log(`[max] bot @${info.username} (${info.user_id}) — long polling`);
    void bot.start({ mode: 'polling', options: { allowedUpdates: [...UPDATE_TYPES] } });
  }

  installShutdown(bot, server, cfg);
  return { bot, insurance, server };
}

/**
 * Остановка по SIGTERM (systemctl stop/restart) и Ctrl+C.
 * Webhook-подписку НЕ удаляем: пока бот перезапускается, MAX повторит доставку (до 10 раз, от 60 с).
 */
function installShutdown(bot: Bot, server: Server, cfg: AppConfig) {
  let stopping = false;
  const stop = (signal: string) => {
    if (stopping) return;
    stopping = true;
    console.log(`[bot] ${signal}: останавливаюсь`);
    if (cfg.maxMode === 'polling') bot.stopPolling();
    server.close(() => process.exit(0));
    setTimeout(() => process.exit(0), 5000).unref();
  };
  process.once('SIGTERM', () => stop('SIGTERM'));
  process.once('SIGINT', () => stop('SIGINT'));
}

if (process.argv[1]?.endsWith('main.ts') || process.argv[1]?.endsWith('main.js')) {
  startBot().catch((e) => {
    console.error(e);
    process.exit(1);
  });
}
