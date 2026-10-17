/**
 * HTTP-клиенты к внешним сервисам по контракту mocks/server.ts.
 * Реальные поставщики подключаются отдельными адаптерами с теми же интерфейсами из ports.ts.
 */
import { createHmac, timingSafeEqual } from 'node:crypto';
import type {
  CreatePaymentRequest, CreatePaymentResult, EnrichmentRequest, EnrichmentResult, PaymentEvent,
  PaymentProvider, PlateLookupResult, PlateToVinService, PricingRequest, PricingService, PricingStatus,
  Services, VinDecodeResult, VinDecoderService, EnrichmentService,
} from './ports.js';

export class ServiceError extends Error {
  constructor(public readonly service: string, message: string, public readonly status?: number) {
    super(`${service}: ${message}`);
  }
}

async function call<T>(
  service: string,
  baseUrl: string,
  path: string,
  init: { method?: string; body?: unknown; timeoutMs?: number } = {},
): Promise<T> {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), init.timeoutMs ?? 15_000);
  try {
    const res = await fetch(new URL(path, baseUrl), {
      method: init.method ?? (init.body ? 'POST' : 'GET'),
      headers: init.body ? { 'content-type': 'application/json' } : undefined,
      body: init.body ? JSON.stringify(init.body) : undefined,
      signal: ctrl.signal,
    });
    const text = await res.text();
    if (!res.ok) throw new ServiceError(service, `HTTP ${res.status} ${text.slice(0, 200)}`, res.status);
    return JSON.parse(text) as T;
  } catch (e) {
    if (e instanceof ServiceError) throw e;
    throw new ServiceError(service, (e as Error).message);
  } finally {
    clearTimeout(timer);
  }
}

export class HttpPlateToVin implements PlateToVinService {
  constructor(private baseUrl: string) {}
  lookup(plate: string) {
    return call<PlateLookupResult>('plate-to-vin', this.baseUrl, `/plate-to-vin/v1/lookup?plate=${encodeURIComponent(plate)}`);
  }
}

export class HttpVinDecoder implements VinDecoderService {
  constructor(private baseUrl: string) {}
  decode(vin: string) {
    return call<VinDecodeResult>('vin-decoder', this.baseUrl, `/vin-decoder/v1/vehicles/${encodeURIComponent(vin)}`);
  }
}

export class HttpEnrichment implements EnrichmentService {
  constructor(private baseUrl: string) {}
  enrich(req: EnrichmentRequest) {
    return call<EnrichmentResult>('enrichment', this.baseUrl, '/enrichment/v1/enrich', { body: req, timeoutMs: 60_000 });
  }
}

export class HttpPricing implements PricingService {
  constructor(private baseUrl: string) {}
  requestQuote(req: PricingRequest) {
    return call<{ jobId: string }>('pricing', this.baseUrl, '/pricing/v1/quotes', { body: req });
  }
  getStatus(jobId: string) {
    return call<PricingStatus>('pricing', this.baseUrl, `/pricing/v1/quotes/${encodeURIComponent(jobId)}`);
  }
}

export const MOCK_SIGNATURE_HEADER = 'x-mock-signature';

export function signBody(body: string, secret: string): string {
  return createHmac('sha256', secret).update(body).digest('base64');
}

/**
 * Mock-эквайер. Повторяет схему CloudPayments: страница с виджетом + серверное уведомление,
 * подписанное HMAC-SHA256 (base64) от тела запроса.
 */
export class MockPaymentProvider implements PaymentProvider {
  readonly name = 'mock';
  constructor(private baseUrl: string, private webhookSecret: string) {}

  createPayment(req: CreatePaymentRequest) {
    return call<CreatePaymentResult>('payments', this.baseUrl, '/payments/v1/payments', { body: req });
  }

  parseWebhook(rawBody: string, headers: Record<string, string | string[] | undefined>): PaymentEvent | null {
    const got = headers[MOCK_SIGNATURE_HEADER];
    if (typeof got !== 'string') return null;
    const expected = Buffer.from(signBody(rawBody, this.webhookSecret));
    const actual = Buffer.from(got);
    if (expected.length !== actual.length || !timingSafeEqual(expected, actual)) return null;
    try {
      return JSON.parse(rawBody) as PaymentEvent;
    } catch {
      return null;
    }
  }

  /** Только для mock: завершить платёж без открытия страницы (кнопки-симуляторы в чате). */
  simulate(paymentId: string, outcome: 'success' | 'fail') {
    return call<{ ok: true }>('payments', this.baseUrl, `/payments/v1/payments/${encodeURIComponent(paymentId)}/complete`, {
      body: { outcome },
    });
  }
}

export interface ServicesConfig {
  mocksBaseUrl: string;
  paymentWebhookSecret: string;
}

export function createHttpServices(cfg: ServicesConfig): Services & { payments: MockPaymentProvider } {
  return {
    plateToVin: new HttpPlateToVin(cfg.mocksBaseUrl),
    vinDecoder: new HttpVinDecoder(cfg.mocksBaseUrl),
    enrichment: new HttpEnrichment(cfg.mocksBaseUrl),
    pricing: new HttpPricing(cfg.mocksBaseUrl),
    payments: new MockPaymentProvider(cfg.mocksBaseUrl, cfg.paymentWebhookSecret),
  };
}
