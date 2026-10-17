/**
 * Адаптер к MAX Bot API на официальной библиотеке @maxhub/max-bot-api.
 * Переводит события MAX в InboundEvent и реализует порт Messenger.
 */
import { Bot } from '@maxhub/max-bot-api';
import type { InboundEvent, Messenger, OutgoingMessage, UserRef } from './types.js';

// Минимальные формы объектов MAX (по OpenAPI-спецификации github.com/max-messenger/api-schema).
interface MaxUser { user_id: number; first_name?: string; username?: string | null }
interface MaxAttachment { type: string; payload?: Record<string, unknown> }
interface MaxMessage {
  sender?: MaxUser | null;
  recipient: { chat_id?: number | null; chat_type?: string; user_id?: number | null };
  body?: { mid: string; text?: string | null; attachments?: MaxAttachment[] | null } | null;
}
type MaxUpdate =
  | { update_type: 'bot_started'; chat_id: number; user: MaxUser; payload?: string | null }
  | { update_type: 'bot_stopped'; chat_id: number; user: MaxUser }
  | { update_type: 'message_created'; message: MaxMessage }
  | { update_type: 'message_callback'; callback: { callback_id: string; payload?: string; user: MaxUser }; message?: MaxMessage | null }
  | { update_type: string };

function userRef(u: MaxUser, chatId?: number | null): UserRef {
  return { userId: u.user_id, chatId: chatId ?? undefined, firstName: u.first_name, username: u.username };
}

/** MAX Update → событие бота. null — событие нам не интересно (группы, каналы, служебные). */
export function toInboundEvent(update: MaxUpdate): InboundEvent | null {
  switch (update.update_type) {
    case 'bot_started': {
      const u = update as Extract<MaxUpdate, { update_type: 'bot_started' }>;
      return { type: 'start', user: userRef(u.user, u.chat_id), payload: u.payload };
    }
    case 'bot_stopped': {
      const u = update as Extract<MaxUpdate, { update_type: 'bot_stopped' }>;
      return { type: 'stopped', user: userRef(u.user, u.chat_id) };
    }
    case 'message_created': {
      const { message } = update as Extract<MaxUpdate, { update_type: 'message_created' }>;
      if (!message?.sender || message.sender.user_id == null) return null;
      if (message.recipient.chat_type && message.recipient.chat_type !== 'dialog') return null; // только личные диалоги
      const user = userRef(message.sender, message.recipient.chat_id);
      const contact = message.body?.attachments?.find((a) => a.type === 'contact');
      if (contact?.payload && typeof contact.payload.vcf_info === 'string') {
        return {
          type: 'contact',
          user,
          contact: {
            vcfInfo: contact.payload.vcf_info,
            hash: (contact.payload.hash as string | null | undefined) ?? null,
            maxInfo: (contact.payload.max_info as { user_id?: number } | undefined) ?? undefined,
          },
        };
      }
      const text = message.body?.text?.trim();
      if (!text) return null;
      if (/^\/start\b/.test(text)) return { type: 'start', user, payload: text.split(/\s+/)[1] ?? null };
      return { type: 'text', user, text };
    }
    case 'message_callback': {
      const u = update as Extract<MaxUpdate, { update_type: 'message_callback' }>;
      return {
        type: 'callback',
        user: userRef(u.callback.user, u.message?.recipient.chat_id),
        callbackId: u.callback.callback_id,
        payload: u.callback.payload ?? '',
        messageId: u.message?.body?.mid,
        messageText: u.message?.body?.text ?? undefined,
      };
    }
    default:
      return null;
  }
}

function toAttachments(msg: OutgoingMessage) {
  // Пустой массив в MAX удаляет вложения (клавиатуру) при редактировании.
  if (!msg.buttons || msg.buttons.length === 0) return [];
  return [{ type: 'inline_keyboard' as const, payload: { buttons: msg.buttons } }];
}

function toBody(msg: OutgoingMessage) {
  return {
    text: msg.text,
    format: msg.format ?? 'markdown',
    attachments: toAttachments(msg),
    notify: msg.notify ?? true,
  };
}

export class MaxMessenger implements Messenger {
  constructor(private readonly bot: Bot) {}

  async send(userId: number, msg: OutgoingMessage) {
    const { text, ...extra } = toBody(msg);
    // Типы библиотеки строже наших кнопок; структура совпадает со спецификацией MAX.
    const message = (await this.bot.api.sendMessageToUser(userId, text, extra as never)) as unknown as MaxMessage;
    return { messageId: message.body?.mid ?? '' };
  }

  async edit(messageId: string, msg: OutgoingMessage) {
    const res = (await this.bot.api.editMessage(messageId, toBody(msg) as never)) as { success?: boolean; message?: string };
    if (res && res.success === false) throw new Error(`MAX editMessage: ${res.message ?? 'failed'}`);
  }

  async answerCallback(callbackId: string, opts: { notification?: string; message?: OutgoingMessage }) {
    await this.bot.api.answerOnCallback(callbackId, {
      notification: opts.notification,
      message: opts.message ? toBody(opts.message) : undefined,
    } as never);
  }

  async typing(chatId: number) {
    await this.bot.api.sendAction(chatId, 'typing_on' as never);
  }
}
