/**
 * Клиентский путь: приветствие → идентификация авто → подтверждение → пробег → телефон →
 * асинхронный скоринг с «живым» статусом → предложение → оплата.
 * Логика не зависит от MAX: на вход InboundEvent, на выход — порт Messenger.
 */
import { randomUUID } from 'node:crypto';
import { checkPlate, checkVin, formatPlate, maskVin } from '../domain/identifiers.js';
import {
  best, claim, confirmServiceData, describeVehicle, discrepancies, emptyProfile, putClaim,
} from '../domain/vehicle.js';
import type { Button, InboundEvent, Messenger, OutgoingMessage } from '../messenger/types.js';
import type { PaymentEvent, PaymentPlan, PricingStatus, Services } from '../services/ports.js';
import { formatPhone, verifyContact } from './contact.js';
import { KeyedLock } from './keyed-lock.js';
import { newSession, resetFlow, type Session, type SessionStore } from './session.js';
import { PROGRESS_STAGES, SPINNER, T } from './texts.js';

export interface BotConfig {
  botToken: string;
  policyUrl: string;
  /** Как часто менять текст прогресса. MAX: не более 2 правок в секунду на диалог. */
  progressIntervalMs: number;
  pricingPollMs: number;
  scoringTimeoutMs: number;
  /** Кнопки «🧪 симулировать оплату» — только с mock-эквайером. */
  paymentShortcuts: boolean;
}

export interface BotDeps {
  messenger: Messenger;
  services: Services;
  store: SessionStore;
  config: BotConfig;
  /** Только для mock-эквайера: завершить платёж из чата. */
  simulatePayment?: (paymentId: string, outcome: 'success' | 'fail') => Promise<unknown>;
  log?: (level: 'info' | 'warn' | 'error', msg: string, extra?: unknown) => void;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const cb = (text: string, action: string, flowId: string, arg?: string): Button => ({
  type: 'callback', text, payload: [action, flowId, arg].filter((x) => x != null).join(':'),
});

export class InsuranceBot {
  private readonly lock = new KeyedLock();
  private readonly background = new Set<Promise<unknown>>();
  /** Пользователи, у которых сейчас идёт расчёт (защита от двойного запуска). */
  private readonly activeScoring = new Set<number>();
  private readonly log: NonNullable<BotDeps['log']>;

  constructor(private readonly deps: BotDeps) {
    this.log = deps.log ?? ((level, msg, extra) => console[level === 'info' ? 'log' : level](`[bot] ${msg}`, extra ?? ''));
  }

  /** Дождаться фоновых задач (скоринга) — для тестов и корректной остановки. */
  async idle(): Promise<void> {
    while (this.background.size) await Promise.allSettled([...this.background]);
  }

  handle(event: InboundEvent): Promise<void> {
    return this.lock.run(event.user.userId, () => this.dispatch(event)).catch((e) => {
      this.log('error', `failed to handle ${event.type} from ${event.user.userId}`, e);
    });
  }

  // ---------------------------------------------------------------------------

  private get m() { return this.deps.messenger; }
  private get svc() { return this.deps.services; }

  private async load(userId: number): Promise<Session> {
    return (await this.deps.store.get(userId)) ?? newSession(userId);
  }

  private async dispatch(ev: InboundEvent): Promise<void> {
    let s = await this.load(ev.user.userId);
    s.chatId = ev.user.chatId ?? s.chatId;
    s.firstName = ev.user.firstName ?? s.firstName;

    if (ev.type === 'stopped') {
      s.stopped = true; // больше не пишем пользователю
      return this.deps.store.save(s);
    }
    s.stopped = false;

    switch (ev.type) {
      case 'start':
        s = resetFlow(s);
        await this.welcome(s);
        break;
      case 'callback':
        await this.onCallback(s, ev);
        break;
      case 'text':
        await this.onText(s, ev.text);
        break;
      case 'contact':
        await this.onContact(s, ev.contact);
        break;
    }
    await this.deps.store.save(s);
  }

  // --- Отправка ----------------------------------------------------------------

