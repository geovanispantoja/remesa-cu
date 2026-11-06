-- =====================================================================
-- Remesa.cu · 005 · Configuración y plantillas de WhatsApp de fábrica
-- Todo esto se puede cambiar luego desde la web de admin.
-- =====================================================================

insert into configuracion (clave, valor, publica, descripcion) values
  ('nombre_negocio',        'Remesa.cu', true,  'Nombre que aparece en la app y en los mensajes'),
  ('whatsapp_negocio',      '',          true,  'WhatsApp del negocio (B) para que los clientes escriban. Con código de país, ej. 5355555555'),
  ('url_app',               '',          true,  'Enlace a la PWA del cliente, para ponerlo en los mensajes'),
  ('tarifa_bloque',         '100',       true,  'Cada cuántos USD se cobra la tarifa'),
  ('tarifa_por_bloque',     '10',        true,  'USD de tarifa por cada bloque (o fracción)'),
  ('tarifa_minima',         '10',        true,  'Tarifa mínima en USD'),
  ('monto_minimo',          '50',        true,  'Monto mínimo a entregar en Cuba (USD)'),
  ('monto_maximo',          '3000',      true,  'Monto máximo por remesa (USD)'),
  ('monto_multiplo',        '10',        true,  'El monto debe ser múltiplo de esto (USD). 1 = cualquier entero'),
  ('comision_gestor_pct',   '50',        false, 'Porcentaje de la tarifa que se lleva el gestor (D)'),
  ('max_remesas_esperando', '3',         false, 'Máximo de remesas esperando Zelle que puede tener un cliente a la vez'),
  ('exigir_recibo',         'si',        false, '"si" = no se puede marcar entregada sin foto del recibo')
on conflict (clave) do nothing;

insert into plantillas_whatsapp (clave, destinatario, orden, titulo, texto) values
  -- A · Cliente
  ('cliente_datos_zelle', 'cliente', 10, 'Datos del Zelle',
   'Hola {cliente}, gracias por usar {negocio}.' || E'\n\n' ||
   'Para tu remesa {codigo} deposita exactamente *${total}* por Zelle a:' || E'\n' ||
   '{zelle_titular}' || E'\n' || '{zelle_contacto}' || E'\n\n' ||
   'En el memo escribe: *{codigo}*' || E'\n' ||
   '{beneficiario} recibirá ${monto} USD en efectivo.'),
  ('cliente_recordatorio_pago', 'cliente', 20, 'Recordatorio de pago',
   'Hola {cliente}, aún no vemos el Zelle de ${total} de tu remesa {codigo}. ' ||
   'Si ya lo enviaste, mándanos la captura por aquí. ¡Gracias!'),
  ('cliente_zelle_recibido', 'cliente', 30, 'Zelle recibido',
   'Hola {cliente}, recibimos tu Zelle de ${zelle_recibido} de la remesa {codigo}. ' ||
   'En breve te decimos qué día se entrega.'),
  ('cliente_fecha_entrega', 'cliente', 40, 'Fecha de entrega',
   'Hola {cliente}, la remesa {codigo} se entregará el *{fecha_entrega}* {franja}.' || E'\n' ||
   '{beneficiario} recibirá ${monto} USD en efectivo en {direccion}.'),
  ('cliente_entregada', 'cliente', 50, 'Remesa entregada',
   'Hola {cliente}, ya entregamos ${monto} USD a {beneficiario} (remesa {codigo}). ' ||
   'Te enviamos la foto del recibo firmado. ¡Gracias por confiar en {negocio}!'),

  -- C · Cuenta Zelle
  ('zelle_aviso_deposito', 'zelle', 10, 'Aviso de depósito',
   'Hola {zelle_titular}, va a entrar un Zelle de *${total}* de {cliente}, memo {codigo}. Avísame cuando lo veas, por favor.'),
  ('zelle_pedir_confirmacion', 'zelle', 20, 'Pedir confirmación',
   'Hola {zelle_titular}, ¿ya te entró el Zelle de ${total} de {cliente} ({codigo})?'),
  ('zelle_pendientes', 'zelle', 30, 'Lista de pendientes',
   'Hola {cuenta}, estos son los Zelle que esperamos en tu cuenta:' || E'\n' ||
   '{lista_pendientes}' || E'\n' || 'Total: ${pendientes_total}'),

  -- D · Gestor
  ('gestor_comision_lista', 'gestor', 10, 'Comisión de una remesa',
   'Hola {gestor}, tu cliente {cliente} completó la remesa {codigo}. Tu comisión es *${comision}* en efectivo.'),
  ('gestor_resumen_mes', 'gestor', 20, 'Resumen del mes',
   'Hola {gestor}, este mes tus clientes completaron {mes_remesas} remesas. ' ||
   'Comisión del mes: ${mes_comision}. Pendiente de pagarte: *${pendiente}*.'),
  ('gestor_nuevo_cliente', 'gestor', 30, 'Cliente nuevo',
   'Hola {gestor}, {cliente} se registró en {negocio} con tu código. ¡Gracias!'),

  -- Quien recibe en Cuba
  ('beneficiario_aviso_entrega', 'beneficiario', 10, 'Aviso de entrega',
   'Hola {beneficiario}, el {fecha_entrega} {franja} le llevaremos ${monto} USD que le envió {cliente}. ' ||
   'Tenga a mano su carné de identidad para firmar el recibo.')
on conflict (clave) do nothing;
