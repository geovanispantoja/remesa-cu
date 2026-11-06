// Prueba de punta a punta de la PWA del cliente contra el Supabase local (preparar.sh).
//   node pruebas/navegador/cliente.e2e.mjs [carpeta-capturas]
import { createRequire } from 'node:module';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import assert from 'node:assert/strict';

const require = createRequire(import.meta.url);
const { chromium } = require('playwright');
const AQUI = path.dirname(new URL(import.meta.url).pathname);
const CAPTURAS = process.argv[2] ?? '/tmp/capturas-cliente';
fs.mkdirSync(CAPTURAS, { recursive: true });
const BASE = 'http://localhost:8080/cliente/';
const umd = fs.readFileSync(path.join(AQUI, 'node_modules/@supabase/supabase-js/dist/umd/supabase.js'), 'utf8');
const shim = `${umd}\nexport const createClient = supabase.createClient;\n`;

// SQL directo como el admin (para avanzar la remesa como lo haría la web de admin)
const ADMIN = 'aaaaaaaa-0000-0000-0000-000000000001';
function sql(consulta, como = ADMIN) {
  const pre = como ? `set role authenticated; select set_config('request.jwt.claims', '{"sub":"${como}"}', false);` : '';
  return execFileSync('psql', ['-X', '-q', '-At', '-v', 'ON_ERROR_STOP=1', '-d', process.env.DB ?? 'remesa_dev', '-c', pre + consulta],
    { env: { PGHOST: '/tmp', PGPORT: '5544', PGUSER: 'postgres', ...process.env }, encoding: 'utf8' }).trim().split('\n').at(-1);
}

const errores = [];
const paso = (t) => console.log('·', t);
const navegador = await chromium.launch();
const ctx = await navegador.newContext({
  viewport: { width: 390, height: 844 }, deviceScaleFactor: 2, isMobile: true, hasTouch: true, locale: 'es-ES',
  permissions: ['clipboard-read', 'clipboard-write'],
});
await ctx.route(/cdn\.jsdelivr\.net\/npm\/@supabase\/supabase-js/, (r) => r.fulfill({ contentType: 'text/javascript', body: shim }));
await ctx.route(/fonts\.(googleapis|gstatic)\.com/, (r) => r.fulfill({ contentType: 'text/css', body: '' }));
const p = await ctx.newPage();
p.on('pageerror', (e) => errores.push(`pageerror: ${e.message}`));
p.on('console', (m) => { if (m.type() === 'error' && !/Failed to load resource.*(400|401|404|422)/.test(m.text())) errores.push(`console: ${m.text()}`); });
const aviso = (t) => p.locator('.aviso-flot', { hasText: t }).first().waitFor({ timeout: 5000 });
const captura = (n) => p.screenshot({ path: path.join(CAPTURAS, n + '.png'), fullPage: true });
const sinScroll = async (donde) => {
  const ancho = await p.evaluate(() => document.documentElement.scrollWidth);
  assert.ok(ancho <= 391, `${donde}: ancho ${ancho}px`);
};