  private async say(s: Session, msg: OutgoingMessage) {
    return this.m.send(s.userId, msg);
  }

  /** Сообщение-вопрос с кнопками; запоминается, чтобы «заморозить» после ответа. */
  private async ask(s: Session, text: string, buttons: Button[][], freeze = true) {
    const { messageId } = await this.m.send(s.userId, { text, buttons });
    const labels: Record<string, string> = {};
    for (const row of buttons) for (const b of row) if (b.type === 'callback') labels[b.payload] = b.text;
    s.prompt = { messageId, text, labels, freeze };
    return messageId;
  }

  private async typing(s: Session) {
    if (s.chatId != null) await this.m.typing(s.chatId).catch(() => undefined);
  }

  // --- Шаги ------------------------------------------------------------------------

  private async welcome(s: Session) {
    // TODO: картинка (uploadImage → attachment image) и ссылки
    await this.ask(s, T.welcome(s.firstName), [
      [cb('🚗 Рассчитать стоимость', 'calc', s.flowId)],
      [cb('ℹ️ Что покрывает страховка', 'about', s.flowId)],
    ]);
  }

  private async chooseIdentifier(s: Session) {
    s.step = 'choose_identifier';
    await this.ask(s, T.chooseIdentifier, [[cb('Ввести VIN', 'id_vin', s.flowId), cb('Ввести госномер', 'id_plate', s.flowId)]]);
  }

  private async askMileage(s: Session) {
    s.step = 'await_mileage';
    await this.say(s, { text: T.askMileage });
  }

  private async askPhone(s: Session, forPurchase: boolean) {
    s.step = forPurchase ? 'await_phone_for_purchase' : 'await_phone';
    const buttons: Button[][] = [[{ type: 'request_contact', text: '📱 Поделиться номером' }]];
    if (forPurchase) buttons.push([cb('← Вернуться к предложению', 'back_offer', s.flowId)]);
    else buttons.push([cb('Пропустить', 'skip_phone', s.flowId)]);
    await this.ask(s, forPurchase ? T.askPhoneForPurchase(this.deps.config.policyUrl) : T.askPhone(this.deps.config.policyUrl), buttons);
  }

  // --- Обработка кнопок --------------------------------------------------------------

