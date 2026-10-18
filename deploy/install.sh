#!/usr/bin/env bash
# Установка mxbt-AutoScoring на Debian 12 (bookworm): Node.js 24, nginx + Let's Encrypt, systemd.
# Повторный запуск безопасен: уже сделанные шаги пропускаются, секреты и сертификат не перезаписываются.
#
# Запуск (от root):
#   curl -fsSLO https://raw.githubusercontent.com/.../deploy/install.sh   # или скопировать файл на сервер
#   DOMAIN=bot.example.com EMAIL=admin@example.com bash install.sh
#
# Параметры (переменные окружения; если не заданы — спросит):
#   DOMAIN      домен бота, A-запись должна указывать на этот сервер (обязательно)
#   EMAIL       почта для Let's Encrypt (уведомления об истечении сертификата)
#   REPO        git-адрес репозитория (по умолчанию git@github.com:mguilenko26/mxbt-AutoScoring.git)
#   BRANCH      ветка (main)
#   MAX_BOT_TOKEN  токен бота; если не задан и env-файла ещё нет — спросит (ввод скрыт)
#   SKIP_CERT=1    не получать сертификат (например, если он уже есть в /etc/letsencrypt/live/$DOMAIN)
#   ENABLE_UFW=1   включить файрвол ufw: открыть SSH, 80 и 443
set -euo pipefail

APP_USER=mxbt
BASE_DIR=/opt/mxbt-autoscoring
APP_DIR=$BASE_DIR/app
ENV_DIR=/etc/mxbt-autoscoring
ENV_FILE=$ENV_DIR/env
REPO=${REPO:-git@github.com:mguilenko26/mxbt-AutoScoring.git}
BRANCH=${BRANCH:-main}
WEBHOOK_PATH=/max/webhook
NODE_MAJOR=24

log()  { printf '\n\033[1;34m==> %s\033[0m\n' "$*"; }
warn() { printf '\033[1;33m!!  %s\033[0m\n' "$*" >&2; }
die()  { printf '\033[1;31mxx  %s\033[0m\n' "$*" >&2; exit 1; }
as_app() { runuser -u "$APP_USER" -- env HOME="$BASE_DIR" "$@"; }
interactive() { [[ -t 0 ]]; }
# Без IPv6 nginx не стартует с «listen [::]:…» — такие строки убираем.
no_ipv6_filter() { if [[ -s /proc/net/if_inet6 ]]; then cat; else sed '/listen \[::\]/d'; fi; }

# --- 0. Проверки ---------------------------------------------------------------
[[ $EUID -eq 0 ]] || die "Запустите от root: sudo bash $0"
# shellcheck source=/dev/null
. /etc/os-release
[[ ${ID:-} == debian ]] || warn "Скрипт рассчитан на Debian, обнаружено: ${PRETTY_NAME:-неизвестно}"
[[ ${VERSION_ID:-} == 12 || ${VERSION_ID:-} == 13 ]] || warn "Проверено на Debian 12; у вас ${PRETTY_NAME:-?}"

if [[ -z ${DOMAIN:-} ]]; then
  interactive || die "Задайте DOMAIN=bot.example.com"
  read -rp "Домен бота (например, bot.example.com): " DOMAIN