try {
  paso('enlace del gestor y calculadora sin cuenta');
  await p.goto(BASE + '?g=ges-002');
  await p.locator('#calc-res', { hasText: 'Depositas $390' }).waitFor();
  assert.equal(new URL(p.url()).search, '', 'el ?g= se quita de la barra');
  await p.fill('#calc', '355');
  await p.locator('#calc-res', { hasText: 'múltiplo' }).waitFor();
  await captura('01-entrar'); await sinScroll('entrar');

  paso('crear cuenta (el código del gestor viene del enlace)');
  await p.click('text=Crear cuenta');
  await p.locator('#gestor-res', { hasText: 'Te invitó Dora' }).waitFor();
  assert.equal(await p.inputValue('#gestor'), 'GES-002');
  await p.fill('#nombre', 'Laura Méndez');
  await p.fill('#wa', '305 555 4321');
  await p.selectOption('#pais', 'Estados Unidos');
  await p.fill('#correo', 'laura@correo.com');
  await p.fill('#clave', '123');
  await p.click('#f button[type=submit]');
  await p.locator('.error', { hasText: 'al menos 6' }).waitFor();
  await p.fill('#clave', 'laura123');
  await captura('02-registro');
  await p.click('#f button[type=submit]');
  await p.locator('h1', { hasText: 'Nuevo familiar' }).waitFor();
  assert.equal(sql(`select g.codigo || '|' || p.whatsapp from perfiles p join gestores g on g.id = p.gestor_id where p.correo = 'laura@correo.com'`, null), 'GES-002|13055554321');

  paso('agregar familiar y volver a enviar');
  await p.click('#f button[type=submit]');
  await p.locator('.error', { hasText: 'nombre' }).waitFor();
  await p.fill('#nombre', 'Carmen Méndez');
  await p.fill('#tel', '5 222 3333');
  await p.fill('#dir', 'Calle 8 #104 e/ 5ta y 7ma, Miramar');
  await p.selectOption('#prov', 'La Habana');
  await p.fill('#mun', 'Playa');
  await captura('03-familiar'); await sinScroll('familiar');
  await p.click('#f button[type=submit]');
  await p.locator('h1', { hasText: 'Nueva remesa' }).waitFor();
  assert.ok(await p.locator('input[name=familiar]').first().isChecked());

  paso('calcular y pedir la remesa');
  await p.click('[data-monto="300"]');
  await p.locator('#r-total', { hasText: '$330' }).waitFor();
  await p.fill('#monto', '355');
  await p.locator('#error-monto', { hasText: 'múltiplo' }).waitFor();
  await p.fill('#monto', '350');
  await p.locator('#r-total', { hasText: '$390' }).waitFor();
  await p.locator('#solicitar', { hasText: 'Solicitar remesa de $390' }).waitFor();
  assert.equal(await p.locator('#codigo').count(), 0, 'ya tiene gestor: no se pide código');
  await p.fill('#nota', 'Llamar antes');
  await captura('04-enviar'); await sinScroll('enviar');
  await p.click('#solicitar');
  await p.locator('h2', { hasText: 'Ahora deposita por Zelle' }).waitFor();
  const codigo = (await p.locator('h1').innerText()).replace('Remesa ', '');
  assert.match(codigo, /^REM-\d{4}$/);
  await p.locator('.copiable', { hasText: 'carlos.zelle@correo.com' }).waitFor();
  await p.locator('.copiable', { hasText: codigo }).locator('button').click();
  await aviso('Copiado');
  assert.equal(await p.evaluate(() => navigator.clipboard.readText()), codigo);
  await captura('05-pagar'); await sinScroll('pagar');
  const id = sql(`select id from remesas where codigo = '${codigo}'`);
  assert.equal(sql(`select tarifa || '|' || comision_gestor || '|' || nota_cliente from remesas where id = ${id}`), '40.00|20.00|Llamar antes');

  paso('"Ya deposité" con captura');
  await p.click('[data-accion=pagado]');
  await p.setInputFiles('#captura', path.join(AQUI, 'recibo-demo.jpg'));
  await p.click('#enviar-aviso');
  await aviso('Gracias');
  await p.locator('strong', { hasText: 'Estamos confirmando tu Zelle' }).waitFor();
  await p.locator('text=Recibimos tu captura').waitFor();
  assert.match(sql(`select comprobante_pago_path from remesas where id = ${id}`), /^[0-9a-f-]{36}\/\d+-\d+\.jpg$/);
  assert.equal(await p.locator('[data-accion=cancelar]').count(), 0, 'ya no se puede cancelar sola');

  paso('el admin confirma, programa y entrega');
  sql(`select admin_confirmar_zelle(${id})`);
  await p.reload();
  await p.locator('.chip', { hasText: 'Zelle recibido' }).waitFor();
  sql(`select admin_programar_entrega(${id}, hoy_cuba() + 1, 'manana')`);
  await p.reload();
  await p.locator('.pasos li.hecho', { hasText: 'Fecha de entrega' }).waitFor();
  await captura('06-programada');
  fs.mkdirSync(`/tmp/remesa-storage/recibos/${id}`, { recursive: true });
  fs.copyFileSync(path.join(AQUI, 'recibo-demo.jpg'), `/tmp/remesa-storage/recibos/${id}/r.jpg`);
  sql(`insert into storage.objects (bucket_id, name) values ('recibos', '${id}/r.jpg'); select admin_marcar_entregada(${id}, '${id}/r.jpg')`);
  await p.reload();
  await p.locator('.chip', { hasText: 'Entregada' }).waitFor();
  await p.waitForFunction(() => document.querySelector('#recibo')?.naturalWidth > 0, null, { timeout: 5000 });
  await captura('07-entregada');

  paso('mis remesas y una segunda remesa cancelada');
  await p.click('.barra-nav >> text=Enviar');
  await p.fill('#monto', '100');
  await p.click('#solicitar');
  await p.locator('h2', { hasText: 'Ahora deposita' }).waitFor();
  await p.click('[data-accion=cancelar]');
  await p.fill('#motivo', 'Me equivoqué');
  await p.click('#si-cancelar');
  await aviso('cancelada');
  await p.locator('h2', { hasText: 'Remesa cancelada' }).waitFor();
  await p.click('.barra-nav >> text=Remesas');
  await p.locator('h1', { hasText: 'Mis remesas' }).waitFor();
  await p.locator('.remesa-item').nth(1).waitFor();
  assert.equal(await p.locator('.remesa-item').count(), 2);
  await p.locator('text=Entregado este año').waitFor();
  assert.match(await p.locator('main').innerText(), /\$350/);
  await captura('08-remesas'); await sinScroll('remesas');

  paso('familiares y perfil');
  await p.click('.barra-nav >> text=Familiares');
  await p.locator('h1', { hasText: 'Familiares' }).waitFor();
  await p.locator('.remesa-item', { hasText: 'Carmen Méndez' }).click();
  await p.fill('#ref', 'Casa con rejas verdes');
  await p.click('#f button[type=submit]');
  await aviso('Guardado');
  await p.click('a[aria-label="Mi cuenta"]');
  await p.fill('#wa', 'abc');
  await p.click('#f button[type=submit]');
  await p.locator('.error', { hasText: 'WhatsApp' }).waitFor();
  await p.fill('#wa', '+1 786 555 0000');
  await p.click('#f button[type=submit]');
  await aviso('Guardado');
  assert.equal(sql(`select whatsapp from perfiles where correo = 'laura@correo.com'`, null), '17865550000');
  await captura('09-perfil'); await sinScroll('perfil');

  paso('el cliente no puede ver remesas de otros');
  await p.goto(BASE + '#/remesa/1');
  await p.locator('text=No encontramos esa remesa').waitFor();

  paso('salir, olvidé contraseña y volver a entrar');
  await p.goto(BASE + '#/perfil');
  await p.click('#salir');
  await p.locator('#correo').waitFor();
  await p.click('text=¿Olvidaste la contraseña?');
  await p.locator('h1', { hasText: 'Recuperar contraseña' }).waitFor();
  await p.fill('#correo', 'laura@correo.com');
  await p.click('#f button');
  await p.locator('h2', { hasText: 'Revisa tu correo' }).waitFor();
  await p.click('text=Volver');
  await p.locator('text=¿Primera vez?').waitFor();
  await p.fill('#correo', 'laura@correo.com');
  await p.fill('#clave', 'mala');
  await p.click('#f button[type=submit]');
  await p.locator('.error', { hasText: 'incorrectos' }).waitFor();
  await p.fill('#clave', 'laura123');
  await p.click('#f button[type=submit]');
  await p.locator('h1', { hasText: 'Nueva remesa' }).waitFor();

  paso('la sesión sobrevive a recargar la página');
  await p.reload();
  await p.locator('h1', { hasText: 'Nueva remesa' }).waitFor();

  assert.deepEqual(errores, [], 'errores en la consola');
  console.log('\n— PWA DEL CLIENTE: TODO BIEN —');
} finally {
  await navegador.close();
}
