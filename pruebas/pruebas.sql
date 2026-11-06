-- Pruebas del backend de Remesa.cu. Se corren con pruebas/correr.sh
\set ON_ERROR_STOP 1
\pset tuples_only on
\pset format unaligned

create schema pruebas;
grant usage on schema pruebas to anon, authenticated;
create function pruebas.ok(p_nombre text, p_cond boolean) returns text language plpgsql as $$
begin
  if p_cond is not true then raise exception 'FALLÓ: %', p_nombre; end if;
  return 'ok · ' || p_nombre;
end $$;
create function pruebas.error(p_nombre text, p_sql text, p_patron text) returns text language plpgsql as $$
begin
  begin
    execute p_sql;
  exception when others then
    if sqlerrm ilike '%' || p_patron || '%' then return 'ok · ' || p_nombre; end if;
    raise exception 'FALLÓ: % — dio otro error: %', p_nombre, sqlerrm;
  end;
  raise exception 'FALLÓ: % — no dio error', p_nombre;
end $$;
grant execute on all functions in schema pruebas to anon, authenticated;

-- Quién soy en cada momento
\set ADMIN 'aaaaaaaa-0000-0000-0000-000000000001'
\set ANA   'cccccccc-0000-0000-0000-000000000001'
\set BETO  'cccccccc-0000-0000-0000-000000000002'
\set como_anon  'reset role; set role anon; select set_config(''request.jwt.claims'', '''', false) \\g /dev/null'
\set como_admin 'reset role; set role authenticated; select set_config(''request.jwt.claims'', ''{"sub":"aaaaaaaa-0000-0000-0000-000000000001"}'', false) \\g /dev/null'
\set como_ana   'reset role; set role authenticated; select set_config(''request.jwt.claims'', ''{"sub":"cccccccc-0000-0000-0000-000000000001"}'', false) \\g /dev/null'
\set como_beto  'reset role; set role authenticated; select set_config(''request.jwt.claims'', ''{"sub":"cccccccc-0000-0000-0000-000000000002"}'', false) \\g /dev/null'
\set como_dueno 'reset role; select set_config(''request.jwt.claims'', '''', false) \\g /dev/null'

-- ---------------------------------------------------------------- datos
:como_dueno
insert into gestores (codigo, nombre, whatsapp) values ('GES-001', 'Daniel Gestor', '+53 5 111 1111'), ('GES-002', 'Dora Gestora', '52222222');
insert into gestores (codigo, nombre, activo) values ('GES-099', 'Gestor Inactivo', false);
insert into cuentas_zelle (titular, contacto_zelle, whatsapp) values
  ('Carlos Zelle', 'carlos@correo.com', '+1 305 555 0001'),
  ('Clara Zelle', '+1 786 555 0002', '7865550002');
insert into auth.users (id, email, raw_user_meta_data) values
  (:'ADMIN', 'admin@remesa.cu', '{"nombre":"Dueño"}'),
  (:'ANA', 'ana@correo.com', '{"nombre":"Ana Cliente","whatsapp":"+1 (305) 555-1234","pais":"EE.UU.","codigo_gestor":" ges-001 "}'),
  (:'BETO', 'beto@correo.com', '{"nombre":"Beto Cliente","whatsapp":"786 555 9999","codigo_gestor":"NOEXISTE"}');
update perfiles set rol = 'admin' where id = :'ADMIN';

select pruebas.ok('registro crea perfil con gestor y WhatsApp normalizado',
  (select gestor_id = (select id from gestores where codigo = 'GES-001') and whatsapp = '13055551234'
     from perfiles where id = :'ANA'));
select pruebas.ok('código de gestor inválido al registrarse se ignora sin romper',
  (select gestor_id is null and whatsapp = '17865559999' from perfiles where id = :'BETO'));

-- ---------------------------------------------------------------- sin sesión
:como_anon
select pruebas.ok('tarifa 350 → 40, total 390',
  cotizar(350) = '{"ok":true,"monto":350,"tarifa":40,"total":390}'::jsonb);
