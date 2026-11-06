-- =====================================================================
-- Remesa.cu · Borrar datos de PRUEBA para empezar de cero
-- Borra remesas, historial y mensajes. Conserva configuración, plantillas,
-- gestores, cuentas Zelle, clientes y sus familiares.
-- ¡NO correr en producción con remesas reales!
-- =====================================================================
truncate remesa_eventos, mensajes_whatsapp, remesas restart identity cascade;
alter sequence remesa_numero_seq restart with 1;
update cuentas_zelle set ultima_asignacion_at = null;

-- Archivos subidos en pruebas (comprobantes y recibos)
delete from storage.objects where bucket_id in ('comprobantes', 'recibos');

-- Opcional: borrar también los usuarios de prueba (menos el admin).
-- Quita el "--" de la línea de abajo si lo quieres:
-- delete from auth.users where id in (select id from perfiles where rol = 'cliente');
