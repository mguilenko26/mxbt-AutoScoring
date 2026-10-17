/**
 * Mock-сервер всех внешних сервисов, кроме MAX:
 *   GET  /plate-to-vin/v1/lookup?plate=      — госномер → VIN
 *   GET  /vin-decoder/v1/vehicles/:vin       — VIN → марка/модель/год
 *   POST /enrichment/v1/enrich               — «AI + поиск»
 *   POST /pricing/v1/quotes                  — запуск асинхронного расчёта
 *   GET  /pricing/v1/quotes/:jobId           — статус расчёта
 *   POST /payments/v1/payments               — создание платежа (как у эквайера)
 *   POST /payments/v1/payments/:id/complete  — завершить платёж (симуляция)
 *   GET  /pay/:id                            — страница «виджета» оплаты
 *
 * Запуск: npm run mocks
 */
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { randomUUID } from 'node:crypto';
import { pathToFileURL } from 'node:url';
import { PLATES, VEHICLES, decodeUnknown, vinForPlate } from './fixtures.js';
import type {
  CreatePaymentRequest, DecodedVehicle, EnrichmentRequest, EnrichmentResult, PaymentEvent, PricingRequest,
  PricingStatus, Quote,
} from '../src/services/ports.js';
import { MOCK_SIGNATURE_HEADER, signBody } from '../src/services/http.js';

export interface MockOptions {
  port: number;
  /** Адрес mock-сервера, видимый пользователю (для ссылки на страницу оплаты). */
  publicUrl: string;
  /** Куда отправлять уведомления об оплате (webhook бота). */
  paymentWebhookUrl: string;
  paymentWebhookSecret: string;
  lookupDelayMs: number;
  enrichDelayMs: number;
  pricingDelayMs: number;
  pricingSlowMs: number;
  log: boolean;
}

