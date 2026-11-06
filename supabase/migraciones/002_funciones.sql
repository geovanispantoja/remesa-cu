-- =====================================================================
-- Remesa.cu · 002 · Lógica del negocio (funciones y triggers)
--
-- Regla de oro: la PWA y la web de admin NUNCA escriben directo en la
-- tabla remesas. Todo cambio pasa por estas funciones, que validan el
-- estado, calculan la plata y dejan el historial.
-- =====================================================================

-- ---------------------------------------------------------------------
-- Utilidades
-- ---------------------------------------------------------------------
create or replace function cfg_texto(p_clave text, p_defecto text default null)
returns text language sql stable security definer set search_path = public as $$
  select coalesce((select nullif(trim(valor), '') from configuracion where clave = p_clave), p_defecto)
$$;

create or replace function cfg_num(p_clave text, p_defecto numeric)
returns numeric language plpgsql stable security definer set search_path = public as $$
declare v text;
begin
  select valor into v from configuracion where clave = p_clave;
  if v is null or trim(v) = '' then return p_defecto; end if;
  return trim(v)::numeric;
exception when others then
  return p_defecto;
end $$;

create or replace function es_admin()
returns boolean language sql stable security definer set search_path = public as $$
  select exists (select 1 from perfiles where id = auth.uid() and rol = 'admin')
$$;

create or replace function hoy_cuba()
returns date language sql stable set search_path = public as $$
  select (now() at time zone 'America/Havana')::date
$$;

-- Deja solo dígitos con código de país, listo para wa.me/<numero>.
--   "+1 (305) 555-1234" → 13055551234     "5 555 1234" (móvil cubano) → 5355551234
-- Si empieza con + o 00 se respeta tal cual. Si no: 8 dígitos que empiezan en 5
-- = móvil cubano; 10 dígitos que empiezan en 535 = móvil cubano ya con su 53;
-- otros 10 dígitos = EE.UU. Para otros países hay que escribir el + y el código.
create or replace function normalizar_telefono(p text)
returns text language plpgsql immutable set search_path = public as $$
declare d text; v_internacional boolean;
begin
  if p is null then return null; end if;
  v_internacional := trim(p) like '+%' or trim(p) like '00%';
  d := regexp_replace(p, '\D', '', 'g');
  if left(d, 2) = '00' then d := substr(d, 3); end if;
  if not v_internacional then
    if length(d) = 8 and left(d, 1) = '5' then
      d := '53' || d;
    elsif length(d) = 10 and left(d, 3) <> '535' then
      d := '1' || d;
    end if;
  end if;
  if length(d) < 8 or length(d) > 15 then return null; end if;
  return d;
end $$;

create or replace function fmt_usd(n numeric)
returns text language sql immutable set search_path = public as $$
  select case
    when n is null then ''
    when n = trunc(n) then trunc(n)::text
    else to_char(n, 'FM999999990.00')
  end
$$;

create or replace function fmt_fecha(d date)
returns text language sql immutable set search_path = public as $$
  select case when d is null then 'fecha por confirmar' else
    (array['domingo','lunes','martes','miércoles','jueves','viernes','sábado'])[extract(dow from d)::int + 1]
    || ' ' || extract(day from d)::int || ' de ' ||
    (array['enero','febrero','marzo','abril','mayo','junio','julio','agosto',
           'septiembre','octubre','noviembre','diciembre'])[extract(month from d)::int]
  end
$$;

create or replace function fmt_franja(f franja_entrega)
returns text language sql immutable set search_path = public as $$
  select case f
    when 'manana' then 'en la mañana'
    when 'tarde' then 'en la tarde'
    when 'todo_el_dia' then 'durante el día'
    else ''
  end
$$;

create or replace function _nuevo_codigo()
returns text language plpgsql set search_path = public as $$
declare n bigint := nextval('remesa_numero_seq');
begin
  return 'REM-' || case when n < 10000 then lpad(n::text, 4, '0') else n::text end;
end $$;

alter table remesas alter column codigo set default _nuevo_codigo();

create or replace function tg_actualizado()
returns trigger language plpgsql set search_path = public as $$
begin
  new.actualizado_at := now();
  return new;
end $$;

create trigger remesas_actualizado before update on remesas
  for each row execute function tg_actualizado();

-- ---------------------------------------------------------------------
-- Dinero: tarifa, validación del monto, cotización
--   tarifa = max(tarifa_minima, techo(monto / tarifa_bloque) × tarifa_por_bloque)
--   Con los valores de fábrica (100, 10, 10): 350 → 40, 300 → 30, 320 → 40
-- ---------------------------------------------------------------------
create or replace function calcular_tarifa(p_monto numeric)
returns numeric language plpgsql stable security definer set search_path = public as $$
declare
  v_bloque     numeric := cfg_num('tarifa_bloque', 100);
  v_por_bloque numeric := cfg_num('tarifa_por_bloque', 10);
  v_minima     numeric := cfg_num('tarifa_minima', 10);
begin
  if p_monto is null or p_monto <= 0 then return 0; end if;
  if v_bloque <= 0 then v_bloque := 100; end if;
  return greatest(v_minima, ceil(p_monto / v_bloque) * v_por_bloque);
end $$;

-- Devuelve el mensaje de error, o null si el monto es válido.
create or replace function validar_monto(p_monto numeric)
returns text language plpgsql stable security definer set search_path = public as $$
declare
  v_min  numeric := cfg_num('monto_minimo', 50);
  v_max  numeric := cfg_num('monto_maximo', 3000);
  v_mult numeric := cfg_num('monto_multiplo', 10);
begin
  if p_monto is null or p_monto <= 0 then return 'Escribe cuánto quieres que reciba tu familia'; end if;
  if p_monto <> trunc(p_monto) then return 'El monto debe ser en dólares enteros'; end if;
  if p_monto < v_min then return 'El monto mínimo es $' || fmt_usd(v_min); end if;
  if p_monto > v_max then return 'El monto máximo por remesa es $' || fmt_usd(v_max); end if;
  if v_mult > 0 and mod(p_monto, v_mult) <> 0 then
    return 'El monto debe ser múltiplo de $' || fmt_usd(v_mult);
  end if;
  return null;