  private async onCallback(s: Session, ev: Extract<InboundEvent, { type: 'callback' }>) {
    const [action, flowId, arg] = ev.payload.split(':');
    const stale = action !== 'restart' && flowId !== s.flowId;

    // Ответ на нажатие: замораживаем вопрос (убираем кнопки, показываем выбор) или сообщаем, что он устарел.
    const p = s.prompt;
    const label = p?.labels[ev.payload];
    if (stale) {
      await this.m.answerCallback(ev.callbackId, { notification: T.stale }).catch(() => undefined);
      return;
    }
    if (p && p.freeze && ev.messageId === p.messageId && label) {
      await this.m
        .answerCallback(ev.callbackId, { message: { text: `${p.text}\n\n✔️ _${label}_`, buttons: [] } })
        .catch((e) => this.log('warn', 'answerCallback failed', e));
      s.prompt = undefined;
    } else {
      await this.m.answerCallback(ev.callbackId, {}).catch(() => undefined);
    }

    switch (action) {
      case 'restart':
        Object.assign(s, resetFlow(s));
        return this.chooseIdentifier(s);
      case 'about':
        return void (await this.ask(s, T.coverage, [[cb('🚗 Рассчитать стоимость', 'calc', s.flowId)]]));
      case 'calc':
        return this.chooseIdentifier(s);
      case 'id_vin':
        s.step = 'await_vin';
        return void (await this.say(s, { text: T.askVin }));
      case 'id_plate':
        s.step = 'await_plate';
        return void (await this.say(s, { text: T.askPlate }));
      case 'pick_vin': {
        const vin = s.vinCandidates?.[Number(arg)];
        if (s.step !== 'choose_vin' || !vin) return;
        s.vehicle.vin = claim(vin, 'plate_service', true);
        s.vinCandidates = undefined;
        return this.decodeVin(s);
      }
      case 'vin_manual':
        s.step = 'await_vin';
        s.vehicle.vin = undefined;
        s.vehicle.vinEnteredByClient = false;
        return void (await this.say(s, { text: T.askVin }));
      case 'confirm_yes':
        if (s.step !== 'confirm_vehicle') return;
        confirmServiceData(s.vehicle);
        if (s.vehicle.vin) s.vehicle.vin.confirmedByClient = true;
        return this.askMileage(s);
      case 'confirm_no':
        if (s.step !== 'confirm_vehicle') return;
        s.correcting = true;
        s.step = 'await_make_model';
        return void (await this.say(s, { text: T.askMakeModel }));
      case 'skip_phone':
        if (s.step !== 'await_phone') return;
        s.phoneSkipped = true;
        return this.startScoring(s);
      case 'retry_scoring':
        if (s.step !== 'scoring' || this.activeScoring.has(s.userId)) return;
        return this.startScoring(s);
      case 'buy': {
        if ((s.step !== 'offer' && s.step !== 'payment') || !s.quote) return;
        const plan: PaymentPlan = arg === 'monthly' ? 'monthly' : 'annual';
        s.pendingPlan = plan;
        if (!s.phone) return this.askPhone(s, true);
        return this.createPayment(s, plan);
      }
      case 'back_offer':
        if (!s.quote || s.step === 'paid') return;
        return this.sendOffer(s);
      case 'about_offer':
        if (!s.quote) return;
        return void (await this.ask(s, T.coverage, [[cb('← Вернуться к предложению', 'back_offer', s.flowId)]]));
      case 'edit':
        Object.assign(s, { ...resetFlow(s) });
        return this.chooseIdentifier(s);
      case 'pay_sim': {
        if (!this.deps.config.paymentShortcuts || !this.deps.simulatePayment || !s.payment) return;
        const paymentId = s.payment.paymentId;
        // Завершение придёт обратно через webhook → onPaymentEvent (после снятия блокировки).
        this.track(this.deps.simulatePayment(paymentId, arg === 'fail' ? 'fail' : 'success'));
        return;
      }
      default:
        this.log('warn', `unknown callback ${ev.payload}`);
    }
  }

  // --- Обработка текста ----------------------------------------------------------------

  private async onText(s: Session, text: string) {
    switch (s.step) {
      case 'idle':
        return this.welcome(s);
      case 'choose_identifier':
      case 'await_vin':
      case 'await_plate':
        return this.onIdentifier(s, text);
      case 'await_make_model': {
        const [make, ...rest] = text.trim().split(/\s+/);
        if (!make || rest.length === 0 || text.length > 60) return void (await this.say(s, { text: T.makeModelError }));
        putClaim(s.vehicle, 'make', claim(make, 'client', true));
        putClaim(s.vehicle, 'model', claim(rest.join(' '), 'client', true));
        s.step = 'await_year';
        return void (await this.say(s, { text: T.askYear }));
      }
      case 'await_year': {
        const max = new Date().getFullYear() + 1;
        const year = Number(text.replace(/\D/g, ''));
        if (!Number.isInteger(year) || year < 1980 || year > max) return void (await this.say(s, { text: T.yearError(max) }));
        putClaim(s.vehicle, 'year', claim(year, 'client', true));
        return this.askMileage(s);
      }
      case 'await_mileage': {
        const km = parseMileage(text);
        if (km == null) return void (await this.say(s, { text: T.mileageError }));
        putClaim(s.vehicle, 'mileageKm', claim(km, 'client', true));
        if (s.phone) return this.startScoring(s);
        return this.askPhone(s, false);
      }
      case 'await_phone':
      case 'await_phone_for_purchase':
        return void (await this.say(s, { text: T.phoneUseButton }));
      case 'scoring':
        return void (await this.say(s, { text: T.busyScoring }));
      default:
        return void (await this.say(s, { text: T.useButtons }));
    }
  }