export function optionsFromEnv(env = process.env): MockOptions {
  const port = Number(env.MOCKS_PORT ?? 4000);
  return {
    port,
    publicUrl: env.MOCKS_PUBLIC_URL ?? `http://localhost:${port}`,
    paymentWebhookUrl: env.PAYMENT_WEBHOOK_URL ?? `http://localhost:${env.BOT_HTTP_PORT ?? 3000}/payments/webhook`,
    paymentWebhookSecret: env.PAYMENT_WEBHOOK_SECRET ?? 'mock-secret',
    lookupDelayMs: Number(env.MOCK_LOOKUP_DELAY_MS ?? 800),
    enrichDelayMs: Number(env.MOCK_ENRICH_DELAY_MS ?? 3000),
    pricingDelayMs: Number(env.MOCK_PRICING_DELAY_MS ?? 15000),
    pricingSlowMs: Number(env.MOCK_PRICING_SLOW_MS ?? 90000),
    log: env.MOCK_LOG !== '0',
  };
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

// --- Прайсинг ----------------------------------------------------------------

interface PricingJob {
  req: PricingRequest;
  startedAt: number;
  durationMs: number;
  outcome: 'done' | 'declined' | 'failed';
  quote?: Quote;
}

const STAGES = [
  'collecting_history',
  'checking_model_reliability',
  'calculating_risk',
  'optimizing_price',
];

function vehicleValue<T>(vehicle: unknown, field: string): T | undefined {
  const list = (vehicle as Record<string, { value: T; source: string }[]> | undefined)?.[field];
  if (!Array.isArray(list) || list.length === 0) return undefined;
  return (list.find((c) => c.source === 'client') ?? list[0])!.value;
}

export function calculateQuote(job: PricingJob): Quote {
  const { req } = job;
  const year = vehicleValue<number>(req.vehicle, 'year') ?? 2015;
  const mileage = vehicleValue<number>(req.vehicle, 'mileageKm') ?? 120_000;
  const transmission = (vehicleValue<string>(req.vehicle, 'transmission') ?? '').toLowerCase();
  const age = Math.max(0, new Date().getFullYear() - year);

  let price = 14_000;
  price *= 1 + Math.min(age, 15) * 0.045;
  price *= 1 + Math.min(mileage, 300_000) / 400_000;
  if (/вариатор|робот|dsg/.test(transmission)) price *= 1.3;
  price *= 1 + (req.enrichment?.riskTags.length ?? 0) * 0.07;
  price *= 1 + req.discrepancies.length * 0.05;
  if (req.phoneVerified) price *= 0.97;

  const annual = Math.round(price / 10) * 10;
  const monthly = Math.round((annual * 1.1) / 12 / 10) * 10;
  return {
    quoteId: `Q-${randomUUID().slice(0, 8).toUpperCase()}`,
    annualPrice: annual,
    monthlyPrice: monthly,
    currency: 'RUB',
    coverage: ['двигатель', 'коробка передач'],
    validUntil: new Date(Date.now() + 7 * 24 * 3600_000).toISOString(),
  };
}

function enrichmentFor(req: EnrichmentRequest): EnrichmentResult {
  const findings: EnrichmentResult['findings'] = [];
  const riskTags: string[] = [];
  const t = (req.transmission ?? '').toLowerCase();
  if (/вариатор/.test(t)) {
    findings.push({ title: 'Вариатор', detail: 'Ресурс вариатора чувствителен к стилю езды и регламенту замены масла.', source: 'mock:forums' });
    riskTags.push('cvt');
  }
  if (/робот|dsg/.test(t)) {
    findings.push({ title: 'Роботизированная КПП', detail: 'Известны случаи износа сцепления и мехатроника.', source: 'mock:service-stats' });
    riskTags.push('robot_gearbox');
  }
  if (/турбо/.test((req.engine ?? '').toLowerCase())) {
    findings.push({ title: 'Турбированный двигатель', detail: 'Ресурс турбины зависит от качества масла.', source: 'mock:reviews' });
    riskTags.push('turbo');
  }
  if (req.year && req.year < 2014) {
    findings.push({ title: 'Возраст автомобиля', detail: 'Старше 10 лет — выше вероятность износа узлов.', source: 'mock:actuarial' });
    riskTags.push('age_10plus');
  }
  if (findings.length === 0) {
    findings.push({ title: 'Надёжность модели', detail: 'Массовых жалоб на двигатель и КПП не найдено.', source: 'mock:search' });
  }
  return { findings, riskTags };
}

// --- Платежи -----------------------------------------------------------------

interface MockPayment {
  id: string;
  req: CreatePaymentRequest;
  status: 'pending' | 'succeeded' | 'failed';
}

// --- HTTP --------------------------------------------------------------------

function send(res: ServerResponse, status: number, body: unknown, type = 'application/json') {
  const payload = type === 'application/json' ? JSON.stringify(body) : String(body);
  res.writeHead(status, { 'content-type': `${type}; charset=utf-8` });
  res.end(payload);
}

async function readBody(req: IncomingMessage): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const c of req) chunks.push(c as Buffer);
  return Buffer.concat(chunks).toString('utf8');
}

const rub = (n: number) => `${n.toLocaleString('ru-RU')} ₽`;
const esc = (s: string) => s.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);