end $$;

-- Para la calculadora de la PWA (funciona sin iniciar sesión).
create or replace function cotizar(p_monto numeric)
returns jsonb language plpgsql stable security definer set search_path = public as $$
declare v_err text := validar_monto(p_monto); v_tarifa numeric;
begin
  if v_err is not null then
    return jsonb_build_object('ok', false, 'error', v_err, 'monto', p_monto);
  end if;
  v_tarifa := calcular_tarifa(p_monto);
  return jsonb_build_object('ok', true, 'monto', p_monto, 'tarifa', v_tarifa, 'total', p_monto + v_tarifa);
end $$;

-- Parámetros que la PWA puede leer (los marcados publica = true).
create or replace function config_publica()
returns jsonb language sql stable security definer set search_path = public as $$
  select coalesce(jsonb_object_agg(clave, valor), '{}'::jsonb) from configuracion where publica
$$;

-- ---------------------------------------------------------------------
-- Gestores y cuentas Zelle (internas)
-- ---------------------------------------------------------------------
create or replace function _gestor_por_codigo(p_codigo text)
returns gestores language plpgsql stable security definer set search_path = public as $$
declare g gestores;
begin
  select * into g from gestores where codigo = upper(trim(p_codigo)) and activo;
  return g;
end $$;

-- Para que la PWA valide el código antes de registrarse.
create or replace function validar_codigo_gestor(p_codigo text)
returns jsonb language plpgsql stable security definer set search_path = public as $$
declare g gestores := _gestor_por_codigo(p_codigo);
begin
  if g.id is null then return jsonb_build_object('valido', false); end if;
  return jsonb_build_object('valido', true, 'codigo', g.codigo, 'nombre', split_part(g.nombre, ' ', 1));
end $$;

-- Reparte por turnos: la cuenta activa a la que hace más tiempo no se le asignó nada.
create or replace function _asignar_cuenta_zelle()
returns cuentas_zelle language plpgsql security definer set search_path = public as $$
declare c cuentas_zelle;
begin
  select * into c from cuentas_zelle where activa
    order by ultima_asignacion_at nulls first, id
    limit 1 for update;
  if found then
    update cuentas_zelle set ultima_asignacion_at = clock_timestamp() where id = c.id;
  end if;
  return c;
end $$;

create or replace function _evento(p_remesa_id bigint, p_tipo text, p_detalle jsonb default '{}'::jsonb,
                                   p_visible_cliente boolean default true)
returns void language sql security definer set search_path = public as $$
  insert into remesa_eventos (remesa_id, tipo, detalle, actor, visible_cliente)
  values (p_remesa_id, p_tipo, coalesce(p_detalle, '{}'::jsonb), auth.uid(), p_visible_cliente)
$$;

create or replace function _exigir_admin()
returns void language plpgsql stable security definer set search_path = public as $$
begin
  if not es_admin() then
    raise exception 'Solo el administrador puede hacer esto' using errcode = '42501';
  end if;
end $$;

create or replace function _bloquear_remesa(p_id bigint)
returns remesas language plpgsql security definer set search_path = public as $$
declare r remesas;
begin
  select * into r from remesas where id = p_id for update;
  if not found then raise exception 'La remesa % no existe', p_id; end if;
  return r;
end $$;

create or replace function _texto_estado(e estado_remesa)
returns text language sql immutable set search_path = public as $$
  select case e
    when 'esperando_zelle' then 'esperando el Zelle'
    when 'zelle_confirmado' then 'Zelle confirmado'
    when 'entrega_programada' then 'entrega programada'
    when 'entregada' then 'entregada'
    when 'cancelada' then 'cancelada'
  end
$$;

-- Comisión de D según la tarifa y si el gestor está activo.
create or replace function _comision(p_tarifa numeric, p_gestor_id bigint, out gestor_id bigint, out pct numeric, out monto numeric)
language plpgsql stable security definer set search_path = public as $$
begin
  if p_gestor_id is not null and exists (select 1 from gestores g where g.id = p_gestor_id and g.activo) then
    gestor_id := p_gestor_id;
    pct := cfg_num('comision_gestor_pct', 50);
    monto := round(p_tarifa * pct / 100, 2);
  else
    gestor_id := null; pct := 0; monto := 0;
  end if;
end $$;

-- Crea la remesa con todo copiado. La usan el cliente y el admin.
create or replace function _nueva_remesa(
  p_cliente_id uuid, p_cliente_nombre text, p_cliente_whatsapp text,
  p_beneficiario_id bigint, p_benef_nombre text, p_benef_telefono text, p_benef_direccion text,
  p_benef_municipio text, p_benef_provincia text,
  p_monto numeric, p_gestor_id bigint, p_cuenta_zelle_id bigint, p_nota text, p_origen text)
returns remesas language plpgsql security definer set search_path = public as $$
declare
  v_tarifa numeric := calcular_tarifa(p_monto);
  v_com    record;
  v_cuenta cuentas_zelle;
  r        remesas;