select pruebas.ok('tarifa 300 → 30', (cotizar(300)->>'tarifa')::numeric = 30);
select pruebas.ok('tarifa 320 → 40 (fracción paga bloque)', (cotizar(320)->>'tarifa')::numeric = 40);
select pruebas.ok('tarifa 50 → 10', (cotizar(50)->>'tarifa')::numeric = 10);
select pruebas.ok('monto bajo el mínimo', cotizar(40)->>'error' like 'El monto mínimo es $50');
select pruebas.ok('monto no múltiplo de 10', cotizar(355)->>'error' like '%múltiplo de $10');
select pruebas.ok('monto sobre el máximo', cotizar(5000)->>'error' like '%máximo%');
select pruebas.ok('config pública tiene la tarifa', config_publica() ? 'tarifa_por_bloque');
select pruebas.ok('config pública NO tiene la comisión del gestor', not (config_publica() ? 'comision_gestor_pct'));
select pruebas.ok('validar código de gestor', validar_codigo_gestor('ges-002') = '{"valido":true,"codigo":"GES-002","nombre":"Dora"}'::jsonb);
select pruebas.ok('gestor inactivo no vale', validar_codigo_gestor('GES-099')->>'valido' = 'false');
select pruebas.error('anon no lee remesas', 'select * from remesas', 'permission denied');
select pruebas.error('anon no lee gestores', 'select * from gestores', 'permission denied');
select pruebas.error('anon no crea remesas', 'select crear_remesa(1, 100)', 'permission denied');
select pruebas.error('anon no usa funciones admin', 'select admin_resumen()', 'permission denied');

-- ---------------------------------------------------------------- cliente Ana
:como_ana
select pruebas.error('cliente no se hace admin', $$update perfiles set rol = 'admin' where id = auth.uid()$$, 'No puedes cambiar');
select pruebas.error('cliente no se cambia el gestor', $$update perfiles set gestor_id = null where id = auth.uid()$$, 'No puedes cambiar');
update perfiles set nombre = 'Ana María Cliente' where id = auth.uid();
select pruebas.ok('cliente edita su nombre', (select nombre from perfiles where id = auth.uid()) = 'Ana María Cliente');
select pruebas.ok('cliente solo ve su perfil', (select count(*) from perfiles) = 1);
select pruebas.ok('cliente no ve configuración', (select count(*) from configuracion) = 0);
select pruebas.ok('cliente no ve tabla remesas directo', (select count(*) from remesas) = 0);

insert into beneficiarios (cliente_id, nombre, telefono, direccion, municipio, provincia)
values (auth.uid(), 'Abuela Rosa', '5 333 4444', 'Calle 23 #456 e/ A y B, Vedado', 'Plaza', 'La Habana')
returning id as benef_ana \gset
select pruebas.error('crear remesa con monto inválido', format('select crear_remesa(%s, 355)', :benef_ana), 'múltiplo');

select id as rem1, codigo as rem1_codigo from crear_remesa(:benef_ana, 350, null, 'Para la medicina') \gset
select pruebas.ok('remesa 350: tarifa 40, total 390, cuenta Zelle asignada',
  (select tarifa = 40 and total_zelle = 390 and zelle_titular = 'Carlos Zelle' and estado = 'esperando_zelle'
     from mis_remesas(:rem1)));
select pruebas.ok('código REM-0001', :'rem1_codigo' = 'REM-0001');
select pruebas.ok('el cliente no ve campos de comisión', not exists (
  select 1 from pg_attribute a join pg_type t on t.typrelid = a.attrelid
  where t.typname = 'remesa_cliente' and a.attname in ('comision_gestor', 'ganancia_neta', 'notas_admin', 'gestor_id')));
select pruebas.error('cliente no confirma Zelle', format('select admin_confirmar_zelle(%s)', :rem1), 'Solo el administrador');
select pruebas.error('reportar pago con captura ajena', format($$select reportar_pago(%s, 'otro-uid/x.jpg')$$, :rem1), 'Comprobante inválido');

