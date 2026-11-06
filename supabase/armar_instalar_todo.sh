#!/usr/bin/env bash
# Junta las migraciones en un solo archivo para pegar de una vez en el SQL Editor de Supabase.
set -euo pipefail
cd "$(dirname "$0")"
{
  echo "-- ====================================================================="
  echo "-- Remesa.cu · INSTALACIÓN COMPLETA (generado por armar_instalar_todo.sh)"
  echo "-- Pegar entero en Supabase → SQL Editor → Run. Solo una vez, en un proyecto nuevo."
  echo "-- ====================================================================="
  for f in migraciones/0*.sql; do
    echo
    echo "-- >>>>>>>>>>>>>>>>>>>> $f"
    cat "$f"
  done
} > instalar_todo.sql
echo "Listo: supabase/instalar_todo.sql"
