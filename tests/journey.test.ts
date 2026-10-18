/**
 * Сквозной клиентский путь без MAX: настоящий mock-сервер (HTTP) + HTTP-сервер бота для webhook оплаты +
 * мессенджер-двойник вместо MAX.
 */
import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createMockServer } from '../mocks/server.js';
import { InsuranceBot } from '../src/bot/insurance-bot.js';
import { MemorySessionStore } from '../src/bot/session.js';
import { contactHash } from '../src/bot/contact.js';
import { createBotHttpServer } from '../src/http.js';
import { createHttpServices } from '../src/services/http.js';
import type { UserRef } from '../src/messenger/types.js';
import { FakeMessenger } from './fake-messenger.js';

const TOKEN = 'test-bot-token';
const SECRET = 'test-secret';
const user: UserRef = { userId: 1001, chatId: 5001, firstName: 'Иван' };

let mocks: Server;
let botHttp: Server;
let messenger: FakeMessenger;
let bot: InsuranceBot;
let store: MemorySessionStore;

const listen = (s: Server) => new Promise<number>((r) => s.listen(0, () => r((s.address() as AddressInfo).port)));

async function waitFor<T>(fn: () => T | undefined | false, timeoutMs = 8000): Promise<T> {
  const until = Date.now() + timeoutMs;
  for (;;) {
    const v = fn();
    if (v) return v;
    if (Date.now() > until) throw new Error(`timeout. Messages:\n${messenger.texts().join('\n---\n')}`);
    await new Promise((r) => setTimeout(r, 20));
  }
}

const lastText = () => messenger.current(messenger.last()).text;
const say = (text: string) => bot.handle({ type: 'text', user, text });
const press = (label: string) => bot.handle(messenger.press(user, label));
const shareContact = (phone = '79161234567') => {
  const vcfInfo = `BEGIN:VCARD\\r\\nVERSION:3.0\\r\\nFN:Иван\\r\\nTEL;TYPE=cell:${phone}\\r\\nEND:VCARD`;
  return bot.handle({ type: 'contact', user, contact: { vcfInfo, hash: contactHash(vcfInfo, TOKEN).hex, maxInfo: { user_id: user.userId } } });
};

beforeAll(async () => {
  botHttp = createBotHttpServer({ onPaymentEvent: (e) => bot.onPaymentEvent(e) } as InsuranceBot,
    createHttpServices({ mocksBaseUrl: 'http://unused', paymentWebhookSecret: SECRET }).payments);
  const botPort = await listen(botHttp);
  mocks = createMockServer({
    port: 0, publicUrl: 'http://mocks.local', paymentWebhookUrl: `http://localhost:${botPort}/payments/webhook`,
    paymentWebhookSecret: SECRET, lookupDelayMs: 0, enrichDelayMs: 50, pricingDelayMs: 600, pricingSlowMs: 5000, log: false,
  });
  const mocksPort = await listen(mocks);
  process.env.__MOCKS_URL = `http://localhost:${mocksPort}`;
});

afterAll(() => {
  mocks.close();
  botHttp.close();
});

beforeEach(() => {
  messenger = new FakeMessenger();
  store = new MemorySessionStore();
  const services = createHttpServices({ mocksBaseUrl: process.env.__MOCKS_URL!, paymentWebhookSecret: SECRET });
  bot = new InsuranceBot({
    messenger, services, store,
    config: { botToken: TOKEN, policyUrl: 'https://example.com/pd', progressIntervalMs: 1500, pricingPollMs: 50, scoringTimeoutMs: 10_000, paymentShortcuts: true },
    simulatePayment: (id, outcome) => services.payments.simulate(id, outcome),
    log: () => undefined,
  });
});

afterEach(async () => {
  await bot.idle();
});

