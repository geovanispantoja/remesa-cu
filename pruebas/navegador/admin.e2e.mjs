// Prueba de punta a punta de la web de admin contra el Supabase local (preparar.sh).
//   node pruebas/navegador/admin.e2e.mjs [carpeta-capturas]
import { createRequire } from 'node:module';
import fs from 'node:fs';
import path from 'node:path';
import assert from 'node:assert/strict';

const require = createRequire(import.meta.url);
const { chromium } = require('playwright');
const AQUI = path.dirname(new URL(import.meta.url).pathname);
const CAPTURAS = process.argv[2] ?? '/tmp/capturas-admin';
fs.mkdirSync(CAPTURAS, { recursive: true });
const BASE = 'http://localhost:8080/admin/';

// supabase-js desde node_modules en lugar del CDN (el navegador de prueba no sale a internet)
const umd = fs.readFileSync(path.join(AQUI, 'node_modules/@supabase/supabase-js/dist/umd/supabase.js'), 'utf8');
const shim = `${umd}\nexport const createClient = supabase.createClient;\n`;

const errores = [];
async function nuevaPagina(navegador, opciones = {}) {
  const ctx = await navegador.newContext({ viewport: { width: 1280, height: 900 }, ...opciones });
  await ctx.route(/cdn\.jsdelivr\.net\/npm\/@supabase\/supabase-js/, (r) => r.fulfill({ contentType: 'text/javascript', body: shim }));
  await ctx.route(/fonts\.(googleapis|gstatic)\.com/, (r) => r.fulfill({ contentType: 'text/css', body: '' }));
  const p = await ctx.newPage();
  p.on('pageerror', (e) => errores.push(`pageerror: ${e.message}`));
  p.on('console', (m) => { if (m.type() === 'error' && !/favicon|Failed to load resource.*(400|404)/.test(m.text())) errores.push(`console: ${m.text()}`); });
  // window.open queda anotado en vez de abrir WhatsApp
  await p.addInitScript(() => { window.__abiertos = []; window.open = (u) => { window.__abiertos.push(u); return null; }; });
  return p;
}
const paso = (t) => console.log('·', t);
const aviso = (p, texto) => p.locator('.aviso-flot', { hasText: texto }).first().waitFor({ timeout: 5000 });
const valor = (p, sel, texto) => p.waitForFunction(([s, t]) => document.querySelector(s)?.value.includes(t), [sel, texto], { timeout: 8000 });
const captura = (p, n) => p.screenshot({ path: path.join(CAPTURAS, n + '.png'), fullPage: true });

