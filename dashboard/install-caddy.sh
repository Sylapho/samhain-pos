#!/bin/sh
set -eu

target=/opt/les-cocottes-de-diane/proxy/Caddyfile
fragment=/opt/samhain-witches-dashboard/dashboard/Caddyfile
if grep -q 'REPLACE_WITH_WITCHES_DASHBOARD_HOST' "$fragment"; then
  echo 'Renseignez le domaine Witches dans le fragment Caddy avant installation.' >&2
  exit 1
fi
dashboard_host=$(sed -n 's/^[[:space:]]*\([^[:space:]{}]*\)[[:space:]]*{$/\1/p' "$fragment" | head -n 1)
if [ -z "$dashboard_host" ] || grep -Fq "$dashboard_host {" "$target"; then
  echo 'Le domaine figure déjà dans Caddyfile. Vérifiez son bloc avant toute modification.' >&2
  exit 1
fi
backup="${target}.before-samhain-witches-dashboard.$(date -u +%Y%m%dT%H%M%SZ)"
cp -p "$target" "$backup"
# Append in place: preserve the inode of the file bind-mounted into the existing proxy.
printf '\n' >> "$target"
cat "$fragment" >> "$target"
if ! docker exec lcdd-caddy caddy validate --config /etc/caddy/Caddyfile --adapter caddyfile; then
  cat "$backup" > "$target"
  echo "Validation refusée ; fichier d'origine restauré. Sauvegarde : $backup" >&2
  exit 1
fi
if ! docker exec lcdd-caddy caddy reload --config /etc/caddy/Caddyfile --adapter caddyfile; then
  cat "$backup" > "$target"
  docker exec lcdd-caddy caddy reload --config /etc/caddy/Caddyfile --adapter caddyfile || true
  echo "Rechargement refusé ; configuration d'origine restaurée. Sauvegarde : $backup" >&2
  exit 1
fi
echo "Bloc dashboard ajouté et Caddy rechargé. Sauvegarde : $backup"