-- archivos
insert into storage.objects (bucket_id, name) values ('comprobantes', :'ANA' || '/rem1.jpg');
select pruebas.error('no sube comprobante en carpeta ajena',
  format($$insert into storage.objects (bucket_id, name) values ('comprobantes', '%s/x.jpg')$$, :'BETO'), 'row-level security');
select pruebas.error('cliente no sube recibos',
  format($$insert into storage.objects (bucket_id, name) values ('recibos', '%s/x.jpg')$$, :rem1), 'row-level security');

select estado from reportar_pago(:rem1, :'ANA' || '/rem1.jpg') \g /dev/null
select pruebas.ok('pago reportado con captura',
  (select cliente_reporto_pago_at is not null and comprobante_pago_path = :'ANA' || '/rem1.jpg' from mis_remesas(:rem1)));
select pruebas.error('no cancela después de reportar pago', format('select cancelar_mi_remesa(%s)', :rem1), 'Ya nos avisaste');

-- ---------------------------------------------------------------- cliente Beto
:como_beto
select pruebas.ok('Beto no ve la remesa de Ana', (select count(*) from mis_remesas(:rem1)) = 0);
select pruebas.ok('Beto no ve los familiares de Ana', (select count(*) from beneficiarios) = 0);
select pruebas.error('Beto no reporta pago de Ana', format('select reportar_pago(%s)', :rem1), 'no encontrada');
select pruebas.error('Beto no usa el familiar de Ana', format('select crear_remesa(%s, 100)', :benef_ana), 'Elige a quién');
select pruebas.error('Beto no inserta familiares a nombre de Ana',
  format($$insert into beneficiarios (cliente_id, nombre, direccion) values ('%s', 'X', 'Calle falsa 123')$$, :'ANA'),
  'row-level security');
select pruebas.ok('Beto no ve comprobantes de Ana', (select count(*) from storage.objects) = 0);

insert into beneficiarios (cliente_id, nombre, direccion) values (auth.uid(), 'Tío Pepe', 'Martí #12, Santa Clara')
returning id as benef_beto \gset
select pruebas.error('código de gestor inexistente', format($$select crear_remesa(%s, 100, 'NOPE')$$, :benef_beto), 'no existe');
select id as rem2 from crear_remesa(:benef_beto, 200, 'ges-002') \gset
select pruebas.ok('cuenta Zelle rota a Clara y Beto queda con gestor',
  (select zelle_titular = 'Clara Zelle' and tarifa = 20 from mis_remesas(:rem2))
  and (select gestor_id is not null from perfiles where id = auth.uid()));
select id as rem3 from crear_remesa(:benef_beto, 100) \gset
select id as rem4 from crear_remesa(:benef_beto, 1000) \gset
select pruebas.error('máximo 3 remesas esperando Zelle', format('select crear_remesa(%s, 100)', :benef_beto), 'Tienes 3 remesas');
select estado from cancelar_mi_remesa(:rem3, 'Me equivoqué') \g /dev/null
select pruebas.ok('cliente cancela antes de pagar', (select estado = 'cancelada' from mis_remesas(:rem3)));

-- ---------------------------------------------------------------- admin
:como_admin
select pruebas.ok('admin ve todas las remesas', (select count(*) from remesas) = 4);
select pruebas.ok('el gestor de Beto es GES-002',
  (select g.codigo = 'GES-002' from perfiles p join gestores g on g.id = p.gestor_id where p.id = :'BETO'));
select pruebas.ok('comisión de Ana = 20 (50% de 40), ganancia 20',
  (select comision_gestor = 20 and ganancia_neta = 20 from remesas where id = :rem1));
select pruebas.error('Zelle incompleto no se confirma', format('select admin_confirmar_zelle(%s, 380)', :rem1), 'Llegaron $380');
select estado from admin_confirmar_zelle(:rem1) \g /dev/null
select pruebas.error('no se confirma dos veces', format('select admin_confirmar_zelle(%s)', :rem1), 'Zelle confirmado');
select pruebas.error('fecha en el pasado', format($$select admin_programar_entrega(%s, current_date - 3)$$, :rem1), 'pasado');
select estado from admin_programar_entrega(:rem1, current_date + 2, 'manana') \g /dev/null
select estado from admin_programar_entrega(:rem1, current_date + 3, 'tarde') \g /dev/null
select pruebas.ok('reprogramación queda en el historial',
  (select count(*) from remesa_eventos where remesa_id = :rem1 and tipo = 'entrega_reprogramada') = 1);
