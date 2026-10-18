/**
 * Проверка загрузки сертификатов: собственный тестовый CA → HTTPS-сервер → fetch и node:https
 * не доверяют ему до installExtraCa и доверяют после.
 */
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { createServer, get } from 'node:https';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { DEFAULT_CA_DIR, installExtraCa, readCaDir } from '../src/tls-ca.js';

const silent = { log: () => undefined, warn: () => undefined };

describe('сертификаты Минцифры в ca/', () => {
  it('читаются все три, корневой действует до 2032 года', () => {
    const certs = readCaDir(DEFAULT_CA_DIR);
    expect(certs.map((c) => c.subject)).toEqual(['Russian Trusted Root CA', 'Russian Trusted Sub CA', 'Russian Trusted Sub CA']);
    expect(certs[0]!.validTo.getUTCFullYear()).toBe(2032);
  });
});

const hasOpenssl = (() => {
  try {
    execFileSync('openssl', ['version'], { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
})();

// Тестовый CA генерируется через openssl; на машине без openssl (часто Windows) блок пропускается.
describe.skipIf(!hasOpenssl)('installExtraCa', () => {
  let dir: string;
  let caDir: string;
  let server: ReturnType<typeof createServer>;
  let url: string;

  beforeAll(async () => {
    dir = mkdtempSync(join(tmpdir(), 'tls-ca-'));
    caDir = join(dir, 'ca');
    mkdirSync(caDir);
    const run = (...args: string[]) => execFileSync('openssl', args, { cwd: dir, stdio: 'pipe' });
    run('req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-keyout', 'ca.key', '-out', 'ca.pem', '-days', '2', '-subj', '/CN=Test Root CA');
    run('req', '-newkey', 'rsa:2048', '-nodes', '-keyout', 'srv.key', '-out', 'srv.csr', '-subj', '/CN=localhost');
    writeFileSync(join(dir, 'ext.cnf'), 'subjectAltName=DNS:localhost,IP:127.0.0.1\n');
    run('x509', '-req', '-in', 'srv.csr', '-CA', 'ca.pem', '-CAkey', 'ca.key', '-CAcreateserial', '-out', 'srv.pem', '-days', '2', '-extfile', 'ext.cnf');
    // корневой — в DER, чтобы проверить и этот формат
    run('x509', '-in', 'ca.pem', '-outform', 'DER', '-out', join(caDir, 'test-root.cer'));

    server = createServer({ key: readFileSync(join(dir, 'srv.key')), cert: readFileSync(join(dir, 'srv.pem')) }, (_req, res) => res.end('ok'));
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
    url = `https://localhost:${(server.address() as AddressInfo).port}/`;
  });

  afterAll(() => server?.close());

  const viaHttps = () =>
    new Promise<string>((resolve, reject) => {
      get(url, (res) => { res.resume(); res.on('end', () => resolve(String(res.statusCode))); }).on('error', reject);
    });

  it('без сертификата соединение не доверено, после — работает и fetch, и node:https', async () => {
    await expect(fetch(url)).rejects.toThrow();
    await expect(viaHttps()).rejects.toThrow();

    const result = installExtraCa(caDir, silent);
    expect(result.loaded.map((c) => c.subject)).toEqual(['Test Root CA']);

    expect(await (await fetch(url)).text()).toBe('ok');
    expect(await viaHttps()).toBe('200');
  });

  it('стандартные сертификаты не теряются', async () => {
    const tls = await import('node:tls');
    const all = (tls as unknown as { getCACertificates: (t: string) => string[] }).getCACertificates('default');
    expect(all.length).toBeGreaterThan(100);
  });

  it('нет каталога — ничего не делает', () => {
    expect(installExtraCa(join(dir, 'missing'), silent)).toEqual({ dir: null, loaded: [], method: 'none' });
  });
});
