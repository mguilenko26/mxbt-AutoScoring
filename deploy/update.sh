#!/usr/bin/env bash
# Обновление mxbt-AutoScoring на сервере: свежий код из git, зависимости, перезапуск служб.
#   bash /opt/mxbt-autoscoring/app/deploy/update.sh            # последняя версия ветки
#   REF=b60627d bash /opt/mxbt-autoscoring/app/deploy/update.sh # конкретный коммит (откат)
set -euo pipefail

# Скрипт лежит в обновляемом репозитории — выполняем его копию, чтобы git checkout не изменил его на ходу.
if [[ ${MXBT_UPDATE_COPY:-0} != 1 ]]; then
  tmp=$(mktemp /tmp/mxbt-update.XXXXXX.sh)
  cp "$0" "$tmp"
  MXBT_UPDATE_COPY=1 exec bash "$tmp" "$@"
fi
trap 'rm -f "$0"' EXIT

APP_USER=mxbt
BASE_DIR=/opt/mxbt-autoscoring
APP_DIR=$BASE_DIR/app
ENV_FILE=/etc/mxbt-autoscoring/env
BRANCH=${BRANCH:-main}

log()  { printf '\n\033[1;34m==> %s\033[0m\n' "$*"; }
die()  { printf '\033[1;31mxx  %s\033[0m\n' "$*" >&2; exit 1; }
as_app() { runuser -u "$APP_USER" -- env HOME="$BASE_DIR" "$@"; }
no_ipv6_filter() { if [[ -s /proc/net/if_inet6 ]]; then cat; else sed '/listen \[::\]/d'; fi; }

[[ $EUID -eq 0 ]] || die "Запустите от root: sudo bash $0"
[[ -d $APP_DIR/.git ]] || die "Нет $APP_DIR — сначала deploy/install.sh"

cd "$APP_DIR"
before=$(as_app git rev-parse --short HEAD)
log "Получаю изменения ($BRANCH)"
as_app git fetch -q origin
if [[ -n $(as_app git status --porcelain --untracked-files=no) ]]; then
  die "В $APP_DIR есть локальные правки — код на сервере правится только через git. Посмотрите: git -C $APP_DIR status"
fi
as_app git checkout -q --detach "${REF:-origin/$BRANCH}"
after=$(as_app git rev-parse --short HEAD)

if [[ $before == "$after" ]]; then
  log "Уже актуально ($after)"
else
  log "$before → $after"
  as_app git --no-pager log --oneline "$before..$after" 2>/dev/null || true
fi

log "Зависимости"
as_app bash -c "cd '$APP_DIR' && npm ci --omit=dev --no-audit --no-fund --loglevel=error"

log "Проверка связи с API MAX"
as_app bash -c "set -a; . '$ENV_FILE'; set +a; node --import tsx scripts/check-max.ts" || die "Проверка не прошла — службы не перезапущены"

log "Службы systemd и nginx"
for unit in mxbt-mocks mxbt-bot; do
  sed "s|__APP_DIR__|$APP_DIR|g" "deploy/systemd/$unit.service" >"/etc/systemd/system/$unit.service"
done
systemctl daemon-reload
DOMAIN=$(sed -n 's|^MAX_WEBHOOK_DOMAIN=https://||p' "$ENV_FILE")
WEBHOOK_PATH=$(sed -n 's|^MAX_WEBHOOK_PATH=||p' "$ENV_FILE")
SITE=/etc/nginx/sites-available/mxbt-autoscoring.conf
sed -e "s|__DOMAIN__|$DOMAIN|g" -e "s|__WEBHOOK_PATH__|${WEBHOOK_PATH:-/max/webhook}|g" deploy/nginx/mxbt-autoscoring.conf | no_ipv6_filter >"$SITE.new"
if ! cmp -s "$SITE.new" "$SITE"; then
  cp "$SITE" "$SITE.bak"
  mv "$SITE.new" "$SITE"
  if nginx -t -q; then systemctl reload nginx; else mv "$SITE.bak" "$SITE"; die "Новая конфигурация nginx с ошибкой — оставлена прежняя"; fi
else
  rm -f "$SITE.new"
fi

systemctl restart mxbt-mocks
sleep 1
systemctl restart mxbt-bot

for _ in $(seq 1 20); do
  if curl -fsS --max-time 3 "https://$DOMAIN/health" >/dev/null 2>&1; then
    log "✅ Обновлено до $after, бот отвечает"
    exit 0
  fi
  sleep 1
done
die "Бот не отвечает после обновления. Логи: journalctl -u mxbt-bot -n 50 --no-pager. Откат: REF=$before bash $0"