fi
DOMAIN=${DOMAIN#https://}; DOMAIN=${DOMAIN%%/*}
[[ $DOMAIN =~ ^[A-Za-z0-9.-]+\.[A-Za-z]{2,}$ ]] || die "Некорректный домен: $DOMAIN"
if [[ -z ${EMAIL:-} && ${SKIP_CERT:-0} != 1 ]]; then
  interactive || die "Задайте EMAIL для Let's Encrypt"
  read -rp "E-mail для Let's Encrypt: " EMAIL
fi

# --- 1. Пакеты -------------------------------------------------------------------
log "Пакеты: git, nginx, certbot…"
export DEBIAN_FRONTEND=noninteractive
apt-get update -qq
apt-get install -y -qq ca-certificates curl gnupg git openssh-client openssl nginx certbot dnsutils >/dev/null

# --- 2. Node.js ------------------------------------------------------------------
# Службы запускают /usr/bin/node, поэтому проверяем именно его (node из nvm и т. п. не подойдёт).
node_ok() {
  [[ -x /usr/bin/node ]] || return 1
  /usr/bin/node -e 'const [a,b]=process.versions.node.split(".").map(Number); process.exit(a>22||(a===22&&b>=19)?0:1)'
}
if node_ok; then
  log "Node.js $(/usr/bin/node -v) уже установлен"
else
  log "Node.js $NODE_MAJOR (NodeSource)…"
  curl -fsSL "https://deb.nodesource.com/setup_${NODE_MAJOR}.x" -o /tmp/nodesource_setup.sh
  bash /tmp/nodesource_setup.sh >/dev/null
  apt-get install -y -qq nodejs >/dev/null
  node_ok || die "Не удалось установить Node.js ≥ 22.19"
  log "Node.js $(node -v), npm $(npm -v)"
fi

# --- 3. Пользователь -------------------------------------------------------------
if ! id "$APP_USER" >/dev/null 2>&1; then
  log "Системный пользователь $APP_USER"
  useradd --system --home-dir "$BASE_DIR" --create-home --shell /usr/sbin/nologin "$APP_USER"
fi
install -d -o "$APP_USER" -g "$APP_USER" -m 750 "$BASE_DIR"

# --- 4. Код ------------------------------------------------------------------------
if [[ ! -d $APP_DIR/.git ]]; then
  if [[ $REPO == git@* ]]; then
    KEY=$BASE_DIR/.ssh/id_ed25519
    install -d -o "$APP_USER" -g "$APP_USER" -m 700 "$BASE_DIR/.ssh"
    if [[ ! -f $KEY ]]; then
      as_app ssh-keygen -q -t ed25519 -N '' -C "mxbt-deploy@$(hostname)" -f "$KEY"
    fi
    ssh-keyscan -t ed25519 github.com 2>/dev/null | as_app tee -a "$BASE_DIR/.ssh/known_hosts" >/dev/null
    log "Ключ доступа к репозиторию (deploy key)"
    echo "Добавьте этот ключ в GitHub: репозиторий → Settings → Deploy keys → Add deploy key (без права записи):"
    echo
    cat "$KEY.pub"
    echo
    until as_app git ls-remote "$REPO" >/dev/null 2>&1; do
      interactive || die "Нет доступа к $REPO — добавьте deploy key и запустите скрипт снова"
      read -rp "Нажмите Enter, когда ключ добавлен (Ctrl+C — выход)… " _
    done
  fi
  log "Клонирую $REPO ($BRANCH)"
  as_app git clone -q --branch "$BRANCH" "$REPO" "$APP_DIR"
else
  log "Код уже на месте: $APP_DIR ($(as_app git -C "$APP_DIR" log --oneline -1))"
fi

log "Зависимости (npm ci --omit=dev)"
as_app bash -c "cd '$APP_DIR' && npm ci --omit=dev --no-audit --no-fund --loglevel=error"

# --- 5. Настройки и секреты ---------------------------------------------------------
install -d -o root -g "$APP_USER" -m 750 "$ENV_DIR"
if [[ ! -f $ENV_FILE ]]; then
  log "Файл настроек $ENV_FILE"
  if [[ -z ${MAX_BOT_TOKEN:-} ]]; then
    interactive || die "Задайте MAX_BOT_TOKEN"
    read -rsp "Токен бота MAX (ввод скрыт): " MAX_BOT_TOKEN; echo
  fi
  [[ -n $MAX_BOT_TOKEN ]] || die "Пустой токен"
  umask 027
  cat >"$ENV_FILE" <<EOF
# mxbt-AutoScoring — продакшен. Права 640 root:$APP_USER. После правок: systemctl restart mxbt-bot mxbt-mocks
NODE_ENV=production

# --- MAX ---
MAX_BOT_TOKEN=$MAX_BOT_TOKEN
MAX_MODE=webhook
MAX_WEBHOOK_DOMAIN=https://$DOMAIN
MAX_WEBHOOK_PATH=$WEBHOOK_PATH
MAX_WEBHOOK_SECRET=$(openssl rand -hex 32)

# --- Бот ---
BOT_HTTP_HOST=127.0.0.1
BOT_HTTP_PORT=3000
# TODO: ссылка на настоящую политику обработки персональных данных
POLICY_URL=https://example.com/privacy
PROGRESS_INTERVAL_MS=2000
PRICING_POLL_MS=2000
SCORING_TIMEOUT_MS=600000
# Кнопки «🧪 Оплата успешна / Отказ банка» — в продакшене выключены
PAYMENT_SHORTCUTS=0

# --- Внешние сервисы: пока mock-сервер на этом же сервере ---
MOCKS_HOST=127.0.0.1
MOCKS_PORT=4000
MOCKS_BASE_URL=http://127.0.0.1:4000
MOCKS_PUBLIC_URL=https://$DOMAIN
PAYMENT_WEBHOOK_URL=http://127.0.0.1:3000/payments/webhook
PAYMENT_WEBHOOK_SECRET=$(openssl rand -hex 32)
MOCK_LOG=1
EOF
  chown root:"$APP_USER" "$ENV_FILE"
  chmod 640 "$ENV_FILE"
  unset MAX_BOT_TOKEN
else
  log "Файл настроек уже есть: $ENV_FILE (не изменяю)"
fi

# --- 6. Проверка связи с MAX --------------------------------------------------------
log "Проверка связи с API MAX"
as_app bash -c "set -a; . '$ENV_FILE'; set +a; cd '$APP_DIR' && node --import tsx scripts/check-max.ts" \
  || die "Нет связи с API MAX или неверный токен — см. сообщение выше"

# --- 7. nginx и сертификат -----------------------------------------------------------
SITE=/etc/nginx/sites-available/mxbt-autoscoring.conf
install -d -m 755 /var/www/certbot
CERT=/etc/letsencrypt/live/$DOMAIN/fullchain.pem

if [[ ! -f $CERT ]]; then
  [[ ${SKIP_CERT:-0} == 1 ]] && die "SKIP_CERT=1, но сертификата $CERT нет"
  SERVER_IP=$(curl -fsS4 --max-time 5 https://ifconfig.me 2>/dev/null || true)
  DNS_IP=$(dig +short A "$DOMAIN" | tail -n1)
  if [[ -n $SERVER_IP && $DNS_IP != "$SERVER_IP" ]]; then
    warn "A-запись $DOMAIN → ${DNS_IP:-нет}, а IP сервера $SERVER_IP. Let's Encrypt не выдаст сертификат, пока DNS не указывает сюда."
  fi
  log "Временная HTTP-конфигурация nginx для проверки Let's Encrypt"
  no_ipv6_filter >"$SITE" <<EOF
server {
    listen 80;
    listen [::]:80;
    server_name $DOMAIN;
    location ^~ /.well-known/acme-challenge/ { root /var/www/certbot; default_type text/plain; }
    location / { return 404; }
}
EOF
  ln -sf "$SITE" /etc/nginx/sites-enabled/mxbt-autoscoring.conf
  nginx -t -q && systemctl reload-or-restart nginx
  log "Сертификат Let's Encrypt для $DOMAIN"
  certbot certonly --webroot -w /var/www/certbot -d "$DOMAIN" -m "$EMAIL" --agree-tos -n --no-eff-email
fi

log "Конфигурация nginx"
sed -e "s|__DOMAIN__|$DOMAIN|g" -e "s|__WEBHOOK_PATH__|$WEBHOOK_PATH|g" \
  "$APP_DIR/deploy/nginx/mxbt-autoscoring.conf" | no_ipv6_filter >"$SITE"
ln -sf "$SITE" /etc/nginx/sites-enabled/mxbt-autoscoring.conf
nginx -t -q
systemctl enable -q nginx
systemctl reload-or-restart nginx

# После продления сертификата — перечитать его в nginx
install -d /etc/letsencrypt/renewal-hooks/deploy
cat >/etc/letsencrypt/renewal-hooks/deploy/reload-nginx.sh <<'EOF'
#!/bin/sh
systemctl reload nginx
EOF
chmod 755 /etc/letsencrypt/renewal-hooks/deploy/reload-nginx.sh

# --- 8. Службы systemd -------------------------------------------------------------
log "Службы systemd: mxbt-mocks, mxbt-bot"
for unit in mxbt-mocks mxbt-bot; do
  sed "s|__APP_DIR__|$APP_DIR|g" "$APP_DIR/deploy/systemd/$unit.service" >"/etc/systemd/system/$unit.service"
done
systemctl daemon-reload
systemctl enable -q mxbt-mocks mxbt-bot
systemctl restart mxbt-mocks
sleep 1
systemctl restart mxbt-bot

# --- 9. Файрвол (по желанию) -----------------------------------------------------------
if [[ ${ENABLE_UFW:-0} == 1 ]]; then
  log "Файрвол ufw"
  apt-get install -y -qq ufw >/dev/null
  SSH_PORT=$(sshd -T 2>/dev/null | awk '/^port /{print $2; exit}')
  ufw allow "${SSH_PORT:-22}/tcp" >/dev/null
  ufw allow 80/tcp >/dev/null
  ufw allow 443/tcp >/dev/null
  ufw --force enable >/dev/null
  ufw status
fi

# --- 10. Проверка ------------------------------------------------------------------------
log "Проверка"
ok=0
for _ in $(seq 1 20); do
  if curl -fsS --max-time 3 "https://$DOMAIN/health" >/dev/null 2>&1; then ok=1; break; fi
  sleep 1
done
systemctl --no-pager --lines=0 status mxbt-mocks mxbt-bot || true
if [[ $ok == 1 ]]; then
  echo
  echo "✅ Готово: https://$DOMAIN/health отвечает."
  echo "   Логи бота:  journalctl -u mxbt-bot -f"
  echo "   Обновление: bash $APP_DIR/deploy/update.sh"
else
  warn "https://$DOMAIN/health не отвечает. Смотрите: journalctl -u mxbt-bot -n 50 --no-pager"
  exit 1
fi
