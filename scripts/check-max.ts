/**
 * Проверка связи с API MAX: сертификаты, сеть и токен. `npm run check:max`
 */
import { installExtraCa } from '../src/tls-ca.js';

const BASE = 'https://platform-api2.max.ru';
installExtraCa();

try {
  const token = process.env.MAX_BOT_TOKEN;
  const res = await fetch(`${BASE}/me`, { headers: token ? { Authorization: token } : {} });
  const body = await res.text();
  if (res.ok) {
    const me = JSON.parse(body) as { username?: string; user_id?: number };
    console.log(`✅ Связь с MAX есть, токен верный: бот @${me.username} (${me.user_id})`);
  } else if (res.status === 401) {
    console.log(token
      ? '⚠️ Связь с MAX есть, но токен отклонён (401). Проверьте MAX_BOT_TOKEN в .env.'
      : '✅ Связь с MAX есть (TLS в порядке). Токен не задан — впишите MAX_BOT_TOKEN в .env.');
  } else {
    console.log(`⚠️ MAX ответил ${res.status}: ${body.slice(0, 200)}`);
  }
} catch (e) {
  const cause = (e as { cause?: { code?: string; message?: string } }).cause;
  console.error(`❌ Нет связи с ${BASE}: ${cause?.code ?? ''} ${cause?.message ?? (e as Error).message}`);
  if (cause?.code?.includes('CERT') || /certificate/i.test(cause?.message ?? '')) {
    console.error('   Проблема с сертификатом: проверьте, что в папке ca/ лежат сертификаты Минцифры (gosuslugi.ru/crt).');
  }
  process.exitCode = 1;
}
