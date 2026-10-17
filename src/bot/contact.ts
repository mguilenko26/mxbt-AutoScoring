/**
 * Проверка контакта, присланного кнопкой request_contact.
 * По документации MAX: HMAC-SHA256(ключ = токен бота, данные = vcf_info с \r\n → реальными переносами),
 * совпадение с hash подтверждает, что номер принадлежит аккаунту пользователя.
 * Кодировка hash в документации не указана — принимаем hex и base64, сравнение — за постоянное время.
 */
import { createHmac, timingSafeEqual } from 'node:crypto';
import type { ContactShare } from '../messenger/types.js';

export interface VerifiedContact {
  phone: string | null; // E.164 без «+», например 79161234567
  fullName: string | null;
  verified: boolean;
  reason?: 'no_hash' | 'bad_hash' | 'other_user' | 'no_phone';
}

export function normalizeVcf(vcf: string): string {
  return vcf.replace(/\\r\\n/g, '\r\n');
}

function safeEq(a: string, b: string): boolean {
  const x = Buffer.from(a);
  const y = Buffer.from(b);
  return x.length === y.length && timingSafeEqual(x, y);
}

export function contactHash(vcf: string, botToken: string): { hex: string; base64: string } {
  const mac = createHmac('sha256', botToken).update(normalizeVcf(vcf)).digest();
  return { hex: mac.toString('hex'), base64: mac.toString('base64') };
}

export function parseVcf(vcf: string): { phone: string | null; fullName: string | null } {
  const lines = normalizeVcf(vcf).split(/\r?\n/);
  const tel = lines.find((l) => /^TEL[;:]/i.test(l));
  const fn = lines.find((l) => /^FN[;:]/i.test(l));
  const value = (l?: string) => (l ? l.slice(l.indexOf(':') + 1).trim() : null);
  const digits = value(tel)?.replace(/\D/g, '') ?? '';
  let phone: string | null = digits || null;
  if (phone && phone.length === 11 && phone.startsWith('8')) phone = `7${phone.slice(1)}`;
  if (phone && phone.length === 10) phone = `7${phone}`;
  return { phone, fullName: value(fn) || null };
}

export function verifyContact(contact: ContactShare, senderUserId: number, botToken: string): VerifiedContact {
  const { phone, fullName } = parseVcf(contact.vcfInfo);
  if (!phone) return { phone: null, fullName, verified: false, reason: 'no_phone' };
  if (!contact.hash) return { phone, fullName, verified: false, reason: 'no_hash' };
  const expected = contactHash(contact.vcfInfo, botToken);
  const got = contact.hash.trim();
  const hashOk = safeEq(got.toLowerCase(), expected.hex) || safeEq(got, expected.base64);
  if (!hashOk) return { phone, fullName, verified: false, reason: 'bad_hash' };
  const owner = contact.maxInfo?.user_id;
  if (owner != null && owner !== senderUserId) return { phone, fullName, verified: false, reason: 'other_user' };
  return { phone, fullName, verified: true };
}

export function formatPhone(phone: string): string {
  const m = /^7(\d{3})(\d{3})(\d{2})(\d{2})$/.exec(phone);
  return m ? `+7 ${m[1]} ${m[2]}-${m[3]}-${m[4]}` : `+${phone}`;
}