function payPage(p: MockPayment): string {
  const done = p.status !== 'pending';
  return `<!doctype html><html lang="ru"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1"><title>Оплата (тест)</title>
<style>
 body{font-family:system-ui,sans-serif;background:#f2f3f5;margin:0;padding:24px 16px;color:#1d1d1f}
 .card{max-width:420px;margin:0 auto;background:#fff;border-radius:16px;padding:24px;box-shadow:0 2px 12px #0001}
 .badge{display:inline-block;background:#fff3cd;color:#7a5b00;border-radius:8px;padding:2px 8px;font-size:12px}
 h1{font-size:20px;margin:12px 0 4px} .sum{font-size:32px;font-weight:700;margin:12px 0}
 .muted{color:#6b6b70;font-size:14px} input{width:100%;box-sizing:border-box;padding:12px;margin:6px 0;border:1px solid #d0d0d5;border-radius:10px;font-size:16px}
 button{width:100%;padding:14px;border:0;border-radius:12px;font-size:16px;margin-top:10px;cursor:pointer}
 .pay{background:#2d6cdf;color:#fff} .fail{background:#eee;color:#333}
</style></head><body><div class="card">
<span class="badge">ТЕСТОВЫЙ ВИДЖЕТ · деньги не списываются</span>
<h1>${esc(p.req.description)}</h1>
<div class="muted">${p.req.plan === 'monthly' ? 'Первый платёж из 12, далее ежемесячно' : 'Оплата за год'}</div>
<div class="sum">${rub(p.req.amount)}</div>
${done ? `<p><b>${p.status === 'succeeded' ? '✅ Оплачено' : '❌ Платёж отклонён'}</b></p><p class="muted">Вернитесь в чат MAX.</p>` : `
<form method="post" action="/pay/${p.id}">
 <input placeholder="Номер карты" value="4242 4242 4242 4242" readonly>
 <input placeholder="ММ/ГГ" value="12/30" readonly>
 <button class="pay" name="outcome" value="success">Оплатить ${rub(p.req.amount)}</button>
 <button class="fail" name="outcome" value="fail">Симулировать отказ банка</button>
</form>`}
</div></body></html>`;
}

