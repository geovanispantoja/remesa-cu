-- =====================================================================
-- Remesa.cu · 003 · Seguridad (RLS + permisos)
--
-- La clave "anon" de Supabase va dentro de la PWA y de la web de admin
-- (es pública por diseño). Lo que protege los datos son estas reglas:
--   · anon (sin sesión): solo cotizar, leer config pública, validar código de gestor
--   · cliente: su perfil, su libreta de familiares, sus remesas (sin comisiones)
--   · admin: todo, pero los cambios de estado solo por las funciones admin_*
-- =====================================================================

alter table configuracion        enable row level security;
alter table gestores             enable row level security;
alter table cuentas_zelle        enable row level security;
alter table perfiles             enable row level security;
alter table beneficiarios        enable row level security;
alter table remesas              enable row level security;
alter table remesa_eventos       enable row level security;
alter table plantillas_whatsapp  enable row level security;
alter table mensajes_whatsapp    enable row level security;

-- Tablas solo del admin -------------------------------------------------
create policy admin_todo on configuracion       for all to authenticated using (es_admin()) with check (es_admin());
create policy admin_todo on gestores            for all to authenticated using (es_admin()) with check (es_admin());
create policy admin_todo on cuentas_zelle       for all to authenticated using (es_admin()) with check (es_admin());
create policy admin_todo on plantillas_whatsapp for all to authenticated using (es_admin()) with check (es_admin());
create policy admin_leer on mensajes_whatsapp   for select to authenticated using (es_admin());
create policy admin_leer on remesa_eventos      for select to authenticated using (es_admin());

-- Remesas: el admin lee y edita sus notas; el cliente usa mis_remesas() --
create policy admin_leer   on remesas for select to authenticated using (es_admin());
create policy admin_editar on remesas for update to authenticated using (es_admin()) with check (es_admin());

-- Perfiles ----------------------------------------------------------------
create policy propio_leer on perfiles for select to authenticated
  using (id = auth.uid() or es_admin());
create policy propio_editar on perfiles for update to authenticated
  using (id = auth.uid() or es_admin()) with check (id = auth.uid() or es_admin());

-- Familiares (libreta del cliente) ---------------------------------------
create policy propio_leer on beneficiarios for select to authenticated
  using (cliente_id = auth.uid() or es_admin());
create policy propio_crear on beneficiarios for insert to authenticated
  with check (cliente_id = auth.uid() or es_admin());
create policy propio_editar on beneficiarios for update to authenticated
  using (cliente_id = auth.uid() or es_admin()) with check (cliente_id = auth.uid() or es_admin());
create policy propio_borrar on beneficiarios for delete to authenticated
  using (cliente_id = auth.uid() or es_admin());

-- Permisos de tabla --------------------------------------------------------
revoke all on all tables    in schema public from anon, authenticated;
revoke all on all sequences in schema public from anon, authenticated;

grant select, insert, update, delete on configuracion, gestores, cuentas_zelle,
                                        plantillas_whatsapp, beneficiarios to authenticated;
grant select on mensajes_whatsapp, remesa_eventos to authenticated;
grant select on remesas to authenticated;
grant update (notas_admin) on remesas to authenticated;
grant select on perfiles to authenticated;
grant update (nombre, whatsapp, pais, rol, gestor_id) on perfiles to authenticated;

-- Permisos de funciones ----------------------------------------------------
revoke execute on all functions in schema public from public, anon, authenticated;

-- Sin sesión (calculadora y registro)
grant execute on function cotizar(numeric), config_publica(), validar_codigo_gestor(text),
                          calcular_tarifa(numeric), validar_monto(numeric)
  to anon, authenticated;

-- Usadas por las políticas
grant execute on function es_admin(), puede_ver_recibo(text) to anon, authenticated;

-- Cliente
grant execute on function mis_remesas(bigint), mis_eventos(bigint),
                          crear_remesa(bigint, numeric, text, text),
                          reportar_pago(bigint, text),
                          cancelar_mi_remesa(bigint, text)
  to authenticated;

-- Admin (cada una verifica es_admin() por dentro)
grant execute on function
  admin_confirmar_zelle(bigint, numeric, boolean),
  admin_programar_entrega(bigint, date, franja_entrega),
  admin_marcar_entregada(bigint, text, text),
  admin_cancelar(bigint, text),
  admin_corregir_estado(bigint, estado_remesa, text),
  admin_ajustar_monto(bigint, numeric),
  admin_asignar_gestor(bigint, bigint),
  admin_asignar_cuenta_zelle(bigint, bigint),
  admin_pagar_comisiones(bigint, bigint[]),
  admin_crear_remesa_manual(text, text, text, text, numeric, text, text, text, text, bigint, uuid, text),
  admin_resumen(date, date),
  admin_resumen_gestores(date, date),
  admin_resumen_cuentas_zelle(date, date),
  admin_preparar_whatsapp(text, bigint, bigint, bigint, uuid),
  admin_registrar_whatsapp(destinatario_wa, text, text, bigint, text, uuid, bigint, bigint),
  normalizar_telefono(text), fmt_usd(numeric), hoy_cuba()
  to authenticated;

-- Que las funciones nuevas no queden abiertas a todo el mundo por defecto
alter default privileges in schema public revoke execute on functions from public, anon, authenticated;