select pruebas.error('entregar sin recibo', format('select admin_marcar_entregada(%s)', :rem1), 'recibo firmado');
select pruebas.error('recibo en carpeta equivocada', format($$select admin_marcar_entregada(%s, '999/x.jpg')$$, :rem1), 'carpeta');
insert into storage.objects (bucket_id, name) values ('recibos', :rem1 || '/recibo.jpg');
select pruebas.ok('admin ve el comprobante de Ana', (select count(*) from storage.objects where bucket_id = 'comprobantes') = 1);
select estado from admin_marcar_entregada(:rem1, :rem1 || '/recibo.jpg', 'Firmó la abuela') \g /dev/null
select pruebas.ok('remesa entregada', (select estado = 'entregada' and entregada_at is not null from remesas where id = :rem1));

-- Zelle de Beto llegó con $5 de más
select estado from admin_confirmar_zelle(:rem2, 225) \g /dev/null
select pruebas.ok('diferencia de Zelle se anota en privado',
  (select (detalle->>'diferencia')::numeric = 5 and not visible_cliente from remesa_eventos where remesa_id = :rem2 and tipo = 'diferencia_zelle'));

select estado from admin_ajustar_monto(:rem4, 950) \g /dev/null
select pruebas.ok('ajustar monto recalcula tarifa y comisión',
  (select tarifa = 100 and total_zelle = 1050 and comision_gestor = 50 from remesas where id = :rem4));
select pruebas.ok('admin cambia cuenta Zelle',
  (select zelle_titular = 'Carlos Zelle' from admin_asignar_cuenta_zelle(:rem4, (select id from cuentas_zelle where titular = 'Carlos Zelle'))));

select pruebas.ok('resumen del mes',
  (with s as (select admin_resumen() j) select
     (j->>'entregadas')::int = 1 and (j->>'monto_entregado')::numeric = 350 and (j->>'tarifas_cobradas')::numeric = 40
     and (j->>'ganancia_neta')::numeric = 20 and (j->>'comisiones_por_pagar')::numeric = 20
     and (j->>'efectivo_por_entregar')::numeric = 200 and (j->>'zelle_por_confirmar_total')::numeric = 1050
     and (j->>'canceladas')::int = 1
   from s));
select pruebas.ok('resumen por gestor',
  (select comision_generada = 20 and comision_pendiente = 20 and clientes = 1 and remesas_entregadas = 1
     from admin_resumen_gestores() where codigo = 'GES-001'));
select pruebas.ok('resumen por cuenta Zelle',
  (select recibido = 390 and por_confirmar_n = 1 and por_confirmar_total = 1050
     from admin_resumen_cuentas_zelle() where titular = 'Carlos Zelle'));

-- WhatsApp
select pruebas.ok('WhatsApp al cliente con datos del Zelle',
  (with w as (select admin_preparar_whatsapp('cliente_datos_zelle', :rem1) j) select
     j->>'telefono' = '13055551234' and j->>'destinatario' = 'cliente'
     and j->>'texto' like '%*$390*%' and j->>'texto' like '%REM-0001%' and j->>'texto' like '%carlos@correo.com%'
     and j->>'texto' not like '%{%'
   from w));
select pruebas.ok('WhatsApp al gestor con su comisión',
  (with w as (select admin_preparar_whatsapp('gestor_comision_lista', :rem1) j) select
     j->>'telefono' = '5351111111' and j->>'texto' like '%*$20*%' from w));
select pruebas.ok('WhatsApp a la cuenta Zelle con lista de pendientes',
  (with w as (select admin_preparar_whatsapp('zelle_pendientes', null, null, (select id from cuentas_zelle where titular = 'Carlos Zelle')) j)
   select j->>'telefono' = '13055550001' and j->>'texto' like '%REM-0004%$1050%' from w));