export function createMockServer(opts: MockOptions): Server {
  const jobs = new Map<string, PricingJob>();
  const payments = new Map<string, MockPayment>();
  const log = (...a: unknown[]) => opts.log && console.log('[mocks]', ...a);

  async function completePayment(p: MockPayment, outcome: 'success' | 'fail') {
    if (p.status !== 'pending') return; // идемпотентно
    p.status = outcome === 'success' ? 'succeeded' : 'failed';
    const event: PaymentEvent = {
      paymentId: p.id,
      orderId: p.req.orderId,
      status: p.status,
      amount: p.req.amount,
      reason: outcome === 'fail' ? 'Недостаточно средств (тест)' : undefined,
    };
    const body = JSON.stringify(event);
    try {
      const r = await fetch(opts.paymentWebhookUrl, {
        method: 'POST',
        headers: { 'content-type': 'application/json', [MOCK_SIGNATURE_HEADER]: signBody(body, opts.paymentWebhookSecret) },
        body,
      });
      log(`payment ${p.id} → ${p.status}, webhook ${r.status}`);
    } catch (e) {
      log(`payment ${p.id} webhook failed:`, (e as Error).message);
    }
  }

  return createServer(async (req, res) => {
    const url = new URL(req.url ?? '/', 'http://local');
    const path = url.pathname;
    const method = req.method ?? 'GET';
    try {
      // госномер → VIN
      if (method === 'GET' && path === '/plate-to-vin/v1/lookup') {
        const plate = url.searchParams.get('plate') ?? '';
        await sleep(opts.lookupDelayMs);
        const vins = plate in PLATES ? PLATES[plate]! : [vinForPlate(plate)];
        log(`plate ${plate} → ${vins.join(',') || 'not_found'}`);
        return send(res, 200, vins.length ? { status: 'found', vins } : { status: 'not_found' });
      }

      // VIN → данные авто
      let m = /^\/vin-decoder\/v1\/vehicles\/([A-Z0-9]{17})$/.exec(path);
      if (method === 'GET' && m) {
        const vin = m[1]!;
        await sleep(opts.lookupDelayMs);
        if (vin.endsWith('00000')) return send(res, 200, { status: 'not_found' });
        const vehicle: DecodedVehicle = VEHICLES[vin] ?? decodeUnknown(vin);
        return send(res, 200, { status: 'found', vehicle });
      }

      // AI + поиск
      if (method === 'POST' && path === '/enrichment/v1/enrich') {
        const body = JSON.parse(await readBody(req)) as EnrichmentRequest;
        await sleep(opts.enrichDelayMs);
        return send(res, 200, enrichmentFor(body));
      }

      // прайсинг: запуск
      if (method === 'POST' && path === '/pricing/v1/quotes') {
        const body = JSON.parse(await readBody(req)) as PricingRequest;
        const vin = body.vin;
        const outcome: PricingJob['outcome'] = vin.endsWith('99999') ? 'failed' : vin.endsWith('77777') ? 'declined' : 'done';
        const durationMs = vin.endsWith('88888') ? opts.pricingSlowMs : opts.pricingDelayMs;
        const jobId = `J-${randomUUID()}`;
        jobs.set(jobId, { req: body, startedAt: Date.now(), durationMs, outcome });
        log(`pricing ${jobId} for ${vin}: ${outcome} in ${durationMs}ms`);
        return send(res, 202, { jobId });
      }

      // прайсинг: статус
      m = /^\/pricing\/v1\/quotes\/([\w-]+)$/.exec(path);
      if (method === 'GET' && m) {
        const job = jobs.get(m[1]!);
        if (!job) return send(res, 404, { error: 'job not found' });
        const elapsed = Date.now() - job.startedAt;
        let status: PricingStatus;
        if (elapsed < job.durationMs) {
          const progress = elapsed / job.durationMs;
          status = { status: 'pending', progress, stage: STAGES[Math.min(STAGES.length - 1, Math.floor(progress * STAGES.length))] };
        } else if (job.outcome === 'failed') {
          status = { status: 'failed', error: 'scoring engine timeout (mock)' };
        } else if (job.outcome === 'declined') {
          status = { status: 'declined', reason: 'Автомобиль не соответствует условиям программы (mock)' };
        } else {
          job.quote ??= calculateQuote(job); // один и тот же результат при повторных запросах
          status = { status: 'done', quote: job.quote };
        }
        return send(res, 200, status);
      }

      // платежи: создание
      if (method === 'POST' && path === '/payments/v1/payments') {
        const body = JSON.parse(await readBody(req)) as CreatePaymentRequest;
        const id = `P-${randomUUID().slice(0, 12)}`;
        payments.set(id, { id, req: body, status: 'pending' });
        log(`payment ${id} created: ${body.amount} ₽ (${body.plan}), order ${body.orderId}`);
        return send(res, 201, { paymentId: id, payUrl: `${opts.publicUrl}/pay/${id}` });
      }

      // платежи: симуляция завершения
      m = /^\/payments\/v1\/payments\/([\w-]+)\/complete$/.exec(path);
      if (method === 'POST' && m) {
        const p = payments.get(m[1]!);
        if (!p) return send(res, 404, { error: 'payment not found' });
        const { outcome } = JSON.parse(await readBody(req)) as { outcome: 'success' | 'fail' };
        await completePayment(p, outcome);
        return send(res, 200, { ok: true });
      }

      // страница виджета
      m = /^\/pay\/([\w-]+)$/.exec(path);
      if (m) {
        const p = payments.get(m[1]!);
        if (!p) return send(res, 404, 'Платёж не найден', 'text/plain');
        if (method === 'POST') {
          const outcome = new URLSearchParams(await readBody(req)).get('outcome') === 'fail' ? 'fail' : 'success';
          await completePayment(p, outcome);
        }
        return send(res, 200, payPage(p), 'text/html');
      }

      if (path === '/health') return send(res, 200, { ok: true });
      return send(res, 404, { error: 'not found' });
    } catch (e) {
      log('error', e);
      return send(res, 500, { error: (e as Error).message });
    }
  });
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  const opts = optionsFromEnv();
  createMockServer(opts).listen(opts.port, () => {
    console.log(`[mocks] listening on http://localhost:${opts.port} (public ${opts.publicUrl})`);
    console.log(`[mocks] payment webhooks → ${opts.paymentWebhookUrl}`);
  });
}
