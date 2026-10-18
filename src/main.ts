/**
 * Точка входа бота: MAX (polling/webhook) + HTTP-сервер для уведомлений эквайера.
 * Запуск: npm run bot (mock-сервисы должны быть запущены: npm run mocks) или npm run dev — всё сразу.
 */
import { Bot } from '@maxhub/max-bot-api';
import { InsuranceBot } from './bot/insurance-bot.js';
import { MemorySessionStore } from './bot/session.js';
import { loadConfig, type AppConfig } from './config.js';
import { createBotHttpServer } from './http.js';
import { MaxMessenger, toInboundEvent } from './messenger/max.js';
import { createHttpServices } from './services/http.js';
import { installExtraCa } from './tls-ca.js';

export async function startBot(cfg: AppConfig = loadConfig()) {
  installExtraCa(); // сертификаты Минцифры из ca/ — до первого запроса к API MAX
  const bot = new Bot(cfg.maxBotToken);
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

  await new Promise<void>((resolve) => createBotHttpServer(insurance, services.payments).listen(cfg.botHttpPort, resolve));
  console.log(`[bot] payment webhooks: http://localhost:${cfg.botHttpPort}/payments/webhook`);

  await bot.api.setMyCommands([{ name: 'start', description: 'Рассчитать страховку двигателя и КПП' }]).catch((e) => {
    console.warn('[max] setMyCommands failed', e?.message ?? e);
  });

  const info = await bot.api.getMyInfo();
  console.log(`[max] bot @${info.username} (${info.user_id}) starting in ${cfg.maxMode} mode`);
  void bot.start(
    cfg.maxMode === 'webhook'
      ? { mode: 'webhook', options: { ...cfg.webhook!, allowedUpdates: ['bot_started', 'bot_stopped', 'message_created', 'message_callback'] } }
      : { mode: 'polling', options: { allowedUpdates: ['bot_started', 'bot_stopped', 'message_created', 'message_callback'] } },
  );
  return { bot, insurance };
}

if (process.argv[1]?.endsWith('main.ts') || process.argv[1]?.endsWith('main.js')) {
  startBot().catch((e) => {
    console.error(e);
    process.exit(1);
  });
}
