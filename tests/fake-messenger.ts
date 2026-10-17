/** Мессенджер-двойник для тестов: хранит сообщения и правки, позволяет «нажимать» кнопки. */
import type { Button, InboundEvent, Messenger, OutgoingMessage, UserRef } from '../src/messenger/types.js';

export interface Sent {
  id: string;
  userId: number;
  msg: OutgoingMessage;
  edits: OutgoingMessage[];
}

export class FakeMessenger implements Messenger {
  readonly messages: Sent[] = [];
  readonly callbackAnswers: { callbackId: string; notification?: string; message?: OutgoingMessage }[] = [];
  private seq = 0;
  rejectLinks = false;

  async send(userId: number, msg: OutgoingMessage) {
    if (this.rejectLinks && msg.buttons?.flat().some((b) => b.type === 'link')) throw new Error('invalid url');
    const id = `mid.${++this.seq}`;
    this.messages.push({ id, userId, msg, edits: [] });
    return { messageId: id };
  }

  async edit(messageId: string, msg: OutgoingMessage) {
    const m = this.messages.find((x) => x.id === messageId);
    if (!m) throw new Error(`no message ${messageId}`);
    m.edits.push(msg);
  }

  async answerCallback(callbackId: string, opts: { notification?: string; message?: OutgoingMessage }) {
    this.callbackAnswers.push({ callbackId, ...opts });
    const id = this.pendingCallbackMessage.get(callbackId);
    if (opts.message && id) await this.edit(id, opts.message);
  }

  async typing() {}

  // --- помощники тестов ---

  private readonly pendingCallbackMessage = new Map<string, string>();

  last(): Sent {
    const m = this.messages.at(-1);
    if (!m) throw new Error('no messages');
    return m;
  }

  current(m: Sent): OutgoingMessage {
    return m.edits.at(-1) ?? m.msg;
  }

  texts(): string[] {
    return this.messages.map((m) => this.current(m).text);
  }

  /** Найти последнюю кнопку с подписью, содержащей label, и сформировать событие нажатия. */
  press(user: UserRef, label: string): InboundEvent {
    for (let i = this.messages.length - 1; i >= 0; i--) {
      const m = this.messages[i]!;
      const btn = (this.current(m).buttons ?? []).flat().find((b: Button) => b.text.includes(label));
      if (btn && btn.type === 'callback') {
        const callbackId = `cb.${++this.seq}`;
        this.pendingCallbackMessage.set(callbackId, m.id);
        return { type: 'callback', user, callbackId, payload: btn.payload, messageId: m.id, messageText: this.current(m).text };
      }
    }
    throw new Error(`button "${label}" not found. Last: ${JSON.stringify(this.last().msg)}`);
  }
}