begin
  select * into v_com from _comision(v_tarifa, p_gestor_id);

  if p_cuenta_zelle_id is not null then
    select * into v_cuenta from cuentas_zelle where id = p_cuenta_zelle_id;
    if not found then raise exception 'La cuenta Zelle % no existe', p_cuenta_zelle_id; end if;
    update cuentas_zelle set ultima_asignacion_at = clock_timestamp() where id = p_cuenta_zelle_id;
  else
    v_cuenta := _asignar_cuenta_zelle();
  end if;

  insert into remesas (
    cliente_id, cliente_nombre, cliente_whatsapp,
    beneficiario_id, beneficiario_nombre, beneficiario_telefono, beneficiario_direccion,
    beneficiario_municipio, beneficiario_provincia,
    monto_entrega, tarifa, gestor_id, comision_pct, comision_gestor,
    cuenta_zelle_id, zelle_titular, zelle_contacto, nota_cliente)
  values (
    p_cliente_id, trim(p_cliente_nombre), normalizar_telefono(p_cliente_whatsapp),
    p_beneficiario_id, trim(p_benef_nombre), p_benef_telefono, trim(p_benef_direccion),
    p_benef_municipio, p_benef_provincia,
    p_monto, v_tarifa, v_com.gestor_id, v_com.pct, v_com.monto,
    v_cuenta.id, v_cuenta.titular, v_cuenta.contacto_zelle, nullif(trim(p_nota), ''))
  returning * into r;

  perform _evento(r.id, 'creada', jsonb_build_object(
    'monto', r.monto_entrega, 'tarifa', r.tarifa, 'total', r.total_zelle, 'origen', p_origen));
  if v_com.gestor_id is not null then
    perform _evento(r.id, 'comision_calculada',
      jsonb_build_object('gestor_id', v_com.gestor_id, 'pct', v_com.pct, 'comision', v_com.monto), false);
  end if;
  return r;
end $$;

-- ---------------------------------------------------------------------
-- Perfiles: se crean solos al registrarse; el cliente no puede
-- cambiarse el rol ni el gestor.
-- ---------------------------------------------------------------------
create or replace function tg_nuevo_usuario()
returns trigger language plpgsql security definer set search_path = public as $$
declare
  m jsonb := coalesce(new.raw_user_meta_data, '{}'::jsonb);
  g gestores;
begin
  if nullif(trim(m->>'codigo_gestor'), '') is not null then
    g := _gestor_por_codigo(m->>'codigo_gestor');
  end if;
  insert into perfiles (id, nombre, whatsapp, pais, correo, gestor_id)
  values (new.id, coalesce(trim(m->>'nombre'), ''), normalizar_telefono(m->>'whatsapp'),
          nullif(trim(m->>'pais'), ''), new.email, g.id)
  on conflict (id) do nothing;
  return new;
end $$;

create trigger on_auth_user_created after insert on auth.users
  for each row execute function tg_nuevo_usuario();

-- OJO: sin "security definer" a propósito, para que current_user sea el real.
create or replace function tg_proteger_perfil()
returns trigger language plpgsql set search_path = public as $$
begin
  -- current_user es 'authenticated' cuando el cambio viene directo de la app;
  -- dentro de las funciones del sistema es el dueño, y ahí sí se permite.
  if current_user in ('authenticated', 'anon') and not es_admin() then
    if new.rol is distinct from old.rol or new.gestor_id is distinct from old.gestor_id
       or new.id is distinct from old.id then
      raise exception 'No puedes cambiar ese dato de tu perfil' using errcode = '42501';
    end if;
  end if;
  if new.whatsapp is distinct from old.whatsapp then
    new.whatsapp := normalizar_telefono(new.whatsapp);
  end if;
  return new;
end $$;

create trigger perfiles_proteger before update on perfiles
  for each row execute function tg_proteger_perfil();

-- ---------------------------------------------------------------------
-- Lo que ve el cliente de sus remesas (sin comisiones ni notas internas)
-- ---------------------------------------------------------------------
create type remesa_cliente as (
  id bigint, codigo text,
  beneficiario_id bigint, beneficiario_nombre text, beneficiario_telefono text,
  beneficiario_direccion text, beneficiario_municipio text, beneficiario_provincia text,
  monto_entrega numeric, tarifa numeric, total_zelle numeric,
  zelle_titular text, zelle_contacto text,
  estado estado_remesa, cliente_reporto_pago_at timestamptz, comprobante_pago_path text,
  zelle_confirmado_at timestamptz, fecha_entrega date, franja franja_entrega,
  entregada_at timestamptz, recibo_path text,
  cancelada_at timestamptz, motivo_cancelacion text,
  nota_cliente text, creado_at timestamptz, actualizado_at timestamptz
);

create or replace function _a_cliente(r remesas)
returns remesa_cliente language sql immutable set search_path = public as $$
  select row(
    r.id, r.codigo,
    r.beneficiario_id, r.beneficiario_nombre, r.beneficiario_telefono,
    r.beneficiario_direccion, r.beneficiario_municipio, r.beneficiario_provincia,
    r.monto_entrega, r.tarifa, r.total_zelle,
    r.zelle_titular, r.zelle_contacto,
    r.estado, r.cliente_reporto_pago_at, r.comprobante_pago_path,
    r.zelle_confirmado_at, r.fecha_entrega, r.franja,
    r.entregada_at, r.recibo_path,
    r.cancelada_at, r.motivo_cancelacion,
    r.nota_cliente, r.creado_at, r.actualizado_at
  )::remesa_cliente
$$;

create or replace function mis_remesas(p_id bigint default null)
returns setof remesa_cliente language sql stable security definer set search_path = public as $$
  select (_a_cliente(r)).* from remesas r
  where r.cliente_id = auth.uid() and (p_id is null or r.id = p_id)
  order by r.creado_at desc
$$;

create or replace function mis_eventos(p_remesa_id bigint)
returns table (id bigint, tipo text, detalle jsonb, creado_at timestamptz)
language sql stable security definer set search_path = public as $$
  select e.id, e.tipo, e.detalle, e.creado_at
  from remesa_eventos e join remesas r on r.id = e.remesa_id
  where e.remesa_id = p_remesa_id and r.cliente_id = auth.uid() and e.visible_cliente
  order by e.creado_at, e.id
$$;

-- ---------------------------------------------------------------------
-- Acciones del CLIENTE (A)
-- ---------------------------------------------------------------------
create or replace function crear_remesa(p_beneficiario_id bigint, p_monto numeric,
                                        p_codigo_gestor text default null, p_nota text default null)
returns remesa_cliente language plpgsql security definer set search_path = public as $$
declare
  v_uid      uuid := auth.uid();
  v_perfil   perfiles;
  v_benef    beneficiarios;
  v_gestor   gestores;
  v_err      text;
  v_abiertas int;
  r          remesas;
