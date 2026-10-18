/**
 * Webhook-подписки бота в MAX.
 *   npm run webhooks                  — показать подписки
 *   npm run webhooks -- delete <url>  — удалить одну
 *   npm run webhooks -- delete-all    — удалить все (нужно для режима polling)
 */
import { Bot } from '@maxhub/max-bot-api';
import { installExtraCa } from '../src/tls-ca.js';

installExtraCa(undefined, { log: () => undefined, warn: console.warn });

const token = process.env.MAX_BOT_TOKEN;
if (!token) {
  console.error('Не задан MAX_BOT_TOKEN (.env)');
  process.exit(1);
}
const api = new Bot(token).api;
const [cmd, arg] = process.argv.slice(2);

const subs = await api.getSubscriptions();
const print = () => {
  if (subs.length === 0) return console.log('Webhook-подписок нет — бот может работать в режиме polling.');
  console.log(`Webhook-подписки (${subs.length}):`);
  for (const s of subs as { url: string; time?: number; updateTypes?: string[] | null }[]) {
    const since = s.time ? new Date(s.time).toLocaleString('ru-RU') : '—';
    console.log(`  • ${s.url}\n      с ${since}; события: ${s.updateTypes?.join(', ') || 'все'}`);
  }
};

if (!cmd || cmd === 'list') {
  print();
} else if (cmd === 'delete' && arg) {
  const res = await api.unsubscribe(arg);
  console.log(res.success ? `Удалена подписка ${arg}` : `Не удалось удалить ${arg}: ${res.message ?? 'ошибка'}`);
} else if (cmd === 'delete-all') {
  if (subs.length === 0) print();
  for (const s of subs) {
    const res = await api.unsubscribe(s.url);
    console.log(res.success ? `Удалена подписка ${s.url}` : `Не удалось удалить ${s.url}: ${res.message ?? 'ошибка'}`);
  }
} else {
  console.log('Использование: npm run webhooks [-- list | delete <url> | delete-all]');
  process.exitCode = 1;
}