  private async onIdentifier(s: Session, text: string) {
    const vin = checkVin(text);
    const plate = checkPlate(text);
    if (vin.ok) {
      s.vehicle = emptyProfile();
      s.vehicle.vin = claim(vin.vin, 'client', true);
      s.vehicle.vinEnteredByClient = true;
      return this.decodeVin(s);
    }
    if (plate.ok) {
      s.vehicle = emptyProfile();
      s.vehicle.plate = claim(plate.plate, 'client', true);
      return this.lookupPlate(s, plate.plate);
    }
    if (s.step === 'await_vin') return void (await this.say(s, { text: T.vinError(vin.reason, vin.normalized) }));
    if (s.step === 'await_plate') return void (await this.say(s, { text: T.plateError }));
    await this.say(s, { text: T.unknownIdentifier });
  }

  private async lookupPlate(s: Session, plate: string) {
    await this.typing(s);
    let res;
    try {
      res = await this.svc.plateToVin.lookup(plate);
    } catch (e) {
      this.log('warn', 'plate lookup failed', e);
      s.step = 'await_plate';
      return void (await this.say(s, { text: `${T.serviceError}\n\n${T.askVin}` }));
    }
    if (res.status === 'not_found' || res.vins.length === 0) {
      s.step = 'await_vin';
      return void (await this.say(s, { text: T.plateNotFound }));
    }
    if (res.vins.length === 1) {
      s.vehicle.vin = claim(res.vins[0]!, 'plate_service');
      return this.decodeVin(s);
    }
    s.step = 'choose_vin';
    s.vinCandidates = res.vins.slice(0, 5);
    await this.ask(s, `${T.chooseVin}\n\nГосномер: ${formatPlate(plate)}`, [
      ...s.vinCandidates.map((v, i) => [cb(`VIN …${v.slice(-6)}`, 'pick_vin', s.flowId, String(i))]),
      [cb('Ввести VIN вручную', 'vin_manual', s.flowId)],
    ]);
  }

  private async decodeVin(s: Session) {
    const vin = s.vehicle.vin!.value;
    await this.typing(s);
    let res;
    try {
      res = await this.svc.vinDecoder.decode(vin);
    } catch (e) {
      this.log('warn', 'vin decode failed', e);
      s.step = 'await_make_model';
      return void (await this.say(s, { text: T.vinNotDecoded }));
    }
    if (res.status === 'not_found') {
      s.step = 'await_make_model';
      return void (await this.say(s, { text: T.vinNotDecoded }));
    }
    const v = res.vehicle;
    putClaim(s.vehicle, 'make', claim(v.make, 'vin_service'));
    putClaim(s.vehicle, 'model', claim(v.model, 'vin_service'));
    putClaim(s.vehicle, 'year', claim(v.year, 'vin_service'));
    if (v.engine) putClaim(s.vehicle, 'engine', claim(v.engine, 'vin_service'));
    if (v.transmission) putClaim(s.vehicle, 'transmission', claim(v.transmission, 'vin_service'));
    if (v.bodyType) putClaim(s.vehicle, 'bodyType', claim(v.bodyType, 'vin_service'));

    s.step = 'confirm_vehicle';
    const shownVin = s.vehicle.vinEnteredByClient ? vin : maskVin(vin);
    const buttons: Button[][] = [[cb('✅ Да, верно', 'confirm_yes', s.flowId), cb('✏️ Нет, исправить', 'confirm_no', s.flowId)]];
    if (!s.vehicle.vinEnteredByClient) buttons.push([cb('Ввести VIN вручную', 'vin_manual', s.flowId)]);
    await this.ask(s, T.vehicleCard({
      title: `${v.make} ${v.model}, ${v.year} г.`, engine: v.engine, transmission: v.transmission, vin: shownVin,
    }), buttons);
  }

  // --- Телефон -------------------------------------------------------------------------

