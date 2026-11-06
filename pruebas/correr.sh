#!/usr/bin/env bash
# Corre las pruebas del backend contra un Postgres local (no toca Supabase).
#   PGHOST=/tmp PGPORT=5544 PGUSER=postgres ./pruebas/correr.sh
set -euo pipefail
cd "$(dirname "$0")/.."
DB=${DB:-remesa_pruebas}
P="psql -X -q -v ON_ERROR_STOP=1"
$P -d postgres -c "drop database if exists $DB" -c "create database $DB" >/dev/null
$P -d "$DB" -f pruebas/stub_supabase.sql >/dev/null
for f in supabase/migraciones/0*.sql; do $P -d "$DB" -f "$f" >/dev/null; done
$P -d "$DB" -f pruebas/pruebas.sql
