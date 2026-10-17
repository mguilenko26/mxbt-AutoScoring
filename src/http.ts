/**
 * HTTP-сервер бота для входящих уведомлений, кроме событий MAX:
 *   POST /payments/webhook — уведомление эквайера об оплате (подпись проверяет PaymentProvider)
 *   GET  /health
 */
import { createServer, type Server } from 'node:http';
import type { InsuranceBot } from './bot/insurance-bot.js';
import type { PaymentProvider } from './services/ports.js';

export function createBotHttpServer(bot: InsuranceBot, payments: PaymentProvider, log = console): Server {
  return createServer(async (req, res) => {
    const url = new URL(req.url ?? '/', 'http://local');
    if (req.method === 'GET' && url.pathname === '/health') {
      res.writeHead(200, { 'content-type': 'application/json' });
      return res.end('{"ok":true}');
    }
    if (req.method === 'POST' && url.pathname === '/payments/webhook') {
      const chunks: Buffer[] = [];
      for await (const c of req) chunks.push(c as Buffer);
      const raw = Buffer.concat(chunks).toString('utf8');
      const event = payments.parseWebhook(raw, req.headers);
      if (!event) {
        log.warn('[http] payment webhook: bad signature or body');
        res.writeHead(401, { 'content-type': 'application/json' });
        return res.end('{"code":13}');
      }
      const result = await bot.onPaymentEvent(event).catch((e) => {
        log.error('[http] payment webhook handling failed', e);
        return 'error' as const;
      });
      if (result === 'error') {
        res.writeHead(500, { 'content-type': 'application/json' });
        return res.end('{"code":500}'); // эквайер повторит уведомление
      }
      if (result === 'unknown_order') log.warn(`[http] payment webhook for unknown order ${event.orderId}`);
      // Формат ответа как у CloudPayments: {"code":0} — уведомление принято.
      res.writeHead(200, { 'content-type': 'application/json' });
      return res.end('{"code":0}');
    }
    res.writeHead(404).end();
  });
}
