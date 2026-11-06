#!/usr/bin/env bash
# Prepara la base local "remesa_dev" con datos de demo y levanta PostgREST + el servidor dev.
#   POSTGREST_BIN=/ruta/postgrest ./pruebas/navegador/preparar.sh
# Luego: node pruebas/navegador/admin.e2e.mjs   (prueba la web de admin en un navegador)
set -euo pipefail
cd "$(dirname "$0")/../.."
export PGHOST=${PGHOST:-/tmp} PGPORT=${PGPORT:-5544} PGUSER=${PGUSER:-postgres}
DB=remesa_dev
P="psql -X -q -v ON_ERROR_STOP=1"
SECRETO='secreto-de-prueba-de-al-menos-32-caracteres!!'

[ -d pruebas/navegador/node_modules ] || npm i --prefix pruebas/navegador >/dev/null
pkill -x postgrest 2>/dev/null || true
pkill -f "node pruebas/navegador/servidor-dev" 2>/dev/null || true
$P -d postgres -c "drop database if exists $DB with (force)" -c "create database $DB" >/dev/null
$P -d "$DB" -f pruebas/stub_supabase.sql >/dev/null
for f in supabase/migraciones/0*.sql; do $P -d "$DB" -f "$f" >/dev/null; done
$P -d "$DB" >/dev/null <<'SQL'
do $$ begin
  if not exists (select 1 from pg_roles where rolname = 'authenticator') then
    create role authenticator login noinherit password 'dev';
  end if;
end $$;
grant anon, authenticated, service_role to authenticator;
SQL
$P -d "$DB" -f pruebas/navegador/datos_demo.sql >/dev/null
rm -rf /tmp/remesa-storage && mkdir -p /tmp/remesa-storage/recibos/1
cp pruebas/navegador/recibo-demo.jpg /tmp/remesa-storage/recibos/1/recibo-demo.jpg 2>/dev/null || true

cat > /tmp/postgrest.conf <<CONF
db-uri = "postgres://authenticator:dev@/$DB?host=$PGHOST&port=$PGPORT"
db-schemas = "public"
db-anon-role = "anon"
jwt-secret = "$SECRETO"
server-port = 3001
CONF
nohup "${POSTGREST_BIN:-postgrest}" /tmp/postgrest.conf > /tmp/postgrest.log 2>&1 &
nohup node pruebas/navegador/servidor-dev.mjs > /tmp/servidor-dev.log 2>&1 &
sleep 2
curl -fsS -X POST localhost:8080/rest/v1/rpc/config_publica -H 'content-type: application/json' -d '{}' >/dev/null \
  && echo "Listo: http://localhost:8080/admin/  (contraseña admin123)"