begin
  if v_uid is null then raise exception 'Inicia sesión para enviar una remesa' using errcode = '42501'; end if;

  select * into v_perfil from perfiles where id = v_uid for update;
  if not found then raise exception 'No encontramos tu perfil'; end if;
  if trim(v_perfil.nombre) = '' then raise exception 'Agrega tu nombre en tu perfil antes de enviar'; end if;
  if normalizar_telefono(v_perfil.whatsapp) is null then
    raise exception 'Agrega tu número de WhatsApp en tu perfil antes de enviar';
  end if;

  select * into v_benef from beneficiarios where id = p_beneficiario_id and cliente_id = v_uid and activo;
  if not found then raise exception 'Elige a quién le llega el dinero'; end if;

  v_err := validar_monto(p_monto);
  if v_err is not null then raise exception '%', v_err; end if;

  select count(*) into v_abiertas from remesas
    where cliente_id = v_uid and estado = 'esperando_zelle';
  if v_abiertas >= cfg_num('max_remesas_esperando', 3) then
    raise exception 'Tienes % remesas esperando el Zelle. Deposita o cancela alguna antes de crear otra.', v_abiertas;
  end if;

  -- El primer código de gestor que pone el cliente queda fijo en su perfil.
  if v_perfil.gestor_id is null and nullif(trim(p_codigo_gestor), '') is not null then
    v_gestor := _gestor_por_codigo(p_codigo_gestor);
    if v_gestor.id is null then
      raise exception 'El código de gestor "%" no existe', upper(trim(p_codigo_gestor));
    end if;
    update perfiles set gestor_id = v_gestor.id where id = v_uid;
    v_perfil.gestor_id := v_gestor.id;
  end if;

  r := _nueva_remesa(v_uid, v_perfil.nombre, v_perfil.whatsapp,
                     v_benef.id, v_benef.nombre, v_benef.telefono, v_benef.direccion,
                     v_benef.municipio, v_benef.provincia,
                     p_monto, v_perfil.gestor_id, null, p_nota, 'cliente');
  return _a_cliente(r);
end $$;

-- "Ya deposité": avisa al admin y guarda la captura (opcional).
-- La captura se sube antes al bucket 'comprobantes' en la carpeta <uid>/
create or replace function reportar_pago(p_remesa_id bigint, p_comprobante_path text default null)
returns remesa_cliente language plpgsql security definer set search_path = public as $$
declare r remesas;
begin
  select * into r from remesas where id = p_remesa_id and cliente_id = auth.uid() for update;
  if not found then raise exception 'Remesa no encontrada'; end if;
  if r.estado <> 'esperando_zelle' then
    raise exception 'Esta remesa ya está %', _texto_estado(r.estado);
  end if;
  if p_comprobante_path is not null and p_comprobante_path not like auth.uid()::text || '/%' then
    raise exception 'Comprobante inválido';
  end if;
  update remesas set cliente_reporto_pago_at = now(),
                     comprobante_pago_path = coalesce(p_comprobante_path, comprobante_pago_path)
   where id = r.id returning * into r;
  perform _evento(r.id, 'pago_reportado', jsonb_build_object('con_captura', p_comprobante_path is not null));
  return _a_cliente(r);
end $$;

create or replace function cancelar_mi_remesa(p_remesa_id bigint, p_motivo text default null)
returns remesa_cliente language plpgsql security definer set search_path = public as $$
declare r remesas;
begin
  select * into r from remesas where id = p_remesa_id and cliente_id = auth.uid() for update;
  if not found then raise exception 'Remesa no encontrada'; end if;
  if r.estado <> 'esperando_zelle' then
    raise exception 'Esta remesa ya está %; escríbenos por WhatsApp para cualquier cambio', _texto_estado(r.estado);
  end if;
  if r.cliente_reporto_pago_at is not null then
    raise exception 'Ya nos avisaste que depositaste. Escríbenos por WhatsApp para cancelarla.';
  end if;
  update remesas set estado = 'cancelada', cancelada_at = now(),
                     motivo_cancelacion = coalesce(nullif(trim(p_motivo), ''), 'Cancelada por el cliente')
   where id = r.id returning * into r;
  perform _evento(r.id, 'cancelada', jsonb_build_object('por', 'cliente', 'motivo', r.motivo_cancelacion));
  return _a_cliente(r);
end $$;

-- ---------------------------------------------------------------------
-- Acciones del ADMIN (B)
-- ---------------------------------------------------------------------

-- C avisó que el dinero llegó.
create or replace function admin_confirmar_zelle(p_remesa_id bigint, p_monto_recibido numeric default null,
                                                 p_forzar boolean default false)
returns remesas language plpgsql security definer set search_path = public as $$
declare r remesas; v_rec numeric;
begin
  perform _exigir_admin();
  r := _bloquear_remesa(p_remesa_id);
  if r.estado <> 'esperando_zelle' then
    raise exception 'La remesa % está %; no se puede confirmar el Zelle', r.codigo, _texto_estado(r.estado);
  end if;
  v_rec := coalesce(p_monto_recibido, r.total_zelle);
  if v_rec <= 0 then raise exception 'Monto recibido inválido'; end if;
  if v_rec < r.total_zelle and not p_forzar then
    raise exception 'Llegaron $% pero el total es $%. Ajusta el monto de la remesa o confirma forzando.',
      fmt_usd(v_rec), fmt_usd(r.total_zelle);
  end if;
  update remesas set estado = 'zelle_confirmado', zelle_monto_recibido = v_rec, zelle_confirmado_at = now()
   where id = r.id returning * into r;
  perform _evento(r.id, 'zelle_confirmado', jsonb_build_object('recibido', v_rec));
  if v_rec <> r.total_zelle then
    perform _evento(r.id, 'diferencia_zelle',
      jsonb_build_object('recibido', v_rec, 'esperado', r.total_zelle, 'diferencia', v_rec - r.total_zelle), false);
  end if;
  return r;
