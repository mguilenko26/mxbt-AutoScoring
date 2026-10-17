/**
 * Состояние диалога с пользователем.
 * Сейчас — память процесса; интерфейс SessionStore позволяет заменить на Redis/Postgres без правок логики.
 */
import { randomUUID } from 'node:crypto';
import { emptyProfile, type VehicleProfile } from '../domain/vehicle.js';
import type { EnrichmentResult, PaymentPlan, Quote } from '../services/ports.js';

export type Step =
  | 'idle'
  | 'choose_identifier'
  | 'await_vin'
  | 'await_plate'
  | 'choose_vin' // по госномеру найдено несколько VIN
  | 'confirm_vehicle'
  | 'await_make_model' // ручной ввод марки и модели
  | 'await_year'
  | 'await_mileage'
  | 'await_phone' // перед скорингом, можно пропустить
  | 'scoring'
  | 'offer'
  | 'await_phone_for_purchase' // перед оплатой, обязательно
  | 'payment'
  | 'paid';

export interface Session {
  userId: number;
  chatId?: number;
  firstName?: string;
  /** Номер «попытки» расчёта. Кнопки старых сообщений содержат его и игнорируются после сброса. */
  flowId: string;
  step: Step;
  stopped: boolean;
  vehicle: VehicleProfile;
  /** VIN-ы, найденные по госномеру, когда их несколько. */
  vinCandidates?: string[];
  /** Пользователь выбрал «Нет, исправить» — после ручного ввода данные сервиса не подтверждаются. */
  correcting?: boolean;
  phone?: { value: string; verified: boolean };
  phoneSkipped?: boolean;
  consentAt?: string;
  scoring?: { jobId: string; progressMessageId?: string; startedAt: string };
  enrichment?: EnrichmentResult;
  quote?: Quote;
  pendingPlan?: PaymentPlan;
  payment?: { orderId: string; paymentId: string; plan: PaymentPlan; amount: number; payUrl: string };
  policyNumber?: string;
  /**
   * Последнее сообщение с вопросом. После нажатия кнопки оно «замораживается»:
   * клавиатура убирается, под текстом появляется выбранный вариант — нельзя нажать дважды.
   */
  prompt?: { messageId: string; text: string; labels: Record<string, string>; freeze: boolean };
  updatedAt: string;
}

export function newSession(userId: number): Session {
  return {
    userId,
    flowId: randomUUID().slice(0, 8),
    step: 'idle',
    stopped: false,
    vehicle: emptyProfile(),
    updatedAt: new Date().toISOString(),
  };
}

/** Начать новый расчёт, сохранив сведения о пользователе (телефон, согласие). */
export function resetFlow(s: Session): Session {
  const fresh = newSession(s.userId);
  return { ...fresh, chatId: s.chatId, firstName: s.firstName, phone: s.phone, consentAt: s.consentAt };
}

export interface SessionStore {
  get(userId: number): Promise<Session | undefined>;
  save(session: Session): Promise<void>;
  /** Поиск по orderId платежа — для webhook эквайера. */
  findByOrderId(orderId: string): Promise<Session | undefined>;
}

export class MemorySessionStore implements SessionStore {
  private readonly data = new Map<number, Session>();

  async get(userId: number) {
    const s = this.data.get(userId);
    return s ? structuredClone(s) : undefined;
  }

  async save(session: Session) {
    session.updatedAt = new Date().toISOString();
    this.data.set(session.userId, structuredClone(session));
  }

  async findByOrderId(orderId: string) {
    for (const s of this.data.values()) if (s.payment?.orderId === orderId) return structuredClone(s);
    return undefined;
  }
}