select pruebas.ok('WhatsApp de fecha de entrega en español',
  (select admin_preparar_whatsapp('cliente_fecha_entrega', :rem1)->>'texto' ~ '(lunes|martes|miércoles|jueves|viernes|sábado|domingo) \d+ de \w+\* en la tarde'));
select pruebas.ok('resumen del mes al gestor',
  (select admin_preparar_whatsapp('gestor_resumen_mes', null, (select id from gestores where codigo = 'GES-001'))->>'texto'
     like '%completaron 1 remesas%Pendiente de pagarte: *$20*%'));
select pruebas.ok('aviso si no hay número',
  (select admin_preparar_whatsapp('beneficiario_aviso_entrega', :rem2)->>'aviso' is not null));
select admin_registrar_whatsapp('cliente', '13055551234', 'hola', :rem1, 'cliente_datos_zelle') as msg_id \gset
select pruebas.ok('WhatsApp queda registrado', (select count(*) from mensajes_whatsapp) = 1);

-- Comisiones
select pruebas.ok('pagar comisiones del gestor',
  admin_pagar_comisiones((select id from gestores where codigo = 'GES-001')) = '{"remesas":1,"total":20}'::jsonb);
select pruebas.ok('no se pagan dos veces',
  admin_pagar_comisiones((select id from gestores where codigo = 'GES-001')) = '{"remesas":0,"total":0}'::jsonb);
select pruebas.error('no se reabre una remesa con comisión pagada',
  format($$select admin_corregir_estado(%s, 'entrega_programada', 'error')$$, :rem1), 'ya se pagó');

-- Remesa manual y cancelación con devolución
select id as rem5 from admin_crear_remesa_manual('Cliente por WhatsApp', '+1 305 555 7777', 'Primo Luis',
  'Calle 10 #5, Holguín', 400, p_codigo_gestor => 'GES-002') \gset
select pruebas.ok('remesa manual con gestor',
  (select tarifa = 40 and comision_gestor = 20 and cliente_id is null and cliente_whatsapp = '13055557777' from remesas where id = :rem5));
select estado from admin_cancelar(:rem2, 'El cliente pidió devolución') \g /dev/null
select pruebas.ok('cancelar con Zelle ya cobrado deja aviso de devolver',
  exists (select 1 from remesa_eventos where remesa_id = :rem2 and tipo = 'devolver_zelle'));
select estado from admin_corregir_estado(:rem2, 'zelle_confirmado', 'Se arregló con el cliente') \g /dev/null
select pruebas.ok('corregir estado deshace la cancelación',
  (select estado = 'zelle_confirmado' and cancelada_at is null from remesas where id = :rem2));
select pruebas.error('admin no cambia montos editando la tabla',
  format($$update remesas set monto_entrega = 1 where id = %s$$, :rem1), 'permission denied');
update remesas set notas_admin = 'Cliente fiel' where id = :rem1;

-- ---------------------------------------------------------------- Ana otra vez
:como_ana
select pruebas.ok('Ana ve su remesa entregada con recibo',
  (select estado = 'entregada' and recibo_path = :rem1 || '/recibo.jpg' from mis_remesas(:rem1)));
select pruebas.ok('Ana ve su historial sin eventos internos',
  (select array_agg(tipo order by id) = array['creada', 'pago_reportado', 'zelle_confirmado', 'entrega_programada',
                                               'entrega_reprogramada', 'entregada']
     from mis_eventos(:rem1)));
select pruebas.ok('Ana puede ver el archivo del recibo', (select count(*) from storage.objects where bucket_id = 'recibos') = 1);
select pruebas.ok('Ana no ve las notas del admin',
  not exists (select 1 from mis_remesas(:rem1) m where to_jsonb(m)::text like '%Cliente fiel%'));
:como_beto
select pruebas.ok('Beto no ve el recibo de Ana', (select count(*) from storage.objects where bucket_id = 'recibos') = 0);

:como_dueno
select '— TODAS LAS PRUEBAS PASARON —';