end $$;

create or replace function admin_programar_entrega(p_remesa_id bigint, p_fecha date,
                                                   p_franja franja_entrega default 'todo_el_dia')
returns remesas language plpgsql security definer set search_path = public as $$
declare r remesas; v_tipo text;
begin
  perform _exigir_admin();
  r := _bloquear_remesa(p_remesa_id);
  if r.estado not in ('zelle_confirmado', 'entrega_programada') then
    raise exception 'La remesa % está %; primero hay que confirmar el Zelle', r.codigo, _texto_estado(r.estado);
  end if;
  if p_fecha is null or p_fecha < hoy_cuba() then
    raise exception 'La fecha de entrega no puede ser en el pasado';
  end if;
  v_tipo := case when r.estado = 'entrega_programada' then 'entrega_reprogramada' else 'entrega_programada' end;
  update remesas set estado = 'entrega_programada', fecha_entrega = p_fecha,
                     franja = coalesce(p_franja, 'todo_el_dia')
   where id = r.id returning * into r;
  perform _evento(r.id, v_tipo, jsonb_build_object('fecha', r.fecha_entrega, 'franja', r.franja));
  return r;
end $$;

-- El recibo firmado se sube antes al bucket 'recibos' en la carpeta <id de la remesa>/
create or replace function admin_marcar_entregada(p_remesa_id bigint, p_recibo_path text default null,
                                                  p_nota text default null)
returns remesas language plpgsql security definer set search_path = public as $$
declare r remesas;
begin
  perform _exigir_admin();
  r := _bloquear_remesa(p_remesa_id);
  if r.estado not in ('zelle_confirmado', 'entrega_programada') then
    raise exception 'La remesa % está %; no se puede marcar entregada', r.codigo, _texto_estado(r.estado);
  end if;
  if p_recibo_path is null and cfg_texto('exigir_recibo', 'si') = 'si' then
    raise exception 'Sube la foto del recibo firmado antes de marcarla entregada';
  end if;
  if p_recibo_path is not null and p_recibo_path not like r.id::text || '/%' then
    raise exception 'El recibo debe estar en la carpeta %/ del bucket recibos', r.id;
  end if;
  update remesas set estado = 'entregada', entregada_at = now(),
                     fecha_entrega = coalesce(fecha_entrega, hoy_cuba()),
                     recibo_path = p_recibo_path, nota_entrega = nullif(trim(p_nota), '')
   where id = r.id returning * into r;
  perform _evento(r.id, 'entregada', jsonb_build_object('con_recibo', p_recibo_path is not null));
  return r;
end $$;

create or replace function admin_cancelar(p_remesa_id bigint, p_motivo text)
returns remesas language plpgsql security definer set search_path = public as $$
declare r remesas; v_devolver boolean;
begin
  perform _exigir_admin();
  if nullif(trim(p_motivo), '') is null then raise exception 'Escribe el motivo de la cancelación'; end if;
  r := _bloquear_remesa(p_remesa_id);
  if r.estado in ('entregada', 'cancelada') then
    raise exception 'La remesa % ya está %', r.codigo, _texto_estado(r.estado);
  end if;
  v_devolver := r.estado <> 'esperando_zelle';
  update remesas set estado = 'cancelada', cancelada_at = now(), motivo_cancelacion = trim(p_motivo)
   where id = r.id returning * into r;
  perform _evento(r.id, 'cancelada', jsonb_build_object('por', 'admin', 'motivo', r.motivo_cancelacion));
  if v_devolver then
    perform _evento(r.id, 'devolver_zelle',
      jsonb_build_object('monto', r.zelle_monto_recibido, 'cuenta_zelle_id', r.cuenta_zelle_id), false);
  end if;
  return r;
end $$;

-- Para errores: mueve la remesa a un estado anterior (o a entregada) dejando constancia.
create or replace function admin_corregir_estado(p_remesa_id bigint, p_estado estado_remesa, p_motivo text)
returns remesas language plpgsql security definer set search_path = public as $$
declare r remesas; v_antes estado_remesa;
begin
  perform _exigir_admin();
  if nullif(trim(p_motivo), '') is null then raise exception 'Escribe el motivo de la corrección'; end if;
  if p_estado = 'cancelada' then raise exception 'Para cancelar usa admin_cancelar'; end if;
  r := _bloquear_remesa(p_remesa_id);
  v_antes := r.estado;
  if v_antes = p_estado then return r; end if;
  if v_antes = 'entregada' and r.comision_pagada_at is not null then
    raise exception 'La comisión de esta remesa ya se pagó al gestor; corrige eso primero';
  end if;

  update remesas set
    estado = p_estado,
    cancelada_at = null, motivo_cancelacion = null,
    zelle_monto_recibido = case when p_estado = 'esperando_zelle' then null else zelle_monto_recibido end,
    zelle_confirmado_at  = case when p_estado = 'esperando_zelle' then null
                                else coalesce(zelle_confirmado_at, now()) end,
    fecha_entrega = case when p_estado in ('esperando_zelle', 'zelle_confirmado') then null
                         else coalesce(fecha_entrega, hoy_cuba()) end,
    franja        = case when p_estado in ('esperando_zelle', 'zelle_confirmado') then null else franja end,
    entregada_at  = case when p_estado = 'entregada' then coalesce(entregada_at, now()) else null end
   where id = r.id returning * into r;
  perform _evento(r.id, 'estado_corregido',
    jsonb_build_object('de', v_antes, 'a', p_estado, 'motivo', trim(p_motivo)), false);
  return r;
end $$;

