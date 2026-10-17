/**
 * Порт мессенджера. Логика бота (src/bot) работает только с этими типами,
 * поэтому её можно прогонять в тестах без MAX, а MAX подключается адаптером (max.ts).
 * Кнопки и формат повторяют MAX Bot API, чтобы адаптер был тонким.
 */

export type Button =
  | { type: 'callback'; text: string; payload: string }
  | { type: 'link'; text: string; url: string }
  | { type: 'request_contact'; text: string }
  | { type: 'open_app'; text: string; web_app: string; payload?: string };

export interface OutgoingMessage {
  text: string;
  format?: 'markdown' | 'html';
  /** Ряды кнопок inline-клавиатуры. Пустой массив — убрать клавиатуру. */
  buttons?: Button[][];
  /** false — без push-уведомления. */
  notify?: boolean;
}

export interface UserRef {
  userId: number;
  chatId?: number;
  firstName?: string;
  username?: string | null;
}

export interface ContactShare {
  vcfInfo: string;
  hash?: string | null;
  /** Данные MAX о владельце контакта (если есть) — сверяем user_id с отправителем. */
  maxInfo?: { user_id?: number } & Record<string, unknown>;
}

export type InboundEvent =
  | { type: 'start'; user: UserRef; payload?: string | null }
  | { type: 'text'; user: UserRef; text: string }
  | { type: 'callback'; user: UserRef; callbackId: string; payload: string; messageId?: string; messageText?: string }
  | { type: 'contact'; user: UserRef; contact: ContactShare }
  | { type: 'stopped'; user: UserRef };

export interface Messenger {
  /** Отправить сообщение пользователю в диалог с ботом. Возвращает id сообщения (mid). */
  send(userId: number, msg: OutgoingMessage): Promise<{ messageId: string }>;
  edit(messageId: string, msg: OutgoingMessage): Promise<void>;
  /** Ответ на нажатие кнопки: короткое уведомление и/или замена исходного сообщения. */
  answerCallback(callbackId: string, opts: { notification?: string; message?: OutgoingMessage }): Promise<void>;
  /** Индикатор «печатает…». */
  typing(chatId: number): Promise<void>;
}
