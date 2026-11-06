-- Datos de demostración para probar las webs en local. Pasa por las mismas funciones que la app.
\set ON_ERROR_STOP 1
\set como_admin 'reset role; set role authenticated; select set_config(''request.jwt.claims'', ''{"sub":"aaaaaaaa-0000-0000-0000-000000000001"}'', false) \\g /dev/null'
\set como_ana   'reset role; set role authenticated; select set_config(''request.jwt.claims'', ''{"sub":"cccccccc-0000-0000-0000-000000000001"}'', false) \\g /dev/null'
\set como_beto  'reset role; set role authenticated; select set_config(''request.jwt.claims'', ''{"sub":"cccccccc-0000-0000-0000-000000000002"}'', false) \\g /dev/null'

insert into gestores (codigo, nombre, whatsapp) values ('GES-001', 'Daniel Pérez', '+53 5 111 1111'), ('GES-002', 'Dora Martínez', '52222222');
insert into cuentas_zelle (titular, contacto_zelle, whatsapp) values
  ('Carlos Gómez', 'carlos.zelle@correo.com', '+1 305 555 0001'),
  ('Clara Díaz', '+1 786 555 0002', '7865550002');
insert into auth.users (id, email, raw_user_meta_data) values
  ('aaaaaaaa-0000-0000-0000-000000000001', 'admin@remesa.cu', '{"nombre":"Geo"}'),
  ('cccccccc-0000-0000-0000-000000000001', 'ana@correo.com', '{"nombre":"Ana Rodríguez","whatsapp":"+1 305 555 1234","pais":"EE.UU.","codigo_gestor":"GES-001"}'),
  ('cccccccc-0000-0000-0000-000000000002', 'beto@correo.com', '{"nombre":"Beto Hernández","whatsapp":"+1 786 555 9999","pais":"EE.UU."}');
update perfiles set rol = 'admin' where id = 'aaaaaaaa-0000-0000-0000-000000000001';
update configuracion set valor = '5355550000' where clave = 'whatsapp_negocio';

:como_ana
insert into beneficiarios (cliente_id, nombre, telefono, direccion, municipio, provincia, referencia) values
  (auth.uid(), 'Rosa Rodríguez', '5 333 4444', 'Calle 23 #456 e/ A y B, Vedado', 'Plaza de la Revolución', 'La Habana', 'Edificio azul, 3er piso'),
  (auth.uid(), 'Julio Rodríguez', '5 444 5555', 'Calle Martí #12', 'Santa Clara', 'Villa Clara', null);
select crear_remesa((select id from beneficiarios where nombre = 'Rosa Rodríguez'), 350) \g /dev/null
select crear_remesa((select id from beneficiarios where nombre = 'Julio Rodríguez'), 500) \g /dev/null
select crear_remesa((select id from beneficiarios where nombre = 'Rosa Rodríguez'), 200) \g /dev/null

:como_beto
insert into beneficiarios (cliente_id, nombre, telefono, direccion, municipio, provincia) values
  (auth.uid(), 'Pepe Hernández', '5 777 8888', 'Ave. 51 #3412, Marianao', 'Marianao', 'La Habana');
select crear_remesa((select id from beneficiarios limit 1), 150, 'GES-002') \g /dev/null
select crear_remesa((select id from beneficiarios limit 1), 1000) \g /dev/null
select reportar_pago((select id from mis_remesas() where monto_entrega = 1000)) \g /dev/null

:como_admin
-- REM-0001 entregada, REM-0002 programada para hoy, REM-0003 esperando, REM-0004 confirmada, REM-0005 esperando (pago reportado)
select admin_confirmar_zelle(1) \g /dev/null
select admin_programar_entrega(1, hoy_cuba(), 'manana') \g /dev/null
insert into storage.objects (bucket_id, name) values ('recibos', '1/recibo-demo.jpg');
select admin_marcar_entregada(1, '1/recibo-demo.jpg', 'Firmó Rosa') \g /dev/null
select admin_confirmar_zelle(2) \g /dev/null
select admin_programar_entrega(2, hoy_cuba(), 'tarde') \g /dev/null
select admin_confirmar_zelle(4) \g /dev/null
select admin_crear_remesa_manual('Marta (por WhatsApp)', '+1 954 555 3333', 'Luis Pérez', 'Calle 10 #5, Reparto Pueblo Nuevo', 300,
  p_benef_municipio => 'Holguín', p_benef_provincia => 'Holguín', p_codigo_gestor => 'GES-002') \g /dev/null
reset role;