create or replace function admin_ajustar_monto(p_remesa_id bigint, p_monto numeric)
returns remesas language plpgsql security definer set search_path = public as $$
declare r remesas; v_tarifa numeric; v_com record; v_antes numeric;
begin
  perform _exigir_admin();
  if p_monto is null or p_monto <= 0 then raise exception 'Monto inválido'; end if;
  r := _bloquear_remesa(p_remesa_id);
  if r.estado <> 'esperando_zelle' then
    raise exception 'Solo se puede cambiar el monto mientras se espera el Zelle';
  end if;
  v_antes := r.monto_entrega;
  v_tarifa := calcular_tarifa(p_monto);
  select * into v_com from _comision(v_tarifa, r.gestor_id);
  update remesas set monto_entrega = p_monto, tarifa = v_tarifa,
                     comision_pct = v_com.pct, comision_gestor = v_com.monto
   where id = r.id returning * into r;
  perform _evento(r.id, 'monto_ajustado',
    jsonb_build_object('antes', v_antes, 'monto', r.monto_entrega, 'tarifa', r.tarifa, 'total', r.total_zelle));
  return r;
end $$;

create or replace function admin_asignar_gestor(p_remesa_id bigint, p_gestor_id bigint)
returns remesas language plpgsql security definer set search_path = public as $$
declare r remesas; v_com record;
begin
  perform _exigir_admin();
  r := _bloquear_remesa(p_remesa_id);
  if r.comision_pagada_at is not null then raise exception 'La comisión de esta remesa ya se pagó'; end if;
  if p_gestor_id is not null and not exists (select 1 from gestores where id = p_gestor_id) then
    raise exception 'El gestor % no existe', p_gestor_id;
  end if;
  select * into v_com from _comision(r.tarifa, p_gestor_id);
  update remesas set gestor_id = v_com.gestor_id, comision_pct = v_com.pct, comision_gestor = v_com.monto
   where id = r.id returning * into r;
  perform _evento(r.id, 'gestor_asignado',
    jsonb_build_object('gestor_id', r.gestor_id, 'comision', r.comision_gestor), false);
  return r;
end $$;

create or replace function admin_asignar_cuenta_zelle(p_remesa_id bigint, p_cuenta_zelle_id bigint)
returns remesas language plpgsql security definer set search_path = public as $$
declare r remesas; c cuentas_zelle;
begin
  perform _exigir_admin();
  r := _bloquear_remesa(p_remesa_id);
  if r.estado <> 'esperando_zelle' then
    raise exception 'Solo se puede cambiar la cuenta Zelle mientras se espera el depósito';
  end if;
  select * into c from cuentas_zelle where id = p_cuenta_zelle_id;
  if not found then raise exception 'La cuenta Zelle % no existe', p_cuenta_zelle_id; end if;
  update remesas set cuenta_zelle_id = c.id, zelle_titular = c.titular, zelle_contacto = c.contacto_zelle
   where id = r.id returning * into r;
  perform _evento(r.id, 'cuenta_zelle_cambiada', jsonb_build_object('titular', c.titular));
  return r;
end $$;

-- B le entregó el efectivo a D. Marca las comisiones de remesas ya entregadas.
-- p_remesa_ids = null → todas las pendientes de ese gestor.
create or replace function admin_pagar_comisiones(p_gestor_id bigint, p_remesa_ids bigint[] default null)
returns jsonb language plpgsql security definer set search_path = public as $$
declare v_n int; v_total numeric; v_ids bigint[];
begin
  perform _exigir_admin();
  with pagadas as (
    update remesas set comision_pagada_at = now()
     where gestor_id = p_gestor_id and estado = 'entregada'
       and comision_pagada_at is null and comision_gestor > 0
       and (p_remesa_ids is null or id = any (p_remesa_ids))
    returning id, comision_gestor
  )
  select count(*), coalesce(sum(comision_gestor), 0), array_agg(id) into v_n, v_total, v_ids from pagadas;

  insert into remesa_eventos (remesa_id, tipo, detalle, actor, visible_cliente)
  select unnest(v_ids), 'comision_pagada', jsonb_build_object('gestor_id', p_gestor_id), auth.uid(), false
  where v_ids is not null;

  return jsonb_build_object('remesas', v_n, 'total', v_total);
end $$;

-- Para clientes que escriben por WhatsApp y no usan la app.
create or replace function admin_crear_remesa_manual(
  p_cliente_nombre text, p_cliente_whatsapp text,
  p_benef_nombre text, p_benef_direccion text, p_monto numeric,
  p_benef_telefono text default null, p_benef_municipio text default null, p_benef_provincia text default null,
  p_codigo_gestor text default null, p_cuenta_zelle_id bigint default null,
  p_cliente_id uuid default null, p_nota text default null)
returns remesas language plpgsql security definer set search_path = public as $$
declare v_gestor_id bigint; g gestores; pf perfiles;
begin
  perform _exigir_admin();
  if nullif(trim(p_cliente_nombre), '') is null then raise exception 'Falta el nombre del cliente'; end if;
  if nullif(trim(p_benef_nombre), '') is null then raise exception 'Falta quién recibe'; end if;
  if nullif(trim(p_benef_direccion), '') is null then raise exception 'Falta la dirección de entrega'; end if;
  if p_monto is null or p_monto <= 0 then raise exception 'Monto inválido'; end if;

  if p_cliente_id is not null then
    select * into pf from perfiles where id = p_cliente_id;
    if not found then raise exception 'El cliente no existe'; end if;
    v_gestor_id := pf.gestor_id;
  end if;
  if nullif(trim(p_codigo_gestor), '') is not null then
    g := _gestor_por_codigo(p_codigo_gestor);
    if g.id is null then raise exception 'El código de gestor "%" no existe', upper(trim(p_codigo_gestor)); end if;
    v_gestor_id := g.id;
  end if;

  return _nueva_remesa(p_cliente_id, p_cliente_nombre, coalesce(p_cliente_whatsapp, pf.whatsapp),
                       null, p_benef_nombre, p_benef_telefono, p_benef_direccion,
                       p_benef_municipio, p_benef_provincia,
                       p_monto, v_gestor_id, p_cuenta_zelle_id, p_nota, 'admin');
end $$;

