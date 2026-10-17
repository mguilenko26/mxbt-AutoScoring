/**
 * Тестовые данные mock-сервисов. Сценарии описаны в README («Тестовые сценарии»).
 */
import { createHash } from 'node:crypto';
import type { DecodedVehicle } from '../src/services/ports.js';

export const VEHICLES: Record<string, DecodedVehicle> = {
  XW8ZZZ61ZJG012345: { make: 'Volkswagen', model: 'Polo', year: 2018, engine: '1.6 л, бензин', transmission: 'АКПП', bodyType: 'седан' },
  Z94CB41AAER123456: { make: 'Hyundai', model: 'Solaris', year: 2014, engine: '1.6 л, бензин', transmission: 'МКПП', bodyType: 'седан' },
  JTNB23HK103012345: { make: 'Toyota', model: 'Camry', year: 2019, engine: '2.5 л, бензин', transmission: 'АКПП', bodyType: 'седан' },
  XTA219010K0123456: { make: 'Lada', model: 'Granta', year: 2019, engine: '1.6 л, бензин', transmission: 'МКПП', bodyType: 'седан' },
  LVTDB21B4ND123456: { make: 'Chery', model: 'Tiggo 7 Pro', year: 2022, engine: '1.5 л, турбо', transmission: 'вариатор', bodyType: 'кроссовер' },
};

/** Госномер → VIN-ы. Отсутствие ключа = номер генерируется детерминированно (см. vinForPlate). */
export const PLATES: Record<string, string[]> = {
  А111АА77: ['XW8ZZZ61ZJG012345'],
  В222ВВ99: ['Z94CB41AAER123456', 'JTNB23HK103012345'], // несколько VIN — номер перерегистрировали
  С333СС50: [], // не найден
  Е444КХ777: ['LVTDB21B4ND123456'],
  М555ММ77: ['WVWZZZ1KZ6B100000'], // VIN найден, но декодер его не знает
};

const CATALOG: Omit<DecodedVehicle, 'year'>[] = [
  { make: 'Kia', model: 'Rio', engine: '1.6 л, бензин', transmission: 'АКПП', bodyType: 'седан' },
  { make: 'Skoda', model: 'Octavia', engine: '1.4 л, турбо', transmission: 'робот DSG', bodyType: 'лифтбек' },
  { make: 'Renault', model: 'Duster', engine: '2.0 л, бензин', transmission: 'МКПП', bodyType: 'кроссовер' },
  { make: 'Haval', model: 'Jolion', engine: '1.5 л, турбо', transmission: 'робот', bodyType: 'кроссовер' },
  { make: 'Nissan', model: 'Qashqai', engine: '2.0 л, бензин', transmission: 'вариатор', bodyType: 'кроссовер' },
  { make: 'Mazda', model: 'CX-5', engine: '2.0 л, бензин', transmission: 'АКПП', bodyType: 'кроссовер' },
];

const VIN_ALPHABET = 'ABCDEFGHJKLMNPRSTUVWXYZ0123456789';

function hashBytes(s: string): Buffer {
  return createHash('sha256').update(s).digest();
}

/** Любой корректный госномер, которого нет в PLATES, детерминированно превращается в VIN. */
export function vinForPlate(plate: string): string {
  const h = hashBytes(`plate:${plate}`);
  let vin = 'X9F';
  for (let i = 0; i < 9; i++) vin += VIN_ALPHABET[h[i]! % VIN_ALPHABET.length];
  // последние 5 символов — цифры, не совпадающие со «служебными» окончаниями сценариев
  let tail = String(10000 + (h.readUInt32BE(12) % 60000)).padStart(5, '0');
  if (/^(00000|77777|88888|99999)$/.test(tail)) tail = '12345';
  return vin + tail;
}

/** Неизвестный VIN детерминированно декодируется в одну из моделей каталога. */
export function decodeUnknown(vin: string): DecodedVehicle {
  const h = hashBytes(`vin:${vin}`);
  const base = CATALOG[h[0]! % CATALOG.length]!;
  return { ...base, year: 2010 + (h[1]! % 14) };
}