const navegador = await chromium.launch();
try {
  const p = await nuevaPagina(navegador);

  paso('entrar');
  await p.goto(BASE);
  await p.fill('#clave', 'mala');
  await p.click('button[type=submit]');
  await p.locator('.error-campo', { hasText: 'incorrectos' }).waitFor();
  await captura(p, '01-entrar');
  await p.fill('#clave', 'admin123');
  await p.click('button[type=submit]');
  await p.locator('h1', { hasText: 'Remesas' }).waitFor();

  paso('panel: KPIs y lista');
  await p.locator('.kpi', { hasText: 'Zelle por confirmar' }).locator('.cifra', { hasText: '$1650' }).waitFor();
  assert.equal(await p.locator('#filas tr').count(), 5, 'por hacer = 5 abiertas');
  const primera = await p.locator('#filas tr').first().innerText();
  assert.match(primera, /REM-0005/, 'la que dice que pagó va primero');
  assert.match(primera, /Dice que pagó/);
  await captura(p, '02-panel');
  await p.fill('#buscar', 'pepe');
  assert.equal(await p.locator('#filas tr').count(), 2, 'Pepe recibe 2 remesas abiertas');
  await p.fill('#buscar', '');

  paso('confirmar Zelle de REM-0005 con menos dinero → pide confirmar');
  await p.locator('#filas tr', { hasText: 'REM-0005' }).click();
  await p.locator('h1', { hasText: 'REM-0005' }).waitFor();
  await valor(p, '#panel-wa textarea', 'deposita exactamente');
  await captura(p, '03-detalle-esperando');
  await p.fill('#recibido', '1000');
  await p.click('[data-accion=confirmar]');
  await p.locator('.ventana', { hasText: 'Llegó menos' }).waitFor();
  await p.click('.ventana [data-no]');
  await p.fill('#recibido', '1100');
  await p.click('[data-accion=confirmar]');
  await aviso(p, 'Zelle confirmado');
  await p.locator('.chip', { hasText: 'Zelle confirmado' }).first().waitFor();
  await valor(p, '#panel-wa textarea', 'recibimos tu Zelle de $1100');

  paso('enviar WhatsApp al cliente (texto editado)');
  await p.locator('#panel-wa textarea').fill('Hola Beto, ya llegó tu Zelle. ¡Gracias!');
  await p.click('#panel-wa [data-enviar]');
  await aviso(p, 'anotado');
  const abiertos = await p.evaluate(() => window.__abiertos);
  assert.equal(abiertos.at(-1), 'https://wa.me/17865559999?text=' + encodeURIComponent('Hola Beto, ya llegó tu Zelle. ¡Gracias!'));

  paso('WhatsApp a la cuenta Zelle');
  await p.locator('#panel-wa .pastilla', { hasText: 'Cuenta Zelle' }).click();
  await p.locator('#panel-wa .pastilla[aria-pressed=true]', { hasText: 'Aviso de depósito' }).waitFor();
  await valor(p, '#panel-wa textarea', 'Hola Carlos Gómez, va a entrar un Zelle de *$1100*');

  paso('programar entrega para hoy');
  await p.click('[data-accion=programar]');
  await aviso(p, 'Fecha guardada');
  await p.locator('.chip', { hasText: 'Entrega programada' }).first().waitFor();
  await valor(p, '#panel-wa textarea', 'se entregará el');

  paso('marcar entregada sin foto → error; con foto → entregada');
  await p.click('[data-accion=entregar]');
  await aviso(p, 'foto del recibo');
  await p.setInputFiles('#recibo', path.join(AQUI, 'recibo-demo.jpg'));
  await p.fill('#nota-entrega', 'Firmó Pepe');
  await p.click('[data-accion=entregar]');
  await aviso(p, 'Entregada');
  await p.locator('h2', { hasText: 'Entregada el' }).waitFor();
  await p.waitForFunction(() => document.querySelector('#foto-recibo')?.naturalWidth > 0, null, { timeout: 5000 });
  assert.match(await p.locator('.historial').innerText(), /Entregada con recibo firmado/);
  await captura(p, '04-detalle-entregada');

  paso('remesa con gestor: pagar comisión desde el detalle (REM-0001, Ana → GES-001)');
  await p.goto(BASE + '#/remesa/1');
  await p.click('[data-accion=pagar-comision]');
  await p.click('.ventana [data-si]');
  await aviso(p, 'Comisión marcada');
  await p.locator('text=Comisión de $20 pagada').waitFor();

  paso('cancelar REM-0003 y corregir');
  await p.goto(BASE + '#/remesa/3');
  await p.click('[data-accion=cancelar]');
  await p.fill('#motivo', 'Prueba de cancelación');
  await p.click('.ventana .boton.peligro');
  await aviso(p, 'cancelada');
  await p.locator('h2', { hasText: 'Cancelada el' }).waitFor();
  await p.click('[data-accion=corregir]');
  await p.selectOption('#estado-nuevo', 'esperando_zelle');
  await p.fill('#motivo-corr', 'Fue un error');
  await p.click('.ventana .boton.primario');
  await aviso(p, 'corregido');
  await p.locator('h2', { hasText: 'confirmar el Zelle' }).waitFor();

  paso('cambiar monto de REM-0003');
  await p.click('[data-accion=ajustar]');
  await p.fill('#nuevo-monto', '250');
  await p.locator('#cotiza', { hasText: 'total Zelle $280' }).waitFor();
  await p.click('.ventana .boton.primario');
  await aviso(p, 'Monto cambiado');
  await p.locator('.dinero .cifra', { hasText: '$280' }).first().waitFor();

  paso('entregas del día');
  await p.goto(BASE + '#/entregas');
  await p.locator('h1', { hasText: 'Entregas' }).waitFor();
  await p.locator('.kpi', { hasText: 'Entregas' }).locator('.cifra', { hasText: '1' }).first().waitFor();
  assert.match(await p.locator('main').innerText(), /Julio Rodríguez/);
  await p.click('[data-avisar]');
  await valor(p, '.ventana textarea', 'Hola Julio Rodríguez');
  await p.click('.ventana [data-enviar]');
  await aviso(p, 'anotado');
  assert.match((await p.evaluate(() => window.__abiertos)).at(-1), /^https:\/\/wa\.me\/5354445555\?text=/);
  await captura(p, '05-entregas');

  paso('nueva remesa manual');
  await p.goto(BASE + '#/nueva');
  await p.fill('#c-nombre', 'Lucía (WhatsApp)');
  await p.fill('#c-wa', '+52 55 1234 5678');
  await p.fill('#f-nombre', 'Mario Gómez');
  await p.fill('#f-dir', 'Calle 5 #20, Reparto Sueño');
  await p.fill('#f-mun', 'Santiago de Cuba');
  await p.fill('#monto', '420');
  await p.locator('#v-total', { hasText: '$470' }).waitFor();
  await p.selectOption('#gestor', 'GES-001');
  await captura(p, '06-nueva');
  await p.click('#form-nueva button[type=submit]');
  await p.locator('h1', { hasText: 'REM-0007' }).waitFor();
  await valor(p, '#panel-wa textarea', 'deposita exactamente *$470*');
  assert.equal(await p.locator('#panel-wa [data-tel]').inputValue(), '+525512345678');

  paso('nueva remesa para cliente con cuenta (familiar guardado)');
  await p.goto(BASE + '#/clientes');
  await p.locator('#filas tr', { hasText: 'Ana Rodríguez' }).getByRole('link', { name: 'Nueva remesa' }).click();
  await p.selectOption('#f-guardado', '0');
  assert.ok((await p.inputValue('#f-nombre')).length > 0);
  assert.equal(await p.inputValue('#gestor'), 'GES-001');

  paso('gestores: pagar y WhatsApp');
  await p.goto(BASE + '#/gestores');
  await p.locator('#nuevo').waitFor();
  await captura(p, '07-gestores');
  await p.click('#nuevo');
  await p.fill('#g-cod', 'ges-003');
  await p.fill('#g-nom', 'Gustavo Nuevo');
  await p.fill('#g-wa', '5 999 0000');
  await p.click('.ventana .boton.primario');
  await aviso(p, 'Gestor guardado');
  await p.locator('td', { hasText: 'Gustavo Nuevo' }).waitFor();
  await p.locator('tr', { hasText: 'Daniel Pérez' }).locator('[data-wa]').click();
  await valor(p, '.ventana textarea', 'Hola Daniel Pérez, este mes');
  await p.click('.ventana .cerrar');

  paso('cuentas Zelle: pausar y WhatsApp pendientes');
  await p.goto(BASE + '#/cuentas');
  await p.locator('.tarjeta', { hasText: 'Clara Díaz' }).locator('[data-pausar]').click();
  await aviso(p, 'pausada');
  await p.locator('.tarjeta', { hasText: 'Clara Díaz' }).locator('.chip', { hasText: 'Pausada' }).waitFor();
  await p.locator('.tarjeta', { hasText: 'Carlos Gómez' }).locator('[data-wa]').click();
  await valor(p, '.ventana textarea', 'REM-0003');
  await p.click('.ventana .cerrar');
  await captura(p, '08-cuentas');

  paso('clientes: cambiar gestor');
  await p.goto(BASE + '#/clientes');
  await p.locator('#filas tr', { hasText: 'Beto' }).locator('[data-gestor]').click();
  await p.selectOption('#cg', { label: 'Dora Martínez · GES-002' });
  await p.click('.ventana .boton.primario');
  await aviso(p, 'Gestor guardado');
  await p.locator('#filas tr', { hasText: 'Beto' }).locator('td', { hasText: 'Dora Martínez' }).waitFor();

  paso('plantillas y ajustes');
  await p.goto(BASE + '#/plantillas');
  const tarjeta = p.locator('[data-clave=cliente_entregada]');
  await tarjeta.locator('[data-texto]').fill('Hola {cliente}, entregado {codigo}.');
  await tarjeta.locator('[data-guardar]').click();
  await aviso(p, 'Plantilla guardada');
  await p.goto(BASE + '#/ajustes');
  await p.locator('#ejemplo', { hasText: 'deposita $390' }).waitFor();
  await captura(p, '09-ajustes');

  paso('salir');
  await p.locator('.lateral [data-salir]').click();
  await p.locator('#clave').waitFor();

  paso('celular: sin scroll horizontal');
  const m = await nuevaPagina(navegador, { viewport: { width: 390, height: 844 }, deviceScaleFactor: 2, isMobile: true, hasTouch: true });
  await m.goto(BASE);
  await m.fill('#clave', 'admin123');
  await m.click('button[type=submit]');
  for (const [ruta, nombre] of [['#/remesas', 'panel'], ['#/remesa/2', 'detalle'], ['#/entregas', 'entregas'], ['#/gestores', 'gestores'], ['#/nueva', 'nueva']]) {
    await m.goto(BASE + ruta);
    await m.locator('main h1').waitFor();
    await m.waitForTimeout(300);
    const ancho = await m.evaluate(() => document.documentElement.scrollWidth);
    assert.ok(ancho <= 391, `${ruta}: ancho ${ancho}px`);
    await captura(m, `m-${nombre}`);
  }

  assert.deepEqual(errores, [], 'errores en la consola');
  console.log('\n— WEB DE ADMIN: TODO BIEN —');
} finally {
  await navegador.close();
}