-- ---------------------------------------------------------------------
-- Reportes del ADMIN
-- Rango por fecha de Cuba. Sin fechas = mes en curso.
-- ---------------------------------------------------------------------
create or replace function admin_resumen(p_desde date default null, p_hasta date default null)
returns jsonb language plpgsql stable security definer set search_path = public as $$
declare
  v_desde date := coalesce(p_desde, date_trunc('month', hoy_cuba())::date);
  v_hasta date := coalesce(p_hasta, hoy_cuba());
  v jsonb;
begin
  perform _exigir_admin();
  with
  creadas as (
    select * from remesas
    where (creado_at at time zone 'America/Havana')::date between v_desde and v_hasta
  ),
  entregadas as (
    select * from remesas
    where estado = 'entregada'
      and (entregada_at at time zone 'America/Havana')::date between v_desde and v_hasta
  )
  select jsonb_build_object(
    'desde', v_desde, 'hasta', v_hasta,
    'creadas', (select count(*) from creadas where estado <> 'cancelada'),
    'canceladas', (select count(*) from creadas where estado = 'cancelada'),
    'por_estado', (select coalesce(jsonb_object_agg(estado, n), '{}'::jsonb)
                     from (select estado, count(*) n from creadas group by estado) s),
    'entregadas', (select count(*) from entregadas),
    'monto_entregado', (select coalesce(sum(monto_entrega), 0) from entregadas),
    'tarifas_cobradas', (select coalesce(sum(tarifa), 0) from entregadas),
    'comisiones_generadas', (select coalesce(sum(comision_gestor), 0) from entregadas),
    'ganancia_neta', (select coalesce(sum(ganancia_neta), 0) from entregadas),
    -- pendientes de hoy (sin importar el rango)
    'zelle_por_confirmar_n', (select count(*) from remesas where estado = 'esperando_zelle'),
    'zelle_por_confirmar_total', (select coalesce(sum(total_zelle), 0) from remesas where estado = 'esperando_zelle'),
    'efectivo_por_entregar', (select coalesce(sum(monto_entrega), 0) from remesas
                                where estado in ('zelle_confirmado', 'entrega_programada')),
    'entregas_hoy', (select count(*) from remesas
                       where estado = 'entrega_programada' and fecha_entrega = hoy_cuba()),
    'comisiones_por_pagar', (select coalesce(sum(comision_gestor), 0) from remesas
                               where estado = 'entregada' and comision_pagada_at is null)
  ) into v;
  return v;
end $$;

create or replace function admin_resumen_gestores(p_desde date default null, p_hasta date default null)
returns table (gestor_id bigint, codigo text, nombre text, whatsapp text, activo boolean,
               clientes bigint, remesas_entregadas bigint, comision_generada numeric, comision_pendiente numeric)
language plpgsql stable security definer set search_path = public as $$
declare
  v_desde date := coalesce(p_desde, date_trunc('month', hoy_cuba())::date);
  v_hasta date := coalesce(p_hasta, hoy_cuba());
begin
  perform _exigir_admin();
  return query
  select g.id, g.codigo, g.nombre, g.whatsapp, g.activo,
    (select count(*) from perfiles p where p.gestor_id = g.id),
    (select count(*) from remesas r where r.gestor_id = g.id and r.estado = 'entregada'
       and (r.entregada_at at time zone 'America/Havana')::date between v_desde and v_hasta),
    (select coalesce(sum(r.comision_gestor), 0) from remesas r where r.gestor_id = g.id and r.estado = 'entregada'
       and (r.entregada_at at time zone 'America/Havana')::date between v_desde and v_hasta),
    (select coalesce(sum(r.comision_gestor), 0) from remesas r where r.gestor_id = g.id and r.estado = 'entregada'
       and r.comision_pagada_at is null)
  from gestores g
  order by g.activo desc, g.nombre;
end $$;

create or replace function admin_resumen_cuentas_zelle(p_desde date default null, p_hasta date default null)
returns table (cuenta_zelle_id bigint, titular text, contacto_zelle text, whatsapp text, activa boolean,
               recibido numeric, por_confirmar_n bigint, por_confirmar_total numeric)
language plpgsql stable security definer set search_path = public as $$
declare
  v_desde date := coalesce(p_desde, date_trunc('month', hoy_cuba())::date);
  v_hasta date := coalesce(p_hasta, hoy_cuba());
begin
  perform _exigir_admin();
  return query
  select c.id, c.titular, c.contacto_zelle, c.whatsapp, c.activa,
    (select coalesce(sum(r.zelle_monto_recibido), 0) from remesas r
       where r.cuenta_zelle_id = c.id and r.zelle_confirmado_at is not null and r.estado <> 'cancelada'
         and (r.zelle_confirmado_at at time zone 'America/Havana')::date between v_desde and v_hasta),
    (select count(*) from remesas r where r.cuenta_zelle_id = c.id and r.estado = 'esperando_zelle'),
    (select coalesce(sum(r.total_zelle), 0) from remesas r where r.cuenta_zelle_id = c.id and r.estado = 'esperando_zelle')
  from cuentas_zelle c
  order by c.activa desc, c.titular;
end $$;

-- ---------------------------------------------------------------------
-- WhatsApp
-- admin_preparar_whatsapp arma el texto desde una plantilla y busca el
-- número. La web abre https://wa.me/<telefono>?text=<texto> y luego
-- llama admin_registrar_whatsapp para dejarlo en el historial.
--
-- Marcadores disponibles en las plantillas:
--   {codigo} {cliente} {beneficiario} {direccion} {monto} {tarifa} {total}
--   {zelle_recibido} {zelle_titular} {zelle_contacto} {fecha_entrega} {franja}
--   {comision} {gestor} {cuenta} {negocio} {enlace_app} {whatsapp_negocio}
--   Solo gestor:      {mes_remesas} {mes_comision} {pendiente}
--   Solo cuenta Zelle: {pendientes_n} {pendientes_total} {lista_pendientes}
-- ---------------------------------------------------------------------
create or replace function admin_preparar_whatsapp(p_plantilla text, p_remesa_id bigint default null,
  p_gestor_id bigint default null, p_cuenta_zelle_id bigint default null, p_cliente_id uuid default null)
