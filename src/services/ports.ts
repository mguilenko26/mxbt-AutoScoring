/**
 * Контракты внешних сервисов. Бот зависит только от этих интерфейсов:
 * сейчас за ними HTTP-клиенты к mock-серверу (mocks/server.ts),
 * позже — адаптеры к реальным поставщикам.
 */

// --- 1. Госномер → VIN -------------------------------------------------------

export type PlateLookupResult =
  | { status: 'found'; vins: string[] } // может быть несколько (перерегистрация номера)
  | { status: 'not_found' };

export interface PlateToVinService {
  lookup(plate: string): Promise<PlateLookupResult>;
}

// --- 2. VIN → марка/модель/год ------------------------------------------------

export interface DecodedVehicle {
  make: string;
  model: string;
  year: number;
  engine?: string; // «2.5 л, бензин»
  transmission?: string; // «АКПП», «МКПП», «вариатор», «робот»
  bodyType?: string;
}

export type VinDecodeResult = { status: 'found'; vehicle: DecodedVehicle } | { status: 'not_found' };

export interface VinDecoderService {
  decode(vin: string): Promise<VinDecodeResult>;
}

// --- 3. Обогащение: AI + поиск ----------------------------------------------

export interface EnrichmentRequest {
  vin: string;
  make?: string;
  model?: string;
  year?: number;
  engine?: string;
  transmission?: string;
}

export interface EnrichmentResult {
  /** Факты о модели, собранные из открытых источников (типовые поломки, отзывные кампании и т. п.). */
  findings: { title: string; detail: string; source?: string }[];
  /** Признаки риска для прайсинга — машиночитаемые метки. */
  riskTags: string[];
}

export interface EnrichmentService {
  enrich(req: EnrichmentRequest): Promise<EnrichmentResult>;
}

// --- 4. Прайсинг (асинхронный скоринг) ---------------------------------------

export interface PricingRequest {
  requestId: string; // идемпотентность
  vin: string;
  /** Все утверждения о машине с источниками — сервис сам решает, чему доверять. */
  vehicle: unknown;
  discrepancies: string[];
  enrichment?: EnrichmentResult;
  phoneVerified: boolean;
}

export interface Quote {
  quoteId: string;
  annualPrice: number; // ₽ за год при единовременной оплате
  monthlyPrice: number; // ₽ в месяц при помесячной оплате (12 платежей)
  currency: 'RUB';
  coverage: string[];
  validUntil: string; // ISO
}

export type PricingStatus =
  | { status: 'pending'; stage?: string; progress?: number }
  | { status: 'done'; quote: Quote }
  | { status: 'declined'; reason: string }
  | { status: 'failed'; error: string };

export interface PricingService {
  /** Запускает расчёт, возвращает идентификатор задачи. */
  requestQuote(req: PricingRequest): Promise<{ jobId: string }>;
  getStatus(jobId: string): Promise<PricingStatus>;
}

// --- 5. Платежи --------------------------------------------------------------

export type PaymentPlan = 'annual' | 'monthly';

export interface CreatePaymentRequest {
  orderId: string;
  amount: number; // ₽, первый платёж
  plan: PaymentPlan;
  description: string;
  customer: { maxUserId: number; phone?: string };
  /** Для помесячного плана — параметры подписки (рекуррент). */
  recurrent?: { interval: 'Month'; period: 1; maxPeriods: number; amount: number };
}

export interface CreatePaymentResult {
  paymentId: string;
  /** Страница с виджетом поставщика — открывается из кнопки в чате или из мини-приложения. */
  payUrl: string;
}

export type PaymentEventStatus = 'succeeded' | 'failed';

export interface PaymentEvent {
  paymentId: string;
  orderId: string;
  status: PaymentEventStatus;
  amount: number;
  reason?: string;
}

/**
 * Поставщик платежей. Смена поставщика = новый адаптер с этим интерфейсом.
 * Факт оплаты определяется ТОЛЬКО по серверному webhook, проверенному parseWebhook.
 */
export interface PaymentProvider {
  readonly name: string;
  createPayment(req: CreatePaymentRequest): Promise<CreatePaymentResult>;
  /** Проверяет подпись и разбирает уведомление поставщика. null — подпись неверна. */
  parseWebhook(rawBody: string, headers: Record<string, string | string[] | undefined>): PaymentEvent | null;
}

export interface Services {
  plateToVin: PlateToVinService;
  vinDecoder: VinDecoderService;
  enrichment: EnrichmentService;
  pricing: PricingService;
  payments: PaymentProvider;
}