  private async onContact(s: Session, contact: Extract<InboundEvent, { type: 'contact' }>['contact']) {
    const res = verifyContact(contact, s.userId, this.deps.config.botToken);
    if (!res.phone || res.reason === 'no_hash' || res.reason === 'other_user') {
      return void (await this.say(s, { text: T.phoneUseButton }));
    }
    if (res.reason === 'bad_hash') {
      // Кодировка hash в документации не описана: сохраняем номер как неподтверждённый и пишем в лог для разбора.
      this.log('warn', `contact hash mismatch for user ${s.userId} — phone stored as unverified`);
    }
    s.phone = { value: res.phone, verified: res.verified };
    s.consentAt = new Date().toISOString();
    s.phoneSkipped = false;
    await this.say(s, { text: T.phoneSaved(formatPhone(res.phone)), notify: false });

    if (s.step === 'await_phone') return this.startScoring(s);
    if (s.step === 'await_phone_for_purchase' && s.pendingPlan) return this.createPayment(s, s.pendingPlan);
  }

  // --- Скоринг ---------------------------------------------------------------------------

  private async startScoring(s: Session) {
    s.step = 'scoring';
    s.quote = undefined;
    s.enrichment = undefined;
    const { messageId } = await this.say(s, {
      text: T.progress(SPINNER[0]!, PROGRESS_STAGES.enrichment![0]!, 0.02),
      notify: false,
    });
    s.scoring = { jobId: '', progressMessageId: messageId, startedAt: new Date().toISOString() };
    const { userId, flowId } = s;
    // Скоринг идёт в фоне, без блокировки пользователя: он может писать, закрыть чат и т. д.
    this.activeScoring.add(userId);
    this.track(
      sleep(0)
        .then(() => this.runScoring(userId, flowId, messageId))
        .finally(() => this.activeScoring.delete(userId)),
    );
  }

  private track(p: Promise<unknown>) {
    const tracked = p.catch((e) => this.log('error', 'background task failed', e)).finally(() => this.background.delete(tracked));
    this.background.add(tracked);
  }

  /** Изменить сессию под блокировкой, если расчёт всё ещё актуален. */
  private async whileCurrent<T>(userId: number, flowId: string, fn: (s: Session) => Promise<T> | T): Promise<T | undefined> {
    return this.lock.run(userId, async () => {
      const s = await this.deps.store.get(userId);
      if (!s || s.flowId !== flowId || s.step !== 'scoring' || s.stopped) return undefined;
      const r = await fn(s);
      await this.deps.store.save(s);
      return r;
    });
  }

  private async runScoring(userId: number, flowId: string, progressMessageId: string) {
    const cfg = this.deps.config;
    const progress = new ProgressMessage(this.m, progressMessageId, Math.max(1500, cfg.progressIntervalMs), (e) =>
      this.log('warn', 'progress edit failed', e));
    progress.set('enrichment', 0.03);
    let finished = false;
    try {
      const snapshot = await this.deps.store.get(userId);
      if (!snapshot || snapshot.flowId !== flowId) return;
      const v = snapshot.vehicle;

      // 1. Обогащение (AI + поиск). Ошибка не фатальна — считаем без него.
      const enrichment = await this.svc.enrichment
        .enrich({ vin: v.vin!.value, make: best(v.make), model: best(v.model), year: best(v.year), engine: best(v.engine), transmission: best(v.transmission) })
        .catch((e) => { this.log('warn', 'enrichment failed', e); return undefined; });
      progress.set('collecting_history', 0.15);

      // 2. Запуск расчёта.
      const { jobId } = await this.svc.pricing.requestQuote({
        requestId: `${userId}-${flowId}-${randomUUID().slice(0, 6)}`,
        vin: v.vin!.value,
        vehicle: v,
        discrepancies: discrepancies(v),
        enrichment,
        phoneVerified: snapshot.phone?.verified ?? false,
      });
      const ok = await this.whileCurrent(userId, flowId, (s) => {
        s.enrichment = enrichment;
        s.scoring = { ...s.scoring!, jobId };
        return true;
      });
      if (!ok) return;

      // 3. Ожидание результата.
      const deadline = Date.now() + cfg.scoringTimeoutMs;
      let errors = 0;
      let status: PricingStatus = { status: 'pending' };
      while (status.status === 'pending') {
        if (Date.now() > deadline) throw new Error('scoring timeout');
        await sleep(cfg.pricingPollMs);
        const current = await this.deps.store.get(userId);
        if (!current || current.flowId !== flowId || current.step !== 'scoring') return; // пользователь начал заново
        try {
          status = await this.svc.pricing.getStatus(jobId);
          errors = 0;
        } catch (e) {
          if (++errors >= 5) throw e;
          continue;
        }
        if (status.status === 'pending') progress.set(status.stage ?? 'calculating_risk', 0.15 + 0.85 * (status.progress ?? 0.5));
      }

      // 4. Результат.
      await progress.stop();
      finished = true;
      await this.whileCurrent(userId, flowId, async (s) => {
        if (status.status === 'done') {
          s.quote = status.quote;
          await this.m.edit(progressMessageId, { text: T.progressDone }).catch(() => undefined);
          await this.sendOffer(s);
        } else if (status.status === 'declined') {
          s.step = 'idle';
          await this.m.edit(progressMessageId, { text: T.progressFailed }).catch(() => undefined);
          await this.ask(s, T.declined(status.reason), [[cb('🔄 Новый расчёт', 'restart', s.flowId)]]);
        } else if (status.status === 'failed') {
          throw new Error(status.error);
        }
      });
    } catch (e) {
      this.log('error', `scoring failed for ${userId}`, e);
      if (!finished) await progress.stop();
      await this.whileCurrent(userId, flowId, async (s) => {
        await this.m.edit(progressMessageId, { text: T.progressFailed }).catch(() => undefined);
        await this.ask(s, T.scoringFailed, [[cb('🔁 Повторить расчёт', 'retry_scoring', s.flowId)]]);
      });
    } finally {
      if (!finished) await progress.stop();
    }
  }

