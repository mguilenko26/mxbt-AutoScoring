/**
 * Профиль автомобиля как набор «утверждений» с источником.
 * Мы не выбираем одно значение, а храним всё, что сказали клиент и внешние сервисы,
 * и передаём это в скоринг вместе со списком расхождений.
 */

export type Source = 'client' | 'plate_service' | 'vin_service' | 'ai_enrichment';

export interface Claim<T> {
  value: T;
  source: Source;
  confirmedByClient: boolean;
  receivedAt: string; // ISO
}

export type VehicleField = 'make' | 'model' | 'year' | 'mileageKm' | 'engine' | 'transmission' | 'bodyType';

export interface VehicleProfile {
  vin?: Claim<string>;
  /** VIN введён клиентом (true) или найден по госномеру (false — показываем только маску). */
  vinEnteredByClient: boolean;
  plate?: Claim<string>;
  make: Claim<string>[];
  model: Claim<string>[];
  year: Claim<number>[];
  mileageKm: Claim<number>[];
  engine: Claim<string>[];
  transmission: Claim<string>[];
  bodyType: Claim<string>[];
}

export function emptyProfile(): VehicleProfile {
  return {
    vinEnteredByClient: false,
    make: [], model: [], year: [], mileageKm: [], engine: [], transmission: [], bodyType: [],
  };
}

export function claim<T>(value: T, source: Source, confirmedByClient = false): Claim<T> {
  return { value, source, confirmedByClient, receivedAt: new Date().toISOString() };
}

/** Добавить утверждение, заменив прежнее от того же источника. */
export function putClaim<F extends VehicleField>(
  profile: VehicleProfile,
  field: F,
  c: VehicleProfile[F][number],
): void {
  const list = profile[field] as Claim<unknown>[];
  const idx = list.findIndex((x) => x.source === c.source);
  if (idx >= 0) list[idx] = c;
  else list.push(c);
}

/** Клиент подтвердил карточку «это мой автомобиль» — отмечаем данные сервиса как подтверждённые. */
export function confirmServiceData(profile: VehicleProfile): void {
  for (const field of ['make', 'model', 'year', 'engine', 'transmission', 'bodyType'] as const) {
    for (const c of profile[field] as Claim<unknown>[]) {
      if (c.source === 'vin_service') c.confirmedByClient = true;
    }
  }
}

/** Значение для показа: приоритет у клиента, затем у VIN-сервиса. */
export function best<T>(list: Claim<T>[]): T | undefined {
  const order: Source[] = ['client', 'vin_service', 'plate_service', 'ai_enrichment'];
  for (const s of order) {
    const found = list.find((c) => c.source === s);
    if (found) return found.value;
  }
  return undefined;
}

/** Список расхождений между клиентом и сервисами, например `year: client=2019, vin_service=2018`. */
export function discrepancies(profile: VehicleProfile): string[] {
  const out: string[] = [];
  for (const field of ['make', 'model', 'year', 'mileageKm', 'engine', 'transmission'] as const) {
    const list = profile[field] as Claim<string | number>[];
    const norm = (v: string | number) => String(v).trim().toLowerCase();
    const distinct = new Set(list.map((c) => norm(c.value)));
    if (distinct.size > 1) {
      out.push(`${field}: ${list.map((c) => `${c.source}=${c.value}`).join(', ')}`);
    }
  }
  return out;
}

export function describeVehicle(profile: VehicleProfile): string {
  const parts = [best(profile.make), best(profile.model)].filter(Boolean).join(' ');
  const year = best(profile.year);
  const engine = best(profile.engine);
  const trans = best(profile.transmission);
  return [parts || 'Автомобиль', year && `${year} г.`, engine, trans].filter(Boolean).join(', ');
}
