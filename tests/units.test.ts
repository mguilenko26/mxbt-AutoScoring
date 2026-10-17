import { describe, expect, it } from 'vitest';
import { checkPlate, checkVin, maskVin, normalizePlate } from '../src/domain/identifiers.js';
import { claim, discrepancies, emptyProfile, putClaim } from '../src/domain/vehicle.js';
import { contactHash, parseVcf, verifyContact } from '../src/bot/contact.js';
import { parseMileage } from '../src/bot/insurance-bot.js';
import { toInboundEvent } from '../src/messenger/max.js';
import { PLATES, VEHICLES, vinForPlate } from '../mocks/fixtures.js';

describe('VIN', () => {
  it('принимает корректный VIN и нормализует регистр, пробелы и кириллицу', () => {
    expect(checkVin(' xw8zzz61zjg 012345 ')).toEqual({ ok: true, vin: 'XW8ZZZ61ZJG012345' });
    expect(checkVin('ХW8ZZZ61ZJG012345')).toEqual({ ok: true, vin: 'XW8ZZZ61ZJG012345' }); // кириллическая Х
  });
  it('отклоняет неверную длину и буквы I/O/Q', () => {
    expect(checkVin('XW8ZZZ61ZJG01234')).toMatchObject({ ok: false, reason: 'length' });
    expect(checkVin('XW8ZZZ61ZJGO12345')).toMatchObject({ ok: false, reason: 'forbidden_letters' });
  });
  it('маскирует VIN', () => {
    expect(maskVin('XW8ZZZ61ZJG012345')).toBe('XW8*********12345');
  });
  it('все VIN фикстур корректны', () => {
    for (const vin of [...Object.keys(VEHICLES), ...Object.values(PLATES).flat()]) expect(checkVin(vin).ok, vin).toBe(true);
    expect(checkVin(vinForPlate('А123ВС77')).ok).toBe(true);
  });
});

describe('Госномер', () => {
  it('нормализует латиницу в кириллицу и убирает RUS', () => {
    expect(normalizePlate('a 123 bc 777 rus')).toBe('А123ВС777');
    expect(checkPlate('А123ВС77')).toEqual({ ok: true, plate: 'А123ВС77' });
  });
  it('отклоняет недопустимые буквы', () => {
    expect(checkPlate('Ж123ВС77').ok).toBe(false);
  });
  it('ключи фикстур — валидные госномера в кириллице', () => {
    for (const plate of Object.keys(PLATES)) expect(checkPlate(plate), plate).toEqual({ ok: true, plate });
  });
});

describe('Профиль авто', () => {
  it('находит расхождения клиент ↔ сервис', () => {
    const p = emptyProfile();
    putClaim(p, 'year', claim(2018, 'vin_service'));
    putClaim(p, 'year', claim(2019, 'client', true));
    putClaim(p, 'make', claim('Toyota', 'vin_service'));
    putClaim(p, 'make', claim('toyota', 'client', true));
    expect(discrepancies(p)).toEqual(['year: vin_service=2018, client=2019']);
  });
});

describe('Пробег', () => {
  it.each([
    ['85000', 85000], ['85 000 км', 85000], ['85 тыс', 85000], ['85к', 85000], ['120,5 тыс', 120500],
  ])('%s → %d', (text, km) => expect(parseMileage(text)).toBe(km));
  it.each(['много', '-5', '9999999'])('%s → null', (text) => expect(parseMileage(text)).toBeNull());
});

describe('Контакт из request_contact', () => {
  const token = 'test-token';
  const vcfEscaped = 'BEGIN:VCARD\\r\\nVERSION:3.0\\r\\nFN:Иван Петров\\r\\nTEL;TYPE=cell:89161234567\\r\\nEND:VCARD';

  it('разбирает vCard и нормализует номер', () => {
    expect(parseVcf(vcfEscaped)).toEqual({ phone: '79161234567', fullName: 'Иван Петров' });
  });
  it('принимает hash в hex и base64', () => {
    const { hex, base64 } = contactHash(vcfEscaped, token);
    expect(verifyContact({ vcfInfo: vcfEscaped, hash: hex }, 1, token)).toMatchObject({ verified: true, phone: '79161234567' });
    expect(verifyContact({ vcfInfo: vcfEscaped, hash: base64 }, 1, token).verified).toBe(true);
  });
  it('без hash, с чужим hash или чужим владельцем — не подтверждён', () => {
    expect(verifyContact({ vcfInfo: vcfEscaped }, 1, token)).toMatchObject({ verified: false, reason: 'no_hash' });
    expect(verifyContact({ vcfInfo: vcfEscaped, hash: 'abc' }, 1, token)).toMatchObject({ verified: false, reason: 'bad_hash' });
    const { hex } = contactHash(vcfEscaped, token);
    expect(verifyContact({ vcfInfo: vcfEscaped, hash: hex, maxInfo: { user_id: 2 } }, 1, token)).toMatchObject({ reason: 'other_user' });
  });
});

describe('Адаптер MAX', () => {
  const user = { user_id: 42, first_name: 'Иван', is_bot: false };
  it('bot_started → start с payload', () => {
    expect(toInboundEvent({ update_type: 'bot_started', chat_id: 7, user, payload: 'promo' } as never)).toMatchObject({
      type: 'start', user: { userId: 42, chatId: 7 }, payload: 'promo',
    });
  });
  it('message_created: текст, /start, контакт; игнорирует групповые чаты', () => {
    const msg = (body: object, chat_type = 'dialog') => ({
      update_type: 'message_created',
      message: { sender: user, recipient: { chat_id: 7, chat_type }, timestamp: 0, body: { mid: 'm1', seq: 1, ...body } },
    });
    expect(toInboundEvent(msg({ text: 'XW8ZZZ61ZJG012345' }) as never)).toMatchObject({ type: 'text', text: 'XW8ZZZ61ZJG012345' });
    expect(toInboundEvent(msg({ text: '/start' }) as never)).toMatchObject({ type: 'start' });
    expect(toInboundEvent(msg({ attachments: [{ type: 'contact', payload: { vcf_info: 'BEGIN:VCARD', hash: 'h' } }] }) as never))
      .toMatchObject({ type: 'contact', contact: { vcfInfo: 'BEGIN:VCARD', hash: 'h' } });
    expect(toInboundEvent(msg({ text: 'hi' }, 'chat') as never)).toBeNull();
  });
  it('message_callback → callback с текстом исходного сообщения', () => {
    expect(toInboundEvent({
      update_type: 'message_callback',
      callback: { callback_id: 'c1', payload: 'calc:abc', user, timestamp: 0 },
      message: { recipient: { chat_id: 7, chat_type: 'dialog' }, body: { mid: 'm9', text: 'Вопрос' } },
    } as never)).toMatchObject({ type: 'callback', callbackId: 'c1', payload: 'calc:abc', messageId: 'm9', messageText: 'Вопрос' });
  });
});
