// node --test compartido/
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  calcularTarifa, cotizarLocal, normalizarTelefono, enlaceWhatsApp, textoError,
  crearApiCliente, crearApiAdmin,
} from './remesa-api.js';

test('tarifa: 10 por cada 100 o fracción', () => {
  assert.equal(calcularTarifa(350), 40);
  assert.equal(calcularTarifa(300), 30);
  assert.equal(calcularTarifa(320), 40);
  assert.equal(calcularTarifa(50), 10);
  assert.equal(calcularTarifa(0), 0);
  assert.equal(calcularTarifa(1000, { tarifa_por_bloque: '8' }), 80);
});

test('cotizar valida igual que la base', () => {
  assert.deepEqual(cotizarLocal(350), { ok: true, monto: 350, tarifa: 40, total: 390 });
  assert.match(cotizarLocal(355).error, /múltiplo de \$10/);
  assert.match(cotizarLocal(40).error, /mínimo es \$50/);
  assert.match(cotizarLocal(10.5, { monto_multiplo: 1 }).error, /enteros/);
});

test('teléfonos', () => {
  assert.equal(normalizarTelefono('+1 (305) 555-1234'), '13055551234');
  assert.equal(normalizarTelefono('305 555 1234'), '13055551234');
  assert.equal(normalizarTelefono('5 333 4444'), '5353334444');
  assert.equal(normalizarTelefono('+53 5 111 1111'), '5351111111');
  assert.equal(normalizarTelefono('5351111111'), '5351111111');
  assert.equal(normalizarTelefono('+52 55 1234 5678'), '525512345678');
  assert.equal(normalizarTelefono('123'), null);
});

test('enlace de WhatsApp', () => {
  assert.equal(enlaceWhatsApp('+1 305 555 1234', 'Hola $390 & listo'),
    'https://wa.me/13055551234?text=Hola%20%24390%20%26%20listo');
  assert.throws(() => enlaceWhatsApp('12', 'x'), /inválido/);
});

test('errores legibles', () => {
  assert.equal(textoError({ message: 'Invalid login credentials' }), 'Correo o contraseña incorrectos.');
  assert.equal(textoError({ message: 'El monto mínimo es $50' }), 'El monto mínimo es $50');
});

// Supabase falso que anota las llamadas
function sbFalso(respuestas = {}) {
  const llamadas = [];
  return {
    llamadas,
    rpc: async (fn, args) => {
      llamadas.push([fn, args]);
      const r = respuestas[fn];
      return typeof r === 'function' ? r(args) : (r ?? { data: null, error: null });
    },
    auth: {
      getSession: async () => ({ data: { session: { user: { id: 'uid-1' } } }, error: null }),
      signInWithPassword: async (c) => { llamadas.push(['login', c]); return { data: { ok: 1 }, error: null }; },
      signOut: async () => { llamadas.push(['salir']); return { error: null }; },
    },
    storage: { from: (b) => ({ upload: async (p) => { llamadas.push(['subir', b, p]); return { data: {}, error: null }; } }) },
  };
}

test('crear remesa manda los parámetros correctos y traduce errores', async () => {
  const sb = sbFalso({ crear_remesa: (a) => a.p_monto === 355
    ? { data: null, error: { message: 'El monto debe ser múltiplo de $10' } }
    : { data: { id: 1, total_zelle: 390 }, error: null } });
  const api = crearApiCliente(sb);
  assert.deepEqual(await api.crearRemesa({ familiarId: 7, monto: 350, codigoGestor: 'GES-001' }), { id: 1, total_zelle: 390 });
  assert.deepEqual(sb.llamadas[0], ['crear_remesa', { p_beneficiario_id: 7, p_monto: 350, p_codigo_gestor: 'GES-001', p_nota: null }]);
  await assert.rejects(api.crearRemesa({ familiarId: 7, monto: 355 }), /múltiplo/);
});

test('reportar pago sube la captura en la carpeta del cliente', async () => {
  const sb = sbFalso({ reportar_pago: { data: { id: 5 }, error: null } });
  await crearApiCliente(sb).reportarPago(5, { type: 'image/png' });
  const [, bucket, path] = sb.llamadas.find((l) => l[0] === 'subir');
  assert.equal(bucket, 'comprobantes');
  assert.match(path, /^uid-1\/5-\d+\.png$/);
  assert.equal(sb.llamadas.at(-1)[1].p_comprobante_path, path);
});

test('admin entra solo con contraseña y se rechaza si no es admin', async () => {
  const sb = sbFalso({ es_admin: { data: false, error: null } });
  const api = crearApiAdmin(sb, { correoAdmin: 'admin@remesa.cu' });
  await assert.rejects(api.entrar('clave'), /no es de administrador/);
  assert.deepEqual(sb.llamadas[0], ['login', { email: 'admin@remesa.cu', password: 'clave' }]);
  assert.ok(sb.llamadas.some((l) => l[0] === 'salir'));
});

test('admin: preparar y enviar WhatsApp', async () => {
  const sb = sbFalso({
    admin_preparar_whatsapp: { data: { telefono: '13055551234', texto: 'Deposita $390', destinatario: 'cliente',
                                       plantilla: 'cliente_datos_zelle', remesa_id: 1 }, error: null },
    admin_registrar_whatsapp: { data: 9, error: null },
  });
  const api = crearApiAdmin(sb, { correoAdmin: 'a@b.c' });
  const m = await api.prepararWhatsApp('cliente_datos_zelle', { remesaId: 1 });
  assert.equal(m.enlace, 'https://wa.me/13055551234?text=Deposita%20%24390');
  let abierto;
  await api.enviarWhatsApp({ ...m, texto: 'Deposita $390, gracias' }, (u) => { abierto = u; });
  assert.equal(abierto, 'https://wa.me/13055551234?text=Deposita%20%24390%2C%20gracias');
  const reg = sb.llamadas.find((l) => l[0] === 'admin_registrar_whatsapp')[1];
  assert.equal(reg.p_texto, 'Deposita $390, gracias');
  assert.equal(reg.p_remesa_id, 1);
});
