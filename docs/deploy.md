# Установка на сервер (Debian 12)

> Кратко на одной странице: [install-quickstart.md](install-quickstart.md).

Скрипт [`deploy/install.sh`](../deploy/install.sh) разворачивает бота на чистом сервере Debian 12 (bookworm, ядро 6.1) за 5–10 минут. Его можно запускать повторно: сделанные шаги пропускаются, секреты и сертификат не перезаписываются.

```
Интернет ──HTTPS:443──► nginx (Let's Encrypt)
                          ├─ /max/webhook      ──► бот      127.0.0.1:3000   (события MAX)
                          ├─ /payments/webhook ──► бот      127.0.0.1:3000   (уведомления эквайера)
                          ├─ /health           ──► бот      127.0.0.1:3000
                          └─ /pay/…            ──► mock-эквайер 127.0.0.1:4000 (тестовая страница оплаты)
бот ──► mock-сервисы 127.0.0.1:4000 (госномер/VIN, AI, прайсинг, платежи)
бот ──► platform-api2.max.ru (API MAX, сертификаты Минцифры из ca/)
```

> ⚠️ **Что пока работает на mock-сервисах.** Внешние сервисы на сервере — это mock-сервер, как и при локальной проверке. Цены условные, оплата идёт через тестовую страницу, и деньги не списываются. Сессии хранятся в памяти, поэтому расчёты, которые шли в момент перезапуска, теряются. Перед приёмом реальных клиентов посмотрите раздел [«Перед реальным запуском»](#перед-реальным-запуском).

## Что нужно заранее

| Что | Подробности |
|---|---|
| Сервер | Debian 12, от 1 vCPU и 1 ГБ RAM, публичный IPv4, доступ root или sudo |
| Домен | A-запись `bot.example.com` указывает на IP сервера |
| Порты | 80 и 443 открыты снаружи. Проверьте файрвол в панели хостинга: порт 80 нужен Let's Encrypt для выдачи и продления сертификата |
| Исходящий доступ | `platform-api2.max.ru`, `github.com`, `deb.nodesource.com`, `registry.npmjs.org`, `acme-v02.api.letsencrypt.org` |
| Бот MAX | Токен бота. **Остановите локальный `npm run dev` с этим же токеном**: продакшен регистрирует webhook, а локальный бот в режиме polling с ним конфликтует. Для разработки лучше завести отдельного тестового бота |
| GitHub | Права администратора репозитория, чтобы добавить deploy key |

## Установка

**1. Скопируйте скрипт на сервер.** Репозиторий приватный, поэтому скачать скрипт по ссылке не получится. Скопируйте его с компьютера (в Windows `scp` есть в PowerShell):

```powershell
scp "H:\OneDrive\Документы\dev\mxbt-Autoscoring\deploy\install.sh" root@<IP-сервера>:/root/
```

**2. Запустите на сервере:**

```bash
ssh root@<IP-сервера>
DOMAIN=bot.example.com EMAIL=you@example.com bash /root/install.sh
```

Если включить `ENABLE_UFW=1`, скрипт ещё и настроит файрвол: оставит открытыми SSH, 80 и 443.

**3. По ходу работы скрипт дважды попросит ваших действий:**

- **Deploy key.** Скрипт покажет строку `ssh-ed25519 AAAA… mxbt-deploy@…`. Добавьте её в GitHub: репозиторий **mxbt-AutoScoring → Settings → Deploy keys → Add deploy key**. Галочку *Allow write access* не ставьте. Затем нажмите Enter в терминале.
- **Токен бота.** Вставьте токен, ввод не отображается. Он сохранится в `/etc/mxbt-autoscoring/env`, файл доступен только root и пользователю бота.

**4. Проверьте результат.** Скрипт закончится строкой `✅ Готово: https://bot.example.com/health отвечает`. Напишите боту `/start` в MAX и пройдите путь до оплаты. Кнопка «💳 Перейти к оплате» теперь настоящая и открывает тестовую страницу `https://bot.example.com/pay/…`.

## Что делает скрипт

1. Устанавливает git, nginx, certbot и Node.js 24 из репозитория NodeSource.
2. Создаёт системного пользователя `mxbt` без возможности входа.
3. Генерирует deploy key и клонирует репозиторий в `/opt/mxbt-autoscoring/app`, затем ставит зависимости через `npm ci --omit=dev`.
4. Создаёт `/etc/mxbt-autoscoring/env` с режимом `MAX_MODE=webhook` и случайными секретами для webhook MAX и для подписи уведомлений об оплате. Тестовые кнопки «🧪» в нём выключены.
5. Проверяет связь с API MAX и токен (`scripts/check-max.ts`).
6. Получает сертификат Let's Encrypt через `certbot --webroot` и настраивает nginx. Продление сертификата выполняет таймер certbot, а nginx перечитывает его через хук.
7. Ставит службы `mxbt-mocks` и `mxbt-bot` и запускает их. При старте бот сам регистрирует webhook `https://<домен>/max/webhook`.
8. Проверяет `https://<домен>/health`.

| Путь | Что там |
|---|---|
| `/opt/mxbt-autoscoring/app` | код (git) |
| `/etc/mxbt-autoscoring/env` | настройки и секреты (`640 root:mxbt`) |
| `/etc/systemd/system/mxbt-{bot,mocks}.service` | службы |
| `/etc/nginx/sites-available/mxbt-autoscoring.conf` | nginx |
| `/etc/letsencrypt/live/<домен>/` | сертификат |

## Эксплуатация

```bash
journalctl -u mxbt-bot -f                 # логи бота в реальном времени
journalctl -u mxbt-mocks -n 100           # последние строки mock-сервисов
systemctl status mxbt-bot mxbt-mocks      # состояние
systemctl restart mxbt-bot                # перезапуск (webhook сохраняется, MAX дошлёт события)
```

**Обновление** до последней версии из `main`:
```bash
bash /opt/mxbt-autoscoring/app/deploy/update.sh
```
Скрипт проверит связь с MAX до перезапуска. Если после обновления бот не ответит, скрипт покажет команду отката:
```bash
REF=<коммит> bash /opt/mxbt-autoscoring/app/deploy/update.sh
```

**Настройки.** Откройте файл в редакторе (`nano /etc/mxbt-autoscoring/env`) и перезапустите службы: `systemctl restart mxbt-mocks mxbt-bot`.

**Команды проекта на сервере** (проверка связи, webhook-подписки):
```bash
cd /opt/mxbt-autoscoring/app
runuser -u mxbt -- bash -c 'set -a; . /etc/mxbt-autoscoring/env; set +a; node --import tsx scripts/check-max.ts'
runuser -u mxbt -- bash -c 'set -a; . /etc/mxbt-autoscoring/env; set +a; node --import tsx scripts/webhooks.ts'
```

**Сертификат.** Проверить продление можно командой `certbot renew --dry-run`.

## Частые проблемы

| Симптом | Что проверить |
|---|---|
| certbot: `Timeout during connect` / `unauthorized` | A-запись домена не указывает на сервер, или порт 80 закрыт файрволом хостинга |
| `Нет связи с API MAX` | Исходящий доступ к `platform-api2.max.ru:443`, наличие папки `ca/` с сертификатами Минцифры |
| `токен отклонён (401)` | Токен в `/etc/mxbt-autoscoring/env` |
| `https://<домен>/health` → 502 | Бот не запущен: `journalctl -u mxbt-bot -n 50 --no-pager` |
| Бот молчит, health отвечает | `check-max` показывает, на какой адрес зарегистрирован webhook. Возможно, его перерегистрировал локальный бот с тем же токеном |
| nginx не стартует: `Address family not supported` | Нет IPv6. Скрипт убирает `listen [::]` сам, но строка может остаться в стандартном сайте: `rm /etc/nginx/sites-enabled/default` |

## Перед реальным запуском

- **Сервисы.** Заменить mock-сервисы реальными адаптерами (`src/services/ports.ts`), а в nginx убрать `location /pay/` и выключить службу `mxbt-mocks`.
- **Платежи.** Подключить CloudPayments: адаптер `PaymentProvider` и адрес уведомлений `https://<домен>/payments/webhook` в кабинете эквайера.
- **Хранилище.** Сделать постоянное хранилище сессий (Redis или Postgres), чтобы перезапуск не терял расчёты.
- **Юридическое.** Указать настоящую политику ПДн в `POLICY_URL`, финальные тексты и оферту.
- **Мониторинг.** Настроить внешний мониторинг `https://<домен>/health` и резервное копирование `/etc/mxbt-autoscoring/env`.