returns jsonb language plpgsql stable security definer set search_path = public as $$
declare
  pl plantillas_whatsapp; r remesas; g gestores; c cuentas_zelle; pf perfiles;
  vars jsonb; extra jsonb := '{}'::jsonb; v_texto text; k text; v text; v_tel text;
  v_mes date := date_trunc('month', hoy_cuba())::date;
begin
  perform _exigir_admin();
  select * into pl from plantillas_whatsapp where clave = p_plantilla;
  if not found then raise exception 'La plantilla "%" no existe', p_plantilla; end if;

  if p_remesa_id is not null then
    select * into r from remesas where id = p_remesa_id;
    if not found then raise exception 'La remesa % no existe', p_remesa_id; end if;
  end if;
  select * into g  from gestores      where id = coalesce(p_gestor_id, r.gestor_id);
  select * into c  from cuentas_zelle where id = coalesce(p_cuenta_zelle_id, r.cuenta_zelle_id);
  select * into pf from perfiles      where id = coalesce(p_cliente_id, r.cliente_id);

  vars := jsonb_build_object(
    'codigo', r.codigo,
    'cliente', coalesce(r.cliente_nombre, pf.nombre),
    'beneficiario', r.beneficiario_nombre,
    'direccion', r.beneficiario_direccion,
    'monto', fmt_usd(r.monto_entrega),
    'tarifa', fmt_usd(r.tarifa),
    'total', fmt_usd(r.total_zelle),
    'zelle_recibido', fmt_usd(coalesce(r.zelle_monto_recibido, r.total_zelle)),
    'zelle_titular', coalesce(r.zelle_titular, c.titular),
    'zelle_contacto', coalesce(r.zelle_contacto, c.contacto_zelle),
    'fecha_entrega', fmt_fecha(r.fecha_entrega),
    'franja', fmt_franja(r.franja),
    'comision', fmt_usd(r.comision_gestor),
    'gestor', g.nombre,
    'cuenta', c.titular,
    'negocio', cfg_texto('nombre_negocio', 'Remesa.cu'),
    'enlace_app', cfg_texto('url_app', ''),
    'whatsapp_negocio', cfg_texto('whatsapp_negocio', ''));

  if g.id is not null then
    select jsonb_build_object(
      'mes_remesas', count(*) filter (where (entregada_at at time zone 'America/Havana')::date >= v_mes),
      'mes_comision', fmt_usd(coalesce(sum(comision_gestor) filter (
                        where (entregada_at at time zone 'America/Havana')::date >= v_mes), 0)),
      'pendiente', fmt_usd(coalesce(sum(comision_gestor) filter (where comision_pagada_at is null), 0)))
    into extra from remesas where gestor_id = g.id and estado = 'entregada';
    vars := vars || extra;
  end if;

  if c.id is not null then
    select jsonb_build_object(
      'pendientes_n', count(*),
      'pendientes_total', fmt_usd(coalesce(sum(total_zelle), 0)),
      'lista_pendientes', coalesce(string_agg(
          '• ' || codigo || ' · ' || cliente_nombre || ' · $' || fmt_usd(total_zelle),
          E'\n' order by creado_at), '(ninguno)'))
    into extra from remesas where cuenta_zelle_id = c.id and estado = 'esperando_zelle';
    vars := vars || extra;
  end if;

  v_texto := pl.texto;
  for k, v in select key, value from jsonb_each_text(vars) loop
    v_texto := replace(v_texto, '{' || k || '}', coalesce(v, ''));
  end loop;

  v_tel := normalizar_telefono(case pl.destinatario
    when 'cliente' then coalesce(r.cliente_whatsapp, pf.whatsapp)
    when 'zelle' then c.whatsapp
    when 'gestor' then g.whatsapp
    when 'beneficiario' then r.beneficiario_telefono
    else null end);

  return jsonb_build_object(
    'plantilla', pl.clave, 'destinatario', pl.destinatario, 'telefono', v_tel, 'texto', v_texto,
    'remesa_id', r.id, 'gestor_id', g.id, 'cuenta_zelle_id', c.id, 'cliente_id', pf.id,
    'aviso', case when v_tel is null then 'No hay un WhatsApp guardado para este destinatario' end);
end $$;

create or replace function admin_registrar_whatsapp(p_destinatario destinatario_wa, p_telefono text, p_texto text,
  p_remesa_id bigint default null, p_plantilla text default null, p_cliente_id uuid default null,
  p_gestor_id bigint default null, p_cuenta_zelle_id bigint default null)
returns bigint language plpgsql security definer set search_path = public as $$
declare v_tel text := normalizar_telefono(p_telefono); v_id bigint;
begin
  perform _exigir_admin();
  if v_tel is null then raise exception 'Número de WhatsApp inválido'; end if;
  if nullif(trim(p_texto), '') is null then raise exception 'El mensaje está vacío'; end if;
  insert into mensajes_whatsapp (remesa_id, destinatario, cliente_id, gestor_id, cuenta_zelle_id,
                                 telefono, plantilla_clave, texto, enviado_por)
  values (p_remesa_id, p_destinatario, p_cliente_id, p_gestor_id, p_cuenta_zelle_id,
          v_tel, p_plantilla, p_texto, auth.uid())
  returning id into v_id;
  if p_remesa_id is not null then
    perform _evento(p_remesa_id, 'whatsapp',
      jsonb_build_object('destinatario', p_destinatario, 'plantilla', p_plantilla, 'mensaje_id', v_id), false);
  end if;
  return v_id;
end $$;

-- Para las políticas del bucket 'recibos'
create or replace function puede_ver_recibo(p_path text)
returns boolean language sql stable security definer set search_path = public as $$
  select es_admin() or exists (
    select 1 from remesas where recibo_path = p_path and cliente_id = auth.uid())
$$;
