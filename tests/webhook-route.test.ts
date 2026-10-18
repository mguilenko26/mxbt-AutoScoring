/**
 * Режим webhook: события MAX принимает HTTP-сервер бота на MAX_WEBHOOK_PATH,
 * секрет X-Max-Bot-Api-Secret проверяет библиотека MAX.
 */
import type { AddressInfo } from 'node:net';
import { Bot } from '@maxhub/max-bot-api';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { loadConfig } from '../src/config.js';
import { createBotHttpServer } from '../src/http.js';
import { toInboundEvent } from '../src/messenger/max.js';
import type { InboundEvent } from '../src/messenger/types.js';
import type { PaymentProvider } from '../src/services/ports.js';

const SECRET = 'test_webhook-secret';
const received: InboundEvent[] = [];
let base: string;
let server: ReturnType<typeof createBotHttpServer>;

beforeAll(async () => {
  const bot = new Bot('dummy-token');
  bot.use(async (ctx) => {
    const e = toInboundEvent(ctx.update as never);
    if (e) received.push(e);
  });
  const handler = bot.webhookCallback({ domain: 'https://bot.example.com', path: '/max/webhook', secret: SECRET });
  const payments = { parseWebhook: () => null } as unknown as PaymentProvider;
  server = createBotHttpServer({} as never, payments, { warn: () => undefined, error: () => undefined }, { path: '/max/webhook', handler });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterAll(() => server.close());

const update = {
  update_type: 'bot_started',
  timestamp: Date.now(),
  chat_id: 7,
  user: { user_id: 42, first_name: 'Иван', is_bot: false },
};

describe('маршрут webhook MAX', () => {
  it('принимает событие с верным секретом и отвечает 200 сразу', async () => {
    const r = await fetch(`${base}/max/webhook`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-max-bot-api-secret': SECRET },
      body: JSON.stringify(update),
    });
    expect(r.status).toBe(200);
    await new Promise((res) => setTimeout(res, 50));
    expect(received).toEqual([{ type: 'start', user: { userId: 42, chatId: 7, firstName: 'Иван', username: undefined }, payload: undefined }]);
  });

  it('отклоняет запрос без секрета или с чужим', async () => {
    for (const headers of [{}, { 'x-max-bot-api-secret': 'wrong-secret' }] as Record<string, string>[]) {
      const r = await fetch(`${base}/max/webhook`, { method: 'POST', headers, body: JSON.stringify(update) });
      expect(r.status).toBe(404);
    }
    expect(received).toHaveLength(1);
  });

  it('health и неизвестные пути работают как раньше', async () => {
    expect((await fetch(`${base}/health`)).status).toBe(200);
    expect((await fetch(`${base}/other`)).status).toBe(404);
  });
});

describe('конфигурация webhook', () => {
  const env = { MAX_BOT_TOKEN: 't', MAX_MODE: 'webhook', MAX_WEBHOOK_DOMAIN: 'https://bot.example.com/', MAX_WEBHOOK_SECRET: SECRET };
  it('значения по умолчанию', () => {
    expect(loadConfig(env).webhook).toEqual({ domain: 'https://bot.example.com', path: '/max/webhook', secret: SECRET });
  });
  it('отклоняет HTTP, порт, путь в домене и плохой секрет', () => {
    expect(() => loadConfig({ ...env, MAX_WEBHOOK_DOMAIN: 'http://bot.example.com' })).toThrow(/HTTPS/);
    expect(() => loadConfig({ ...env, MAX_WEBHOOK_DOMAIN: 'https://bot.example.com:8443' })).toThrow();
    expect(() => loadConfig({ ...env, MAX_WEBHOOK_SECRET: 'abc' })).toThrow(/5–256/);
    expect(() => loadConfig({ ...env, MAX_WEBHOOK_SECRET: undefined })).toThrow(/MAX_WEBHOOK_SECRET/);
  });
});
