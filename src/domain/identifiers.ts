/**
 * Нормализация и проверка идентификаторов автомобиля: VIN и российский госномер.
 */

const VIN_RE = /^[A-HJ-NPR-Z0-9]{17}$/;

// Похожие кириллические буквы, которые пользователи вводят вместо латиницы в VIN.
const CYR_TO_LAT: Record<string, string> = {
  А: 'A', В: 'B', Е: 'E', К: 'K', М: 'M', Н: 'H', О: 'O', Р: 'P', С: 'C', Т: 'T', У: 'Y', Х: 'X',
};
const LAT_TO_CYR: Record<string, string> = Object.fromEntries(
  Object.entries(CYR_TO_LAT).map(([cyr, lat]) => [lat, cyr]),
);

export type VinCheck =
  | { ok: true; vin: string }
  | { ok: false; reason: 'length' | 'forbidden_letters' | 'chars'; normalized: string };

export function normalizeVin(input: string): string {
  return [...input.toUpperCase().replace(/[\s-]/g, '')]
    .map((ch) => CYR_TO_LAT[ch] ?? ch)
    .join('');
}

/**
 * Проверка формата: 17 символов, латиница и цифры, без I, O, Q.
 * Контрольную цифру (9-я позиция) не проверяем — она обязательна только для Северной Америки.
 */
export function checkVin(input: string): VinCheck {
  const vin = normalizeVin(input);
  if (vin.length !== 17) return { ok: false, reason: 'length', normalized: vin };
  if (/[IOQ]/.test(vin)) return { ok: false, reason: 'forbidden_letters', normalized: vin };
  if (!VIN_RE.test(vin)) return { ok: false, reason: 'chars', normalized: vin };
  return { ok: true, vin };
}

/** XW7BF4FK40S123456 → XW7*********23456 — для VIN, найденного не самим клиентом. */
export function maskVin(vin: string): string {
  if (vin.length < 8) return vin;
  return vin.slice(0, 3) + '*'.repeat(vin.length - 8) + vin.slice(-5);
}

// Буквы, допустимые в российском госномере (совпадают по написанию с латиницей).
const PLATE_LETTERS = 'АВЕКМНОРСТУХ';
const PLATE_RE = new RegExp(`^[${PLATE_LETTERS}]\\d{3}[${PLATE_LETTERS}]{2}\\d{2,3}$`);

export type PlateCheck = { ok: true; plate: string } | { ok: false; normalized: string };

export function normalizePlate(input: string): string {
  return [...input.toUpperCase().replace(/[\s-]/g, '').replace(/RUS$/, '')]
    .map((ch) => LAT_TO_CYR[ch] ?? ch)
    .join('');
}

/** Формат легкового номера: А123ВС77 / А123ВС777. */
export function checkPlate(input: string): PlateCheck {
  const plate = normalizePlate(input);
  return PLATE_RE.test(plate) ? { ok: true, plate } : { ok: false, normalized: plate };
}

/** А123ВС777 → А 123 ВС 777 */
export function formatPlate(plate: string): string {
  const m = /^(.)(\d{3})(..)(\d{2,3})$/.exec(plate);
  return m ? `${m[1]} ${m[2]} ${m[3]} ${m[4]}` : plate;
}