  private async sendOffer(s: Session) {
    const q = s.quote!;
    s.step = 'offer';
    const findings = (s.enrichment?.findings ?? []).slice(0, 3).map((f) => `${f.title}: ${f.detail}`);
    // Новое сообщение (а не правка прогресса) — чтобы пришёл push, если пользователь закрыл чат.
    await this.ask(s, T.offer(q, describeVehicle(s.vehicle), best(s.vehicle.mileageKm), findings), [
      [cb(`💳 За год — ${q.annualPrice.toLocaleString('ru-RU').replace(/ /g, ' ')} ₽`, 'buy', s.flowId, 'annual')],
      [cb(`🗓 Помесячно — ${q.monthlyPrice.toLocaleString('ru-RU').replace(/ /g, ' ')} ₽/мес`, 'buy', s.flowId, 'monthly')],
      [cb('✏️ Изменить данные', 'edit', s.flowId), cb('ℹ️ Что покрывает', 'about_offer', s.flowId)],
    ], false);
  }

  // --- Оплата ------------------------------------------------------------------------------

  private async createPayment(s: Session, plan: PaymentPlan) {
    const q = s.quote!;
    const amount = plan === 'annual' ? q.annualPrice : q.monthlyPrice;
    const orderId = `ORD-${s.flowId}-${Date.now().toString(36)}`;
    let res;
    try {
      res = await this.svc.payments.createPayment({
        orderId,
        amount,
        plan,
        description: `Страховка двигателя и КПП, ${describeVehicle(s.vehicle)}`,
        customer: { maxUserId: s.userId, phone: s.phone?.value },
        recurrent: plan === 'monthly' ? { interval: 'Month', period: 1, maxPeriods: 12, amount: q.monthlyPrice } : undefined,
      });
    } catch (e) {
      this.log('error', 'createPayment failed', e);
      s.step = 'offer';
      return void (await this.say(s, { text: T.serviceError }));
    }
    s.step = 'payment';
    s.payment = { orderId, paymentId: res.paymentId, plan, amount, payUrl: res.payUrl };

    const back: Button[] = [cb('← Вернуться к предложению', 'back_offer', s.flowId)];
    const sim: Button[][] = this.deps.config.paymentShortcuts
      ? [[cb('🧪 Оплата успешна', 'pay_sim', s.flowId, 'success'), cb('🧪 Отказ банка', 'pay_sim', s.flowId, 'fail')]]
      : [];
    try {
      await this.ask(s, T.payment(plan, amount), [[{ type: 'link', text: '💳 Перейти к оплате', url: res.payUrl }], ...sim, back], false);
    } catch (e) {
      // MAX может отклонить ссылку (например, localhost при локальном тесте) — отправляем адрес текстом.
      this.log('warn', 'payment link button rejected, falling back to text link', e);
      await this.ask(s, `${T.payment(plan, amount)}\n\nСсылка на оплату: ${res.payUrl}`, [...sim, back], false);
    }
  }