describe('клиентский путь', () => {
  it('VIN → подтверждение → пропуск телефона → предложение → телефон при покупке → оплата', async () => {
    await bot.handle({ type: 'start', user });
    expect(lastText()).toContain('Иван, здравствуйте');

    await press('Рассчитать стоимость');
    await press('Ввести VIN');
    await say('jtnb23hk103012345');
    expect(lastText()).toContain('Toyota Camry, 2019');
    expect(lastText()).toContain('JTNB23HK103012345'); // VIN введён клиентом — показываем полностью

    await press('Да, верно');
    expect(messenger.messages.at(-2)!.edits.at(-1)!.text).toContain('✔️ _✅ Да, верно_'); // вопрос «заморожен»
    await say('85 тыс');
    expect(lastText()).toContain('Поделитесь номером');

    await press('Пропустить');
    const progress = messenger.last();
    expect(messenger.current(progress).text).toContain('%');

    const offer = await waitFor(() => messenger.messages.find((m) => m.msg.text.includes('Ваше предложение готово')));
    expect(messenger.current(progress).text).toContain('Расчёт готов');
    expect(offer.msg.notify ?? true).toBe(true); // новое сообщение → push
    expect(offer.msg.text).toMatch(/оплата за год/);
    expect(offer.msg.text).toMatch(/₽\/мес/);

    const session = (await store.get(user.userId))!;
    expect(session.quote!.annualPrice).toBeGreaterThan(0);
    expect(session.quote!.monthlyPrice * 12).toBeGreaterThan(session.quote!.annualPrice);

    await press('За год');
    expect(lastText()).toContain('Для оформления полиса нужен номер');
    await shareContact();
    expect((await store.get(user.userId))!.phone).toEqual({ value: '79161234567', verified: true });
    expect(lastText()).toContain('Оплата полиса на год');
    expect(messenger.last().msg.buttons!.flat().some((b) => b.type === 'link' && b.url.startsWith('http://mocks.local/pay/'))).toBe(true);

    await press('Оплата успешна');
    await waitFor(() => lastText().includes('Оплата прошла'));
    expect((await store.get(user.userId))!.step).toBe('paid');
    expect(lastText()).toMatch(/AS-\d{4}-[0-9A-F]{6}/);
  });

  it('госномер с несколькими VIN → выбор → «нет, исправить» → ручные данные → телефон → помесячно с отказом банка', async () => {
    await bot.handle({ type: 'start', user });
    await press('Рассчитать стоимость');
    await say('в222вв99'); // госномер можно прислать сразу, без выбора кнопкой
    expect(lastText()).toContain('несколько автомобилей');
    await press('…123456'); // Hyundai Solaris
    expect(lastText()).toContain('Hyundai Solaris, 2014');
    expect(lastText()).toContain('Z94*********23456'); // найден по номеру — маска

    await press('Нет, исправить');
    await say('Hyundai Solaris');
    await say('2015');
    await say('140000');
    await shareContact();
    await waitFor(() => messenger.messages.find((m) => m.msg.text.includes('Ваше предложение готово')));

    const s = (await store.get(user.userId))!;
    expect(s.vehicle.year.map((c) => `${c.source}=${c.value}`)).toEqual(['vin_service=2014', 'client=2015']);

    await press('Помесячно');
    expect(lastText()).toContain('Первый платёж');
    await press('Отказ банка');
    await waitFor(() => lastText().includes('Оплата не прошла'));
    await press('Попробовать снова');
    expect(lastText()).toContain('Первый платёж');
  });

  it('номер не найден → просим VIN; VIN без данных → ручной ввод', async () => {
    await bot.handle({ type: 'start', user });
    await press('Рассчитать стоимость');
    await press('Ввести госномер');
    await say('С333СС50');
    expect(lastText()).toContain('не нашёлся');
    await say('WVWZZZ1KZ6B100000');
    expect(lastText()).toContain('данных о модели в базе нет');
    await say('Volkswagen Golf');
    expect(lastText()).toContain('год выпуска');
  });

  it('понятные ошибки ввода', async () => {
    await bot.handle({ type: 'start', user });
    await press('Рассчитать стоимость');
    await press('Ввести VIN');
    await say('XW8ZZZ61ZJGO12345');
    expect(lastText()).toContain('I, O и Q');
    await say('123');
    expect(lastText()).toContain('17 символов');
  });

  it('сбой прайсинга → сообщение с повтором', async () => {
    await bot.handle({ type: 'start', user });
    await press('Рассчитать стоимость');
    await say('XW8ZZZ61ZJG099999');
    await press('Да, верно');
    await say('50000');
    await press('Пропустить');
    await waitFor(() => lastText().includes('технической ошибки'));
    expect(messenger.last().msg.buttons!.flat().map((b) => b.text)).toContain('🔁 Повторить расчёт');
  });

  it('новый /start во время расчёта останавливает старый расчёт; старые кнопки устаревают', async () => {
    await bot.handle({ type: 'start', user });
    await press('Рассчитать стоимость');
    const staleCallback = messenger.press(user, 'Ввести VIN');
    await say('XW8ZZZ61ZJG012345');
    await press('Да, верно');
    await say('50000');
    await press('Пропустить');
    await bot.handle({ type: 'start', user });
    await bot.idle();
    expect(messenger.texts().some((t) => t.includes('Ваше предложение готово'))).toBe(false);

    await bot.handle(staleCallback);
    expect(messenger.callbackAnswers.at(-1)!.notification).toBe('Это сообщение устарело');
  });

  it('если MAX отклонил кнопку-ссылку, ссылка на оплату приходит текстом', async () => {
    messenger.rejectLinks = true;
    await bot.handle({ type: 'start', user });
    await press('Рассчитать стоимость');
    await say('XTA219010K0123456');
    await press('Да, верно');
    await say('30000');
    await shareContact();
    await waitFor(() => messenger.messages.find((m) => m.msg.text.includes('Ваше предложение готово')));
    await press('За год');
    expect(lastText()).toMatch(/\[💳 Открыть страницу оплаты\]\(http:\/\/mocks\.local\/pay\/[\w-]+\)/);
    const copy = messenger.last().msg.buttons!.flat().find((b) => b.type === 'clipboard');
    expect(copy).toMatchObject({ type: 'clipboard', payload: expect.stringMatching(/^http:\/\/mocks\.local\/pay\//) });
  });

  it('неподписанный webhook оплаты отклоняется', async () => {
    const port = (botHttp.address() as AddressInfo).port;
    const r = await fetch(`http://localhost:${port}/payments/webhook`, { method: 'POST', body: '{"orderId":"x"}' });
    expect(r.status).toBe(401);
  });
});
