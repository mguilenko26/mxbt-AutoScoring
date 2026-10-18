/**
 * Дополнительные корневые и промежуточные сертификаты (Минцифры) из папки ca/.
 *
 * API MAX (platform-api2.max.ru) подписан сертификатом Russian Trusted Root CA, которого нет
 * во встроенном хранилище Node.js. Сертификаты добавляются к стандартному набору для всего процесса —
 * это касается и fetch (запросы к API), и node:https (загрузка файлов в библиотеке MAX).
 *
 * Вызывать до первого исходящего HTTPS-запроса.
 */
import { X509Certificate } from 'node:crypto';
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { join, resolve } from 'node:path';
import tls from 'node:tls';
import { fileURLToPath } from 'node:url';

/** Папка ca/ в корне проекта — не зависит от того, из какого каталога запущен процесс. */
export const DEFAULT_CA_DIR = fileURLToPath(new URL('../ca', import.meta.url));

const CERT_EXT = /\.(pem|crt|cer)$/i;
const PEM_BLOCK = /-----BEGIN CERTIFICATE-----[\s\S]+?-----END CERTIFICATE-----/g;
const EXPIRY_WARN_DAYS = 60;

export interface LoadedCert {
  file: string;
  subject: string;
  validTo: Date;
  pem: string;
}

/** Прочитать сертификаты из каталога. Поддерживаются PEM (в т. ч. несколько в одном файле) и DER. */
export function readCaDir(dir: string): LoadedCert[] {
  const out: LoadedCert[] = [];
  for (const name of readdirSync(dir).filter((n) => CERT_EXT.test(n)).sort()) {
    const raw = readFileSync(join(dir, name));
    const text = raw.toString('latin1');
    const blocks = text.includes('-----BEGIN CERTIFICATE-----') ? (text.match(PEM_BLOCK) ?? []) : [raw];
    for (const block of blocks) {
      const x509 = new X509Certificate(block); // бросит ошибку на битом файле
      out.push({
        file: name,
        subject: x509.subject.split('\n').find((l) => l.startsWith('CN='))?.slice(3) ?? x509.subject,
        validTo: new Date(x509.validTo),
        pem: x509.toString(), // всегда PEM, даже если файл был в DER
      });
    }
  }
  return out;
}

export interface InstallResult {
  dir: string | null;
  loaded: LoadedCert[];
  method: 'setDefaultCACertificates' | 'none';
}

/**
 * Добавить сертификаты из CA_DIR (по умолчанию ./ca) к доверенным.
 * Без каталога ничего не делает — например, если сертификаты уже есть в системе и задан --use-system-ca.
 */
export function installExtraCa(
  dir = process.env.CA_DIR || DEFAULT_CA_DIR,
  log: Pick<Console, 'log' | 'warn'> = console,
): InstallResult {
  const abs = resolve(dir);
  if (!existsSync(abs) || !statSync(abs).isDirectory()) return { dir: null, loaded: [], method: 'none' };

  const now = Date.now();
  const all = readCaDir(abs);
  const loaded = all.filter((c) => {
    if (c.validTo.getTime() < now) {
      log.warn(`[tls] пропущен просроченный сертификат ${c.file} (${c.subject}, до ${c.validTo.toISOString().slice(0, 10)})`);
      return false;
    }
    const days = Math.floor((c.validTo.getTime() - now) / 86_400_000);
    if (days < EXPIRY_WARN_DAYS) log.warn(`[tls] сертификат ${c.file} истекает через ${days} дн. — обновите его на gosuslugi.ru/crt`);
    return true;
  });
  if (loaded.length === 0) return { dir: abs, loaded, method: 'none' };

  // Node.js ≥ 22.19 / ≥ 24.5: можно расширить набор доверенных сертификатов на лету.
  const t = tls as typeof tls & {
    setDefaultCACertificates?: (certs: string[]) => void;
    getCACertificates?: (type?: 'default' | 'system' | 'bundled' | 'extra') => string[];
  };
  if (typeof t.setDefaultCACertificates !== 'function' || typeof t.getCACertificates !== 'function') {
    throw new Error(
      `Node.js ${process.version} не умеет добавлять сертификаты во время работы. ` +
        `Обновите Node.js до 22.19+ или запускайте с переменной NODE_EXTRA_CA_CERTS=<файл.pem>.`,
    );
  }
  const current = t.getCACertificates('default'); // встроенные + NODE_EXTRA_CA_CERTS + системные (--use-system-ca)
  const known = new Set(current.map((p) => p.replace(/\s+/g, '')));
  const extra = loaded.map((c) => c.pem).filter((p) => !known.has(p.replace(/\s+/g, '')));
  t.setDefaultCACertificates([...current, ...extra]);

  log.log(`[tls] добавлены сертификаты: ${loaded.map((c) => `${c.subject} (${c.file})`).join(', ')}`);
  return { dir: abs, loaded, method: 'setDefaultCACertificates' };
}