  /** Уведомление эквайера (после проверки подписи в HTTP-слое). */
  async onPaymentEvent(ev: PaymentEvent): Promise<'ok' | 'unknown_order'> {
    const owner = await this.deps.store.findByOrderId(ev.orderId);
    if (!owner) return 'unknown_order';
    await this.lock.run(owner.userId, async () => {
      const s = await this.load(owner.userId);
      if (!s.payment || s.payment.orderId !== ev.orderId || s.payment.paymentId !== ev.paymentId) return;
      if (s.step === 'paid') return; // повторное уведомление — идемпотентно
      if (ev.status === 'succeeded') {
        s.step = 'paid';
        s.policyNumber = `AS-${new Date().getFullYear()}-${randomUUID().slice(0, 6).toUpperCase()}`;
        if (!s.stopped) await this.ask(s, T.paid(s.policyNumber, s.payment.plan), [[cb('🔄 Новый расчёт', 'restart', s.flowId)]], false);
      } else {
        s.step = 'offer';
        if (!s.stopped) {
          await this.ask(s, T.paymentFailed(ev.reason), [
            [cb('🔁 Попробовать снова', 'buy', s.flowId, s.payment.plan)],
            [cb('← Вернуться к предложению', 'back_offer', s.flowId)],
          ], false);
        }
      }
      await this.deps.store.save(s);
    });
    return 'ok';
  }
}

/** «85000», «85 000 км», «85 тыс», «85к» → 85000 */
export function parseMileage(text: string): number | null {
  const t = text.toLowerCase().replace(/\s+/g, ' ').trim();
  const m = /^(\d[\d ]*(?:[.,]\d+)?)\s*(тыс\.?|т\.?|k|к)?\s*(км)?\.?$/.exec(t);
  if (!m) return null;
  let n = Number(m[1]!.replace(/ /g, '').replace(',', '.'));
  if (m[2]) n *= 1000;
  n = Math.round(n);
  return Number.isFinite(n) && n >= 0 && n <= 1_500_000 ? n : null;
}

/**
 * «Живое» сообщение прогресса: меняет фразы и полоску не чаще intervalMs,
 * правки не накладываются друг на друга (MAX: ≤2 правки в секунду на диалог).
 */
class ProgressMessage {
  private stage = 'enrichment';
  private pct = 0;
  private tick = 0;
  private lastText = '';
  private timer: NodeJS.Timeout | undefined;
  private inFlight: Promise<void> | undefined;
  private stopped = false;

  constructor(
    private readonly m: Messenger,
    private readonly messageId: string,
    intervalMs: number,
    private readonly onError: (e: unknown) => void,
  ) {
    this.timer = setInterval(() => void this.render(), intervalMs);
  }

  set(stage: string, pct: number) {
    this.stage = stage;
    this.pct = Math.max(this.pct, Math.min(0.99, pct));
  }

  private async render() {
    if (this.stopped || this.inFlight) return;
    this.tick++;
    const phrases = PROGRESS_STAGES[this.stage] ?? PROGRESS_STAGES.calculating_risk!;
    const phrase = phrases[Math.floor(this.tick / 2) % phrases.length]!;
    const text = T.progress(SPINNER[this.tick % SPINNER.length]!, phrase, this.pct);
    if (text === this.lastText) return;
    this.lastText = text;
    this.inFlight = this.m.edit(this.messageId, { text, notify: false }).catch(this.onError).finally(() => {
      this.inFlight = undefined;
    });
    await this.inFlight;
  }

  async stop() {
    this.stopped = true;
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
    await this.inFlight;
  }
}
