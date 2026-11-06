// =====================================================================
// Remesa.cu · Web de administración (B)
// Página estática: corre en GitHub Pages. Habla con Supabase usando
// compartido/remesa-api.js. Sin compilación: se edita y se sube.
// =====================================================================
import { CONFIG, CONFIG_LISTA, SUPABASE_JS } from '../compartido/config.js';
import {
  crearApiAdmin, fmtUsd, calcularTarifa, validarMonto, normalizarTelefono, enlaceWhatsApp, ESTADOS, FRANJAS,
} from '../compartido/remesa-api.js';

const app = document.getElementById('app');
let sb, api;
let haySesion = false;
let turno = 0;
const cache = {};
let plantillaSugerida = null; // la próxima vista de detalle abre el WhatsApp con esta plantilla

// ------------------------------------------------------------------ utilidades
const esc = (v) => String(v ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const usd = (n) => (n == null ? '—' : '$' + fmtUsd(n));
const hoy = () => new Date().toLocaleDateString('en-CA', { timeZone: 'America/Havana' });
const fechaHora = (ts) => (ts ? new Date(ts).toLocaleString('es', {
  timeZone: 'America/Havana', day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' }) : '');
const fechaLarga = (d) => (d ? new Date(d + 'T12:00:00').toLocaleDateString('es', { weekday: 'long', day: 'numeric', month: 'long' }) : 'sin fecha');
const fechaCorta = (d) => (d ? new Date(d + 'T12:00:00').toLocaleDateString('es', { weekday: 'short', day: 'numeric', month: 'short' }) : '');
const telVisible = (t) => (t ? '+' + t : '');
const CLASE = { esperando_zelle: 'e1', zelle_confirmado: 'e2', entrega_programada: 'e3', entregada: 'e4', cancelada: 'e0' };
const chipEstado = (e) => `<span class="chip ${CLASE[e]}">${esc(ESTADOS[e]?.texto ?? e)}</span>`;
const $ = (sel, raiz = document) => raiz.querySelector(sel);
const $$ = (sel, raiz = document) => [...raiz.querySelectorAll(sel)];

const ICONOS = {
  remesas: '<path d="M4 6h16M4 12h16M4 18h10"/>',
  entregas: '<path d="M3 7h11v9H3zM14 10h4l3 3v3h-7"/><circle cx="7" cy="17.5" r="1.8"/><circle cx="17" cy="17.5" r="1.8"/>',
  nueva: '<path d="M12 5v14M5 12h14"/>',
  gestores: '<circle cx="9" cy="8" r="3.5"/><path d="M2.5 20c1-3.5 3.5-5 6.5-5s5.5 1.5 6.5 5"/><path d="M16 4.5a3.5 3.5 0 010 7M18 15c2 .6 3.2 2.2 3.8 5"/>',
  cuentas: '<rect x="3" y="6" width="18" height="13" rx="2"/><path d="M3 10h18M7 15h4"/>',
  clientes: '<circle cx="12" cy="8" r="4"/><path d="M4 21c1.5-4 4.5-6 8-6s6.5 2 8 6"/>',
  plantillas: '<path d="M21 12a8.5 8.5 0 01-12.6 7.4L3 21l1.7-5.2A8.5 8.5 0 1121 12z"/>',
  ajustes: '<circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.7 1.7 0 00.3 1.8l.1.1a2 2 0 11-2.8 2.8l-.1-.1a1.7 1.7 0 00-1.8-.3 1.7 1.7 0 00-1 1.5V21a2 2 0 11-4 0v-.1a1.7 1.7 0 00-1.1-1.5 1.7 1.7 0 00-1.8.3l-.1.1a2 2 0 11-2.8-2.8l.1-.1a1.7 1.7 0 00.3-1.8 1.7 1.7 0 00-1.5-1H3a2 2 0 110-4h.1a1.7 1.7 0 001.5-1.1 1.7 1.7 0 00-.3-1.8l-.1-.1a2 2 0 112.8-2.8l.1.1a1.7 1.7 0 001.8.3H9a1.7 1.7 0 001-1.5V3a2 2 0 114 0v.1a1.7 1.7 0 001 1.5 1.7 1.7 0 001.8-.3l.1-.1a2 2 0 112.8 2.8l-.1.1a1.7 1.7 0 00-.3 1.8V9a1.7 1.7 0 001.5 1H21a2 2 0 110 4h-.1a1.7 1.7 0 00-1.5 1z"/>',
};
const icono = (n) => `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${ICONOS[n]}</svg>`;

function aviso(texto, error = false) {
  const el = document.createElement('div');
  el.className = 'aviso-flot' + (error ? ' error' : '');
  el.textContent = texto;
  $('#avisos').append(el);
  setTimeout(() => el.remove(), error ? 6000 : 3200);
}

/** Desactiva el botón mientras corre la acción y muestra el error si falla. */
async function ocupado(boton, fn) {
  if (boton?.disabled) return;
  const antes = boton?.innerHTML;
  if (boton) { boton.disabled = true; boton.textContent = 'Un momento…'; }
  try {
    return await fn();
  } catch (e) {
    aviso(e.message ?? String(e), true);
    throw e;
  } finally {
    if (boton && boton.isConnected) { boton.disabled = false; boton.innerHTML = antes; }
  }
}
const intentar = (boton, fn) => ocupado(boton, fn).catch(() => {});

function ventana(titulo, cuerpoHtml) {
  const velo = document.createElement('div');
  velo.className = 'velo';
  velo.innerHTML = `<div class="ventana" role="dialog" aria-modal="true" aria-label="${esc(titulo)}">
    <div class="titulo"><h2>${esc(titulo)}</h2><button type="button" class="cerrar" aria-label="Cerrar">×</button></div>
    ${cuerpoHtml}</div>`;
  const cerrar = () => { velo.remove(); document.removeEventListener('keydown', tecla); };
  const tecla = (e) => { if (e.key === 'Escape') cerrar(); };
  velo.addEventListener('click', (e) => { if (e.target === velo) cerrar(); });
  $('.cerrar', velo).addEventListener('click', cerrar);
  document.addEventListener('keydown', tecla);
  document.body.append(velo);
  setTimeout(() => $('input:not([type=hidden]), textarea, select', velo)?.focus(), 30);
  return { el: $('.ventana', velo), cerrar };
}

function confirmar(titulo, texto, { boton = 'Sí, seguir', peligro = false } = {}) {
  return new Promise((ok) => {
    const v = ventana(titulo, `<p style="margin:0">${texto}</p>
      <div class="fila" style="justify-content:flex-end">
        <button type="button" class="boton" data-no>Volver</button>
        <button type="button" class="boton ${peligro ? 'peligro' : 'primario'}" data-si>${esc(boton)}</button>
      </div>`);
    $('[data-no]', v.el).onclick = () => { v.cerrar(); ok(false); };
    $('[data-si]', v.el).onclick = () => { v.cerrar(); ok(true); };
  });
}

// ------------------------------------------------------------------ catálogos (con caché)
async function cat(nombre, forzar = false) {
  if (forzar || !cache[nombre]) {
    cache[nombre] = await ({
      gestores: () => api.gestores(),
      cuentas: () => api.cuentasZelle(),
      plantillas: () => api.plantillas(),
      config: async () => Object.fromEntries((await api.configuracion()).map((c) => [c.clave, c.valor])),
    })[nombre]();
  }
  return cache[nombre];
}
const olvidar = (...nombres) => nombres.forEach((n) => delete cache[n]);

// ------------------------------------------------------------------ arranque y rutas
const MENU = [
  ['remesas', 'Remesas'], ['entregas', 'Entregas'], ['nueva', 'Nueva remesa'], ['gestores', 'Gestores'],
  ['cuentas', 'Cuentas Zelle'], ['clientes', 'Clientes'], ['plantillas', 'Plantillas WhatsApp'], ['ajustes', 'Ajustes'],
];
const VISTAS = {
  remesas: vistaRemesas, remesa: vistaRemesa, entregas: vistaEntregas, nueva: vistaNueva, gestores: vistaGestores,
  cuentas: vistaCuentas, clientes: vistaClientes, plantillas: vistaPlantillas, ajustes: vistaAjustes,
};

function leerRuta() {
  const [camino, consulta] = location.hash.replace(/^#\/?/, '').split('?');
  const [nombre, id] = (camino || 'remesas').split('/');
  return { nombre: VISTAS[nombre] ? nombre : 'remesas', id, q: new URLSearchParams(consulta ?? '') };
}

function pintarMarco() {
  if ($('.marco')) return;
  const enlaces = MENU.map(([r, t]) => `<a href="#/${r}" data-ruta="${r}">${icono(r)}<span>${t}</span></a>`).join('');
  app.innerHTML = `
  <div class="marco">
    <header class="barra-movil">
      <div class="arriba"><div class="marca">Remesa<span>.cu</span> <small>admin</small></div>
        <div class="fila"><button type="button" class="salir" data-wa-libre>WhatsApp</button><button type="button" class="salir" data-salir>Salir</button></div></div>
      <nav class="nav" aria-label="Secciones">${enlaces}</nav>
    </header>
    <aside class="lateral">
      <div class="marca">Remesa<span>.cu</span> <small>admin</small></div>
      <nav class="nav" aria-label="Secciones">${enlaces}</nav>
      <div class="pie">
        <button type="button" data-wa-libre>WhatsApp a cualquier número</button>
        <button type="button" data-salir>Cerrar sesión</button>
      </div>
    </aside>
    <main class="principal" id="contenido"></main>
  </div>`;
  $$('[data-salir]').forEach((b) => b.addEventListener('click', async () => {
    await api.salir().catch(() => {});
    haySesion = false;
    Object.keys(cache).forEach((k) => delete cache[k]);
    navegar();
  }));
  $$('[data-wa-libre]').forEach((b) => b.addEventListener('click', () => ventanaWhatsApp({ destinos: [{ dest: 'otro', etiqueta: 'Otro' }] })));
}

async function navegar() {
  const mio = ++turno;
  if (!haySesion) return vistaEntrar();
  pintarMarco();
  const r = leerRuta();
  const activa = r.nombre === 'remesa' ? 'remesas' : r.nombre;
  $$('.nav a').forEach((a) => (a.dataset.ruta === activa ? a.setAttribute('aria-current', 'page') : a.removeAttribute('aria-current')));
  const main = $('#contenido');
  main.innerHTML = '<div class="cargando">Cargando…</div>';
  const ctx = {
    r, main,
    vivo: () => mio === turno,
    pintar(html) { if (mio !== turno) throw new Error('__viejo'); main.innerHTML = html; },
  };
  try {
    await VISTAS[r.nombre](ctx);
    window.scrollTo({ top: 0 });
  } catch (e) {
    if (e.message === '__viejo' || mio !== turno) return;
    if (/sesión venció|JWT/i.test(e.message)) { haySesion = false; return navegar(); }
    main.innerHTML = `<div class="tarjeta alerta"><h2>No se pudo cargar</h2><p class="nota">${esc(e.message)}</p>
      <div><button class="boton" type="button" onclick="location.reload()">Reintentar</button></div></div>`;
  }
}

async function iniciar() {
  if (!CONFIG_LISTA) {
    app.innerHTML = `<div class="entrar"><div class="ventana"><h2>Falta configurar la conexión</h2>
      <p class="nota">Edita <code>compartido/config.js</code> en GitHub y pon la URL de tu proyecto de Supabase y la
      <em>publishable key</em> (sb_publishable_…). Luego recarga esta página.</p></div></div>`;
    return;
  }
  const { createClient } = await import(SUPABASE_JS);
  sb = createClient(CONFIG.supabaseUrl, CONFIG.supabaseKey, { auth: { storageKey: 'remesa-admin' } });
  api = crearApiAdmin(sb, { correoAdmin: CONFIG.correoAdmin });
  try {
    if (await api.sesion()) haySesion = await api.esAdmin();
  } catch { haySesion = false; }
  sb.auth.onAuthStateChange((evento) => {
    if (evento === 'SIGNED_OUT' && haySesion) { haySesion = false; navegar(); }
  });
  window.addEventListener('hashchange', navegar);
  navegar();
}

// ------------------------------------------------------------------ entrar
function vistaEntrar() {
  app.innerHTML = `<div class="entrar"><form novalidate>
    <div class="marca">Remesa<span>.cu</span></div>
    <p class="nota" style="margin-top:-8px">Administración</p>
    <div class="campo"><label for="clave">Contraseña</label>
      <input id="clave" type="password" autocomplete="current-password" required></div>
    <p class="error-campo" hidden></p>
    <button class="boton primario ancho" type="submit">Entrar</button>
  </form></div>`;
  const form = $('form', app);
  $('#clave').focus();
  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    const err = $('.error-campo', form);
    err.hidden = true;
    const clave = $('#clave').value;
    if (!clave) { err.textContent = 'Escribe la contraseña'; err.hidden = false; return; }
    const b = $('button', form);
    b.disabled = true; b.textContent = 'Entrando…';
    try {
      await api.entrar(clave);
      haySesion = true;
      navegar();
    } catch (ex) {
      err.textContent = ex.message; err.hidden = false;
      b.disabled = false; b.textContent = 'Entrar';
    }
  });
}

// ------------------------------------------------------------------ remesas (panel)
const PESTANAS = [
  ['pendientes', 'Por hacer'], ['esperando_zelle', 'Esperando Zelle'], ['zelle_confirmado', 'Zelle confirmado'],
  ['entrega_programada', 'Programadas'], ['entregada', 'Entregadas'], ['cancelada', 'Canceladas'], ['todas', 'Todas'],
];
const ABIERTA = (r) => r.estado !== 'entregada' && r.estado !== 'cancelada';

function prioridad(r) {
  if (r.estado === 'esperando_zelle' && r.cliente_reporto_pago_at) return 0;
  if (r.estado === 'zelle_confirmado') return 1;
  if (r.estado === 'entrega_programada') return 2;
  return 3;
}

function siguientePaso(r) {
  switch (r.estado) {
    case 'esperando_zelle': return r.cliente_reporto_pago_at ? 'Dice que depositó: confirmar con C' : 'Esperando que A deposite';
    case 'zelle_confirmado': return 'Ponerle fecha de entrega';
    case 'entrega_programada': return r.fecha_entrega === hoy() ? 'Entregar HOY' : `Entregar el ${fechaCorta(r.fecha_entrega)}`;
    case 'entregada': return r.gestor_id && r.comision_gestor > 0 && !r.comision_pagada_at ? 'Falta pagar comisión al gestor' : 'Listo';
    default: return r.motivo_cancelacion ?? '';
  }
}

function filaRemesa(r) {
  const extra = r.estado === 'esperando_zelle' && r.cliente_reporto_pago_at ? ' <span class="chip aviso">Dice que pagó</span>' : '';
  return `<tr class="clic" data-id="${r.id}">
    <td><strong>${esc(r.codigo)}</strong><span class="sub">${esc(r.cliente_nombre)}</span></td>
    <td data-m="der" class="der"><strong>${usd(r.monto_entrega)}</strong><span class="sub">Zelle ${usd(r.total_zelle)}</span></td>
    <td data-m="todo">${esc(r.beneficiario_nombre)}<span class="sub">${esc([r.beneficiario_municipio, r.beneficiario_provincia].filter(Boolean).join(', ') || r.beneficiario_direccion)}</span></td>
    <td data-m="todo">${chipEstado(r.estado)}${extra}<span class="sub">${esc(siguientePaso(r))}</span></td>
    <td data-m="ocultar" class="der"><span class="sub">${esc(fechaHora(r.creado_at))}</span></td>
  </tr>`;
}

async function vistaRemesas(ctx) {
  const ver = ctx.r.q.get('ver') ?? 'pendientes';
  const [res, lista] = await Promise.all([api.resumen(), api.remesas({ limite: 500 })]);
  const cuenta = (clave) => (clave === 'todas' ? lista.length : clave === 'pendientes' ? lista.filter(ABIERTA).length
    : lista.filter((r) => r.estado === clave).length);

  ctx.pintar(`
    <div class="cabeza">
      <div><h1>Remesas</h1><p>Lo que hay que hacer, primero</p></div>
      <div class="fila"><a class="boton" href="#/entregas">Entregas de hoy</a><a class="boton primario" href="#/nueva">+ Remesa manual</a></div>
    </div>
    <section class="kpis" aria-label="Resumen">
      <a class="kpi" href="#/remesas?ver=esperando_zelle"><span class="etq">Zelle por confirmar</span><span class="cifra">${usd(res.zelle_por_confirmar_total)}</span><span class="sub">${res.zelle_por_confirmar_n} remesa(s)</span></a>
      <a class="kpi" href="#/entregas"><span class="etq">Efectivo por entregar</span><span class="cifra">${usd(res.efectivo_por_entregar)}</span><span class="sub">${res.entregas_hoy} entrega(s) hoy</span></a>
      <div class="kpi"><span class="etq">Entregadas este mes</span><span class="cifra">${res.entregadas}</span><span class="sub">${usd(res.monto_entregado)} en efectivo</span></div>
      <div class="kpi"><span class="etq">Ganancia neta del mes</span><span class="cifra">${usd(res.ganancia_neta)}</span><span class="sub">tarifas ${usd(res.tarifas_cobradas)} − comisiones ${usd(res.comisiones_generadas)}</span></div>
      <a class="kpi" href="#/gestores"><span class="etq">Comisiones por pagar</span><span class="cifra">${usd(res.comisiones_por_pagar)}</span><span class="sub">en efectivo a gestores</span></a>
    </section>
    <div class="fila" style="justify-content:space-between">
      <div class="pastillas" role="group" aria-label="Filtrar por estado">
        ${PESTANAS.map(([k, t]) => `<a class="pastilla" href="#/remesas?ver=${k}" aria-pressed="${k === ver}">${t} (${cuenta(k)})</a>`).join('')}
      </div>
      <input type="search" id="buscar" placeholder="Buscar código, cliente o familiar" aria-label="Buscar" style="max-width:300px">
    </div>
    <section class="tarjeta sin-relleno"><div class="desplazable">
      <table class="lista responsiva">
        <thead><tr><th>Remesa</th><th class="der">Entregar</th><th>Recibe</th><th>Estado</th><th class="der">Creada</th></tr></thead>
        <tbody id="filas"></tbody>
      </table>
    </div></section>`);

  const tbody = $('#filas');
  const dibujar = () => {
    const b = $('#buscar').value.trim().toLowerCase();
    let filas = lista.filter((r) => (ver === 'todas' ? true : ver === 'pendientes' ? ABIERTA(r) : r.estado === ver));
    if (b) filas = filas.filter((r) => [r.codigo, r.cliente_nombre, r.beneficiario_nombre, r.cliente_whatsapp]
      .some((v) => (v ?? '').toLowerCase().includes(b)));
    if (ver === 'pendientes' || ver === 'entrega_programada') {
      filas.sort((a, z) => prioridad(a) - prioridad(z) || (a.fecha_entrega ?? '').localeCompare(z.fecha_entrega ?? '')
        || a.creado_at.localeCompare(z.creado_at));
    }
    tbody.innerHTML = filas.length ? filas.map(filaRemesa).join('')
      : `<tr><td colspan="5"><div class="vacio">${b ? 'Nada coincide con la búsqueda' : 'No hay remesas aquí'}</div></td></tr>`;
  };
  dibujar();
  $('#buscar').addEventListener('input', dibujar);
  tbody.addEventListener('click', (e) => {
    const tr = e.target.closest('tr[data-id]');
    if (tr) location.hash = `#/remesa/${tr.dataset.id}`;
  });
}

// ------------------------------------------------------------------ detalle de una remesa
const TEXTO_EVENTO = {
  creada: (d) => `Remesa creada${d.origen === 'admin' ? ' a mano' : ' por el cliente'}: ${usd(d.monto)} + ${usd(d.tarifa)} = ${usd(d.total)}`,
  comision_calculada: (d) => `Comisión del gestor: ${usd(d.comision)} (${fmtUsd(d.pct)}%)`,
  pago_reportado: (d) => `El cliente avisó que depositó${d.con_captura ? ' (con captura)' : ''}`,
  zelle_confirmado: (d) => `Zelle confirmado: llegaron ${usd(d.recibido)}`,
  diferencia_zelle: (d) => `Diferencia en el Zelle: ${d.diferencia > 0 ? '+' : ''}${usd(d.diferencia)}`,
  entrega_programada: (d) => `Entrega programada: ${fechaLarga(d.fecha)} · ${FRANJAS[d.franja] ?? ''}`,
  entrega_reprogramada: (d) => `Entrega cambiada a ${fechaLarga(d.fecha)} · ${FRANJAS[d.franja] ?? ''}`,
  entregada: (d) => `Entregada${d.con_recibo ? ' con recibo firmado' : ''}`,
  cancelada: (d) => `Cancelada por ${d.por === 'cliente' ? 'el cliente' : 'el admin'}: ${d.motivo ?? ''}`,
  devolver_zelle: (d) => `Hay que devolver el Zelle${d.monto ? ` (${usd(d.monto)})` : ''}`,
  comision_pagada: () => 'Comisión pagada al gestor',
  gestor_asignado: (d) => (d.gestor_id ? `Gestor cambiado · comisión ${usd(d.comision)}` : 'Gestor quitado'),
  cuenta_zelle_cambiada: (d) => `Cuenta Zelle cambiada a ${d.titular}`,
  monto_ajustado: (d) => `Monto cambiado de ${usd(d.antes)} a ${usd(d.monto)} (total ${usd(d.total)})`,
  estado_corregido: (d) => `Estado corregido de "${ESTADOS[d.de]?.texto}" a "${ESTADOS[d.a]?.texto}": ${d.motivo}`,
  whatsapp: (d) => `WhatsApp a ${({ cliente: 'cliente', zelle: 'cuenta Zelle', gestor: 'gestor', beneficiario: 'familiar' })[d.destinatario] ?? d.destinatario}${d.plantilla ? ` (${d.plantilla.replaceAll('_', ' ')})` : ''}`,
};
const textoEvento = (e) => esc((TEXTO_EVENTO[e.tipo] ?? (() => e.tipo))(e.detalle ?? {}));

const PLANTILLA_POR_ESTADO = {
  cliente: { esperando_zelle: 'cliente_datos_zelle', zelle_confirmado: 'cliente_zelle_recibido', entrega_programada: 'cliente_fecha_entrega', entregada: 'cliente_entregada' },
  zelle: { esperando_zelle: 'zelle_aviso_deposito' },
  gestor: { entregada: 'gestor_comision_lista' },
  beneficiario: { entrega_programada: 'beneficiario_aviso_entrega' },
};

function tarjetaPaso(r) {
  const fechaMin = hoy();
  const formEntrega = `
    <div class="separador"></div>
    <h3>Marcar entregada</h3>
    <div class="campo"><label for="recibo">Foto del recibo firmado</label>
      <input id="recibo" type="file" accept="image/*,application/pdf" capture="environment"></div>
    <div class="campo"><label for="nota-entrega">Nota (opcional)</label><input id="nota-entrega" type="text" placeholder="Ej. firmó la nieta"></div>
    <button class="boton primario" type="button" data-accion="entregar">Marcar entregada</button>`;
  const formFecha = (boton) => `
    <div class="fila" style="align-items:flex-end">
      <div class="campo"><label for="fecha">Fecha</label><input id="fecha" type="date" min="${fechaMin}" value="${esc(r.fecha_entrega ?? fechaMin)}"></div>
      <div class="campo"><label for="franja">Horario</label><select id="franja">
        ${Object.entries(FRANJAS).map(([k, t]) => `<option value="${k}" ${k === (r.franja ?? 'todo_el_dia') ? 'selected' : ''}>${t}</option>`).join('')}
      </select></div>
      <button class="boton ${r.estado === 'zelle_confirmado' ? 'primario' : ''}" type="button" data-accion="programar">${boton}</button>
    </div>`;

  switch (r.estado) {
    case 'esperando_zelle':
      return `<section class="tarjeta destacada">
        <h2>Siguiente paso: confirmar el Zelle</h2>
        ${r.cliente_reporto_pago_at ? `<p class="nota"><span class="chip aviso">El cliente dice que depositó</span> ${esc(fechaHora(r.cliente_reporto_pago_at))}
          ${r.comprobante_pago_path ? ' · <button class="boton chico" type="button" data-accion="ver-captura">Ver captura</button>' : ''}</p>` : ''}
        <p class="nota">Pregúntale a <strong>${esc(r.zelle_titular ?? 'la cuenta Zelle')}</strong> si llegaron <strong>${usd(r.total_zelle)}</strong> con el memo <strong>${esc(r.codigo)}</strong>.</p>
        <div class="fila" style="align-items:flex-end">
          <div class="campo" style="max-width:180px"><label for="recibido">Monto que llegó</label>
            <input id="recibido" type="number" inputmode="decimal" min="1" step="0.01" value="${esc(r.total_zelle)}"></div>
          <button class="boton primario" type="button" data-accion="confirmar">Confirmar Zelle recibido</button>
        </div>
        <p class="error-campo" id="error-confirmar" hidden></p>
      </section>`;
    case 'zelle_confirmado':
      return `<section class="tarjeta destacada">
        <h2>Siguiente paso: fecha de entrega</h2>
        <p class="nota">Llegaron ${usd(r.zelle_monto_recibido)} el ${esc(fechaHora(r.zelle_confirmado_at))}. Hay que entregar <strong>${usd(r.monto_entrega)}</strong> en efectivo.</p>
        ${formFecha('Guardar fecha')}
        ${formEntrega}
      </section>`;
    case 'entrega_programada':
      return `<section class="tarjeta destacada">
        <h2>Entregar ${usd(r.monto_entrega)} el ${esc(fechaLarga(r.fecha_entrega))}</h2>
        <p class="nota">${esc(FRANJAS[r.franja] ?? '')} · ${esc(r.beneficiario_direccion)}</p>
        ${formEntrega}
        <div class="separador"></div>
        <h3>Cambiar la fecha</h3>
        ${formFecha('Cambiar fecha')}
      </section>`;
    case 'entregada': {
      const debe = r.gestor_id && r.comision_gestor > 0 && !r.comision_pagada_at;
      return `<section class="tarjeta">
        <div class="titulo"><h2>Entregada el ${esc(fechaHora(r.entregada_at))}</h2>${chipEstado('entregada')}</div>
        ${r.nota_entrega ? `<p class="nota">${esc(r.nota_entrega)}</p>` : ''}
        ${r.recibo_path ? '<img class="foto" id="foto-recibo" alt="Recibo firmado">' : '<p class="nota">Sin foto de recibo.</p>'}
        ${r.gestor_id && r.comision_gestor > 0 ? (debe
          ? `<div class="fila"><span class="chip aviso">Comisión pendiente: ${usd(r.comision_gestor)}</span>
             <button class="boton" type="button" data-accion="pagar-comision">Marcar comisión pagada</button></div>`
          : `<p class="nota">Comisión de ${usd(r.comision_gestor)} pagada el ${esc(fechaHora(r.comision_pagada_at))}.</p>`) : ''}
      </section>`;
    }
    default:
      return `<section class="tarjeta alerta">
        <h2>Cancelada el ${esc(fechaHora(r.cancelada_at))}</h2>
        <p class="nota">${esc(r.motivo_cancelacion ?? '')}</p>
        ${r.zelle_confirmado_at ? '<p class="nota"><strong>Ojo:</strong> el Zelle ya se había confirmado; recuerda devolverlo.</p>' : ''}
      </section>`;
  }
}

async function vistaRemesa(ctx) {
  const id = Number(ctx.r.id);
  const [r, eventos, gestores, cuentas] = await Promise.all([api.remesa(id), api.historial(id), cat('gestores'), cat('cuentas')]);
  const gestor = gestores.find((g) => g.id === r.gestor_id);
  const sugerida = plantillaSugerida; plantillaSugerida = null;

  ctx.pintar(`
    <div class="cabeza">
      <div><div class="fila"><a href="#/remesas" style="font-size:14px;font-weight:600;text-decoration:none">← Remesas</a></div>
        <div class="fila"><h1>Remesa ${esc(r.codigo)}</h1>${chipEstado(r.estado)}</div>
        <p>Creada ${esc(fechaHora(r.creado_at))}${r.cliente_id ? '' : ' · hecha a mano'}</p></div>
    </div>
    <div class="columnas">
      <div class="col-a">
        <div class="primero" style="display:flex;flex-direction:column">${tarjetaPaso(r)}</div>
        <section class="tarjeta">
          <div class="datos">
            <div class="dato"><span class="etq">Cliente (A)</span><span class="val">${esc(r.cliente_nombre)}</span>
              <span class="sub">${r.cliente_whatsapp ? `<a href="${esc(enlaceWhatsApp(r.cliente_whatsapp))}" target="_blank" rel="noopener">${esc(telVisible(r.cliente_whatsapp))}</a>` : 'sin WhatsApp'}</span></div>
            <div class="dato"><span class="etq">Recibe en Cuba</span><span class="val">${esc(r.beneficiario_nombre)}</span>
              <span class="sub">${esc(r.beneficiario_direccion)}${r.beneficiario_municipio ? ', ' + esc(r.beneficiario_municipio) : ''}${r.beneficiario_provincia ? ', ' + esc(r.beneficiario_provincia) : ''}</span>
              ${r.beneficiario_telefono ? `<span class="sub"><a href="tel:+${esc(normalizarTelefono(r.beneficiario_telefono))}">${esc(r.beneficiario_telefono)}</a></span>` : ''}</div>
            <div class="dato"><span class="etq">Cuenta Zelle (C)</span><span class="val">${esc(r.zelle_titular ?? 'Sin asignar')}</span><span class="sub">${esc(r.zelle_contacto ?? '')}</span></div>
            <div class="dato"><span class="etq">Gestor (D)</span><span class="val">${esc(gestor ? gestor.nombre : 'Sin gestor')}</span><span class="sub">${esc(gestor?.codigo ?? '')}</span></div>
          </div>
          ${r.nota_cliente ? `<p class="nota"><strong>Nota del cliente:</strong> ${esc(r.nota_cliente)}</p>` : ''}
        </section>
        <section class="tarjeta">
          <h2>Dinero</h2>
          <div class="dinero">
            <div><div class="etq">Entregar en efectivo</div><div class="cifra">${usd(r.monto_entrega)}</div></div>
            <div><div class="etq">Tarifa</div><div class="cifra">${usd(r.tarifa)}</div></div>
            <div><div class="etq">Total Zelle</div><div class="cifra">${usd(r.total_zelle)}</div></div>
            ${r.zelle_monto_recibido != null ? `<div><div class="etq">Llegó</div><div class="cifra">${usd(r.zelle_monto_recibido)}</div></div>` : ''}
            <div class="comision"><div class="etq">Comisión gestor</div><div class="cifra">${usd(r.comision_gestor)}</div></div>
            <div class="ganancia"><div class="etq">Ganancia tuya</div><div class="cifra">${usd(r.ganancia_neta)}</div></div>
          </div>
        </section>
        <section class="tarjeta">
          <h2>Historial</h2>
          <ul class="historial">${eventos.map((e) => `<li><time>${esc(fechaHora(e.creado_at))}</time><span>${textoEvento(e)}${e.visible_cliente ? '' : '<span class="privado">interno</span>'}</span></li>`).join('')}</ul>
        </section>
        <section class="tarjeta">
          <div class="campo"><label for="notas">Notas internas (el cliente no las ve)</label>
            <textarea id="notas" rows="3">${esc(r.notas_admin ?? '')}</textarea></div>
          <div><button class="boton chico" type="button" data-accion="guardar-notas">Guardar notas</button></div>
        </section>
        <section class="tarjeta">
          <h2>Más acciones</h2>
          <div class="fila">
            ${r.estado === 'esperando_zelle' ? '<button class="boton chico" type="button" data-accion="ajustar">Cambiar monto</button><button class="boton chico" type="button" data-accion="cuenta">Cambiar cuenta Zelle</button>' : ''}
            ${!r.comision_pagada_at ? '<button class="boton chico" type="button" data-accion="gestor">Cambiar gestor</button>' : ''}
            ${r.estado !== 'entregada' && r.estado !== 'cancelada' ? '<button class="boton chico peligro" type="button" data-accion="cancelar">Cancelar remesa</button>' : ''}
            <button class="boton chico" type="button" data-accion="corregir">Corregir estado</button>
          </div>
        </section>
      </div>
      <div class="col-b"><section class="tarjeta segundo" id="panel-wa"></section></div>
    </div>`);

  const main = ctx.main;
  const recargar = () => navegar();

  // WhatsApp
  const destinos = [
    { dest: 'cliente', etiqueta: 'Cliente (A)' },
    { dest: 'zelle', etiqueta: 'Cuenta Zelle (C)' },
    ...(r.gestor_id ? [{ dest: 'gestor', etiqueta: 'Gestor (D)' }] : []),
    { dest: 'beneficiario', etiqueta: 'Familiar' },
  ].map((d) => ({ ...d, contexto: { remesaId: r.id }, plantilla: PLANTILLA_POR_ESTADO[d.dest]?.[r.estado] }));
  let inicial = destinos[0];
  if (sugerida) {
    const d = destinos.find((x) => sugerida.startsWith(x.dest));
    if (d) inicial = { ...d, plantilla: sugerida };
  }
  panelWhatsApp($('#panel-wa', main), { destinos, inicial });

  if (r.recibo_path) api.urlArchivo('recibos', r.recibo_path).then((u) => { const img = $('#foto-recibo', main); if (img) img.src = u; }).catch(() => {});

  const en = (accion, fn) => $$(`[data-accion="${accion}"]`, main).forEach((b) => b.addEventListener('click', () => fn(b)));

  en('ver-captura', (b) => intentar(b, async () => {
    const url = await api.urlArchivo('comprobantes', r.comprobante_pago_path);
    ventana('Captura del Zelle', `<img class="foto" src="${esc(url)}" alt="Captura del Zelle"><a class="boton" href="${esc(url)}" target="_blank" rel="noopener">Abrir en grande</a>`);
  }));

  en('confirmar', (b) => {
    const recibido = Number($('#recibido', main).value);
    const err = $('#error-confirmar', main);
    err.hidden = true;
    const hacer = (forzar) => intentar(b, async () => {
      await api.confirmarZelle(r.id, recibido, forzar);
      plantillaSugerida = 'cliente_zelle_recibido';
      aviso('Zelle confirmado. Avísale al cliente.');
      recargar();
    });
    if (recibido < Number(r.total_zelle)) {
      confirmar('Llegó menos de lo esperado', `Llegaron <strong>${usd(recibido)}</strong> pero el total es <strong>${usd(r.total_zelle)}</strong>. ¿Confirmar de todos modos? Si no, cambia primero el monto de la remesa.`, { boton: 'Confirmar igual' })
        .then((si) => si && hacer(true));
    } else hacer(false);
  });

  en('programar', (b) => intentar(b, async () => {
    const fecha = $('#fecha', main).value;
    if (!fecha) throw new Error('Elige la fecha');
    await api.programarEntrega(r.id, fecha, $('#franja', main).value);
    plantillaSugerida = 'cliente_fecha_entrega';
    aviso('Fecha guardada. Avísale al cliente.');
    recargar();
  }));

  en('entregar', (b) => intentar(b, async () => {
    const archivo = $('#recibo', main).files[0] ?? null;
    if (!archivo && (await cat('config')).exigir_recibo === 'si') throw new Error('Toma o elige la foto del recibo firmado');
    await api.marcarEntregada(r.id, archivo, $('#nota-entrega', main).value || null);
    plantillaSugerida = 'cliente_entregada';
    aviso('¡Entregada! Mándale el aviso al cliente.');
    recargar();
  }));

  en('pagar-comision', async (b) => {
    if (!(await confirmar('Pagar comisión', `¿Ya le diste <strong>${usd(r.comision_gestor)}</strong> en efectivo a ${esc(gestor?.nombre ?? 'el gestor')}?`, { boton: 'Sí, ya se lo di' }))) return;
    intentar(b, async () => { await api.pagarComisiones(r.gestor_id, [r.id]); aviso('Comisión marcada como pagada'); recargar(); });
  });

  en('guardar-notas', (b) => intentar(b, async () => { await api.guardarNota(r.id, $('#notas', main).value); aviso('Notas guardadas'); }));

  en('ajustar', () => {
    const v = ventana('Cambiar monto a entregar', `
      <div class="campo"><label for="nuevo-monto">Monto a entregar en Cuba (USD)</label>
        <input id="nuevo-monto" type="number" inputmode="numeric" min="1" step="1" value="${esc(r.monto_entrega)}"></div>
      <p class="nota" id="cotiza"></p>
      <button class="boton primario" type="button">Guardar</button>`);
    const inp = $('#nuevo-monto', v.el);
    const mostrar = async () => { const c = await cat('config'); const t = calcularTarifa(inp.value, c); $('#cotiza', v.el).textContent = `Tarifa ${usd(t)} · total Zelle ${usd(Number(inp.value) + t)}`; };
    inp.addEventListener('input', mostrar); mostrar();
    $('button.primario', v.el).onclick = (e) => intentar(e.currentTarget, async () => {
      await api.ajustarMonto(r.id, Number(inp.value)); v.cerrar(); aviso('Monto cambiado. Mándale los datos nuevos al cliente.');
      plantillaSugerida = 'cliente_datos_zelle'; recargar();
    });
  });

  en('cuenta', () => {
    const v = ventana('Cambiar cuenta Zelle', `
      <div class="campo"><label for="nueva-cuenta">Cuenta</label><select id="nueva-cuenta">
        ${cuentas.map((c) => `<option value="${c.id}" ${c.id === r.cuenta_zelle_id ? 'selected' : ''}>${esc(c.titular)} · ${esc(c.contacto_zelle)}${c.activa ? '' : ' (pausada)'}</option>`).join('')}
      </select></div>
      <button class="boton primario" type="button">Guardar</button>`);
    $('button.primario', v.el).onclick = (e) => intentar(e.currentTarget, async () => {
      await api.asignarCuentaZelle(r.id, Number($('#nueva-cuenta', v.el).value)); v.cerrar();
      aviso('Cuenta cambiada. Mándale los datos nuevos al cliente.'); plantillaSugerida = 'cliente_datos_zelle'; recargar();
    });
  });

  en('gestor', () => {
    const v = ventana('Cambiar gestor', `
      <div class="campo"><label for="nuevo-gestor">Gestor de esta remesa</label><select id="nuevo-gestor">
        <option value="">Sin gestor (sin comisión)</option>
        ${gestores.filter((g) => g.activo || g.id === r.gestor_id).map((g) => `<option value="${g.id}" ${g.id === r.gestor_id ? 'selected' : ''}>${esc(g.nombre)} · ${esc(g.codigo)}</option>`).join('')}
      </select></div>
      <p class="nota">Solo cambia esta remesa. Para cambiar el gestor de todas las remesas futuras de un cliente, ve a Clientes.</p>
      <button class="boton primario" type="button">Guardar</button>`);
    $('button.primario', v.el).onclick = (e) => intentar(e.currentTarget, async () => {
      const g = $('#nuevo-gestor', v.el).value;
      await api.asignarGestor(r.id, g ? Number(g) : null); v.cerrar(); aviso('Gestor cambiado'); recargar();
    });
  });

  en('cancelar', () => {
    const v = ventana('Cancelar remesa', `
      ${r.estado !== 'esperando_zelle' ? '<p class="nota"><strong>El Zelle ya llegó.</strong> Al cancelar quedará anotado que hay que devolverlo.</p>' : ''}
      <div class="campo"><label for="motivo">Motivo</label><input id="motivo" type="text" placeholder="Ej. el cliente se arrepintió"></div>
      <button class="boton peligro" type="button">Cancelar remesa</button>`);
    $('button.peligro', v.el).onclick = (e) => intentar(e.currentTarget, async () => {
      await api.cancelar(r.id, $('#motivo', v.el).value); v.cerrar(); aviso('Remesa cancelada'); recargar();
    });
  });

  en('corregir', () => {
    const v = ventana('Corregir estado', `
      <p class="nota">Para arreglar un error (por ejemplo, la marcaste entregada sin querer). Queda anotado en el historial.</p>
      <div class="campo"><label for="estado-nuevo">Pasar a</label><select id="estado-nuevo">
        ${Object.entries(ESTADOS).filter(([k]) => k !== 'cancelada' && k !== r.estado).map(([k, e]) => `<option value="${k}">${e.texto}</option>`).join('')}
      </select></div>
      <div class="campo"><label for="motivo-corr">Motivo</label><input id="motivo-corr" type="text"></div>
      <button class="boton primario" type="button">Corregir</button>`);
    $('button.primario', v.el).onclick = (e) => intentar(e.currentTarget, async () => {
      await api.corregirEstado(r.id, $('#estado-nuevo', v.el).value, $('#motivo-corr', v.el).value); v.cerrar(); aviso('Estado corregido'); recargar();
    });
  });
}

// ------------------------------------------------------------------ WhatsApp (panel reutilizable)
const NOMBRE_DEST = { cliente: 'Cliente (A)', zelle: 'Cuenta Zelle (C)', gestor: 'Gestor (D)', beneficiario: 'Familiar', otro: 'Otro' };

/**
 * destinos: [{ dest, etiqueta, contexto, plantilla, telefono }]
 * Arma el mensaje con admin_preparar_whatsapp, deja editarlo y abre WhatsApp.
 */
async function panelWhatsApp(cont, { destinos, inicial, alEnviar, titulo = 'Enviar WhatsApp', sinTitulo = false }) {
  const plantillas = (await cat('plantillas')).filter((p) => p.activa);
  let actual = inicial ?? destinos[0];
  let preparado = null;
  cont.innerHTML = `
    ${sinTitulo ? '' : `<div class="titulo"><h2>${esc(titulo)}</h2></div>`}
    ${destinos.length > 1 ? `<div class="pastillas" role="group" aria-label="Para quién" data-destinos>
      ${destinos.map((d, i) => `<button type="button" class="pastilla" data-i="${i}">${esc(d.etiqueta ?? NOMBRE_DEST[d.dest])}</button>`).join('')}</div>` : ''}
    <div class="campo" data-caja-plantillas><span class="etq">Plantilla</span><div class="pastillas" data-plantillas></div></div>
    <div class="campo"><label>Número de WhatsApp <input type="tel" data-tel placeholder="Con código de país, ej. +1 305…"></label></div>
    <div class="campo"><label>Mensaje <textarea rows="9" data-texto></textarea></label></div>
    <p class="error-campo" data-aviso hidden></p>
    <button type="button" class="boton wa ancho" data-enviar>${icono('plantillas')} Abrir en WhatsApp</button>
    <p class="nota">Se abre el chat con el texto escrito; tú pulsas enviar. Queda anotado en el historial.</p>`;
  const tel = $('[data-tel]', cont);
  const texto = $('[data-texto]', cont);
  const avisoEl = $('[data-aviso]', cont);

  async function cargarPlantilla(clave) {
    $$('[data-plantillas] .pastilla', cont).forEach((b) => b.setAttribute('aria-pressed', String(b.dataset.clave === clave)));
    actual = { ...actual, plantilla: clave };
    avisoEl.hidden = true;
    if (!clave) { preparado = null; return; }
    texto.value = 'Preparando…';
    try {
      preparado = await api.prepararWhatsApp(clave, actual.contexto ?? {});
      texto.value = preparado.texto;
      tel.value = preparado.telefono ? '+' + preparado.telefono : (actual.telefono ? '+' + actual.telefono : '');
      if (preparado.aviso && !tel.value) { avisoEl.textContent = preparado.aviso + '. Escríbelo arriba.'; avisoEl.hidden = false; }
    } catch (e) { texto.value = ''; avisoEl.textContent = e.message; avisoEl.hidden = false; }
  }

  function elegirDestino(d) {
    actual = d;
    $$('[data-destinos] .pastilla', cont).forEach((b) => b.setAttribute('aria-pressed', String(destinos[b.dataset.i] === d || destinos[b.dataset.i].dest === d.dest)));
    const lista = plantillas.filter((p) => p.destinatario === d.dest);
    $('[data-caja-plantillas]', cont).hidden = !lista.length;
    $('[data-plantillas]', cont).innerHTML = lista.map((p) => `<button type="button" class="pastilla" data-clave="${esc(p.clave)}">${esc(p.titulo)}</button>`).join('');
    $$('[data-plantillas] .pastilla', cont).forEach((b) => b.addEventListener('click', () => cargarPlantilla(b.dataset.clave)));
    tel.value = d.telefono ? '+' + d.telefono : '';
    texto.value = '';
    preparado = null;
    const clave = d.plantilla && lista.some((p) => p.clave === d.plantilla) ? d.plantilla : (d.dest !== 'otro' ? lista[0]?.clave : null);
    if (clave) cargarPlantilla(clave);
  }

  $$('[data-destinos] .pastilla', cont).forEach((b) => b.addEventListener('click', () => elegirDestino(destinos[b.dataset.i])));
  const base = destinos.find((d) => d.dest === actual.dest) ?? destinos[0];
  elegirDestino({ ...base, plantilla: actual.plantilla ?? base.plantilla });

  $('[data-enviar]', cont).addEventListener('click', async (e) => {
    const numero = normalizarTelefono(tel.value);
    avisoEl.hidden = true;
    if (!numero) { avisoEl.textContent = 'Escribe un número válido con código de país'; avisoEl.hidden = false; tel.focus(); return; }
    if (!texto.value.trim()) { avisoEl.textContent = 'El mensaje está vacío'; avisoEl.hidden = false; return; }
    const ctxw = actual.contexto ?? {};
    const m = {
      ...(preparado ?? {}),
      destinatario: preparado?.destinatario ?? actual.dest,
      plantilla: preparado?.plantilla ?? null,
      remesa_id: preparado?.remesa_id ?? ctxw.remesaId ?? null,
      gestor_id: preparado?.gestor_id ?? ctxw.gestorId ?? null,
      cuenta_zelle_id: preparado?.cuenta_zelle_id ?? ctxw.cuentaZelleId ?? null,
      cliente_id: preparado?.cliente_id ?? ctxw.clienteId ?? null,
      telefono: numero,
      texto: texto.value,
    };
    const b = e.currentTarget;
    try {
      await api.enviarWhatsApp(m); // abre WhatsApp primero (sin esperar), luego anota
      aviso('WhatsApp abierto y anotado');
      alEnviar?.();
    } catch (ex) { aviso(ex.message, true); }
    b.blur();
  });
}

function ventanaWhatsApp(opciones) {
  const v = ventana(opciones.titulo ?? 'Enviar WhatsApp', '<div data-panel style="display:flex;flex-direction:column;gap:12px"></div>');
  panelWhatsApp($('[data-panel]', v.el), { ...opciones, sinTitulo: true, alEnviar: () => { v.cerrar(); opciones.alEnviar?.(); } })
    .catch((e) => aviso(e.message, true));
}

// ------------------------------------------------------------------ entregas del día
async function vistaEntregas(ctx) {
  const fecha = ctx.r.q.get('fecha') ?? hoy();
  const [lista, sinFecha] = await Promise.all([api.entregasDelDia(fecha), api.remesas({ estado: 'zelle_confirmado' })]);
  const total = lista.reduce((s, r) => s + Number(r.monto_entrega), 0);
  const grupos = {};
  lista.forEach((r) => (grupos[r.beneficiario_municipio || 'Sin municipio'] ??= []).push(r));

  const item = (r) => `<li class="tarjeta" style="gap:8px">
    <div class="titulo"><div><strong>${esc(r.beneficiario_nombre)}</strong> <span class="nota">· ${esc(r.codigo)}</span></div>
      <span class="cifra" style="font-size:20px;font-weight:600">${usd(r.monto_entrega)}</span></div>
    <div class="nota">${esc(r.beneficiario_direccion)}${r.beneficiario_provincia ? ', ' + esc(r.beneficiario_provincia) : ''}</div>
    <div class="fila">${r.franja ? `<span class="chip e3">${esc(FRANJAS[r.franja])}</span>` : ''}
      <span class="nota">Envía ${esc(r.cliente_nombre)}</span></div>
    <div class="fila">
      ${r.beneficiario_telefono ? `<a class="boton chico" href="tel:+${esc(normalizarTelefono(r.beneficiario_telefono))}">Llamar</a>
        <button class="boton chico" type="button" data-avisar="${r.id}">Avisar por WhatsApp</button>` : ''}
      <a class="boton chico primario" href="#/remesa/${r.id}">Entregar</a>
    </div></li>`;

  ctx.pintar(`
    <div class="cabeza">
      <div><h1>Entregas</h1><p>${esc(fechaLarga(fecha))}</p></div>
      <div class="fila">
        <input type="date" id="dia" value="${esc(fecha)}" aria-label="Día" style="width:auto">
        <button class="boton" type="button" id="copiar">Copiar ruta</button>
      </div>
    </div>
    <section class="kpis">
      <div class="kpi"><span class="etq">Entregas</span><span class="cifra">${lista.length}</span></div>
      <div class="kpi"><span class="etq">Efectivo que necesitas</span><span class="cifra">${usd(total)}</span></div>
      <a class="kpi" href="#/remesas?ver=zelle_confirmado"><span class="etq">Sin fecha todavía</span><span class="cifra">${sinFecha.length}</span><span class="sub">Zelle confirmado</span></a>
    </section>
    ${lista.length ? Object.entries(grupos).map(([m, rs]) => `
      <section style="display:flex;flex-direction:column;gap:10px"><h2>${esc(m)} · ${rs.length}</h2>
        <ul style="list-style:none;margin:0;padding:0;display:grid;grid-template-columns:repeat(auto-fill,minmax(300px,1fr));gap:12px">${rs.map(item).join('')}</ul></section>`).join('')
    : '<div class="tarjeta"><div class="vacio">No hay entregas programadas para este día</div></div>'}
    ${sinFecha.length ? `<section class="tarjeta"><h2>Con Zelle confirmado, sin fecha</h2>
      <ul class="historial">${sinFecha.map((r) => `<li><a href="#/remesa/${r.id}">${esc(r.codigo)}</a><span>${esc(r.beneficiario_nombre)} · ${esc(r.beneficiario_municipio ?? '')} · ${usd(r.monto_entrega)}</span></li>`).join('')}</ul></section>` : ''}`);

  $('#dia').addEventListener('change', (e) => { location.hash = `#/entregas?fecha=${e.target.value}`; });
  $('#copiar').addEventListener('click', async () => {
    const txt = `Entregas ${fechaLarga(fecha)} · total ${usd(total)}\n` + lista.map((r, i) =>
      `${i + 1}. ${r.beneficiario_nombre} · ${usd(r.monto_entrega)} · ${r.beneficiario_direccion}${r.beneficiario_municipio ? ', ' + r.beneficiario_municipio : ''}${r.beneficiario_telefono ? ' · ' + r.beneficiario_telefono : ''}${r.franja ? ' · ' + FRANJAS[r.franja] : ''} (${r.codigo})`).join('\n');
    try { await navigator.clipboard.writeText(txt); aviso('Ruta copiada'); } catch { ventana('Ruta del día', `<textarea rows="12">${esc(txt)}</textarea>`); }
  });
  $$('[data-avisar]').forEach((b) => b.addEventListener('click', () => ventanaWhatsApp({
    titulo: 'Avisar al familiar',
    destinos: [{ dest: 'beneficiario', contexto: { remesaId: Number(b.dataset.avisar) }, plantilla: 'beneficiario_aviso_entrega' }],
  })));
}

// ------------------------------------------------------------------ nueva remesa manual
async function vistaNueva(ctx) {
  const [gestores, cuentas, config] = await Promise.all([cat('gestores'), cat('cuentas'), cat('config')]);
  const clienteId = ctx.r.q.get('cliente');
  let cliente = null, familiares = [];
  if (clienteId) {
    cliente = (await api.clientes()).find((c) => c.id === clienteId) ?? null;
    familiares = cliente ? (await sb.from('beneficiarios').select('*').eq('cliente_id', clienteId).eq('activo', true)).data ?? [] : [];
  }

  ctx.pintar(`
    <div class="cabeza"><div><h1>Nueva remesa</h1><p>Para clientes que escriben por WhatsApp y no usan la app</p></div></div>
    <form class="columnas" id="form-nueva" novalidate>
      <div class="col-a">
        <section class="tarjeta"><h2>Quién manda (A)</h2>
          <div class="rejilla">
            <div class="campo"><label for="c-nombre">Nombre</label><input id="c-nombre" type="text" required value="${esc(cliente?.nombre ?? '')}"></div>
            <div class="campo"><label for="c-wa">WhatsApp</label><input id="c-wa" type="tel" placeholder="+1 305 555 1234" value="${esc(cliente?.whatsapp ? '+' + cliente.whatsapp : '')}"></div>
          </div>
          ${cliente ? `<p class="nota">Cliente con cuenta: ${esc(cliente.correo ?? '')}. La remesa también le aparecerá en su app.</p>` : ''}
        </section>
        <section class="tarjeta"><h2>Quién recibe en Cuba</h2>
          ${familiares.length ? `<div class="campo"><label for="f-guardado">Familiar guardado</label><select id="f-guardado"><option value="">— Escribir a mano —</option>
            ${familiares.map((f, i) => `<option value="${i}">${esc(f.nombre)} · ${esc(f.municipio ?? f.direccion)}</option>`).join('')}</select></div>` : ''}
          <div class="rejilla">
            <div class="campo"><label for="f-nombre">Nombre</label><input id="f-nombre" type="text" required></div>
            <div class="campo"><label for="f-tel">Teléfono</label><input id="f-tel" type="tel" placeholder="5 555 1234"></div>
          </div>
          <div class="campo"><label for="f-dir">Dirección</label><input id="f-dir" type="text" required placeholder="Calle, número, entre calles"></div>
          <div class="rejilla">
            <div class="campo"><label for="f-mun">Municipio</label><input id="f-mun" type="text"></div>
            <div class="campo"><label for="f-prov">Provincia</label><input id="f-prov" type="text"></div>
          </div>
        </section>
      </div>
      <div class="col-b">
        <section class="tarjeta"><h2>Dinero</h2>
          <div class="campo"><label for="monto">Entregar en Cuba (USD)</label><input id="monto" type="number" inputmode="numeric" min="1" step="1" required></div>
          <div class="dinero"><div><div class="etq">Tarifa</div><div class="cifra" id="v-tarifa">—</div></div>
            <div><div class="etq">Total Zelle</div><div class="cifra" id="v-total">—</div></div></div>
          <p class="nota" id="v-aviso"></p>
          <div class="campo"><label for="gestor">Gestor</label><select id="gestor"><option value="">Sin gestor</option>
            ${gestores.filter((g) => g.activo).map((g) => `<option value="${esc(g.codigo)}" ${g.id === cliente?.gestor_id ? 'selected' : ''}>${esc(g.nombre)} · ${esc(g.codigo)}</option>`).join('')}</select></div>
          <div class="campo"><label for="cuenta">Cuenta Zelle</label><select id="cuenta"><option value="">Automática (por turnos)</option>
            ${cuentas.filter((c) => c.activa).map((c) => `<option value="${c.id}">${esc(c.titular)}</option>`).join('')}</select></div>
          <div class="campo"><label for="nota">Nota (opcional)</label><input id="nota" type="text"></div>
          <button class="boton primario ancho" type="submit">Crear remesa</button>
        </section>
      </div>
    </form>`);

  const v = (id) => $('#' + id).value.trim();
  const calcular = () => {
    const m = Number($('#monto').value);
    const t = calcularTarifa(m, config);
    $('#v-tarifa').textContent = m > 0 ? usd(t) : '—';
    $('#v-total').textContent = m > 0 ? usd(m + t) : '—';
    $('#v-aviso').textContent = m > 0 ? (validarMonto(m, config) ? `Aviso: ${validarMonto(m, config)} (en la app). Aquí sí se permite.` : '') : '';
  };
  $('#monto').addEventListener('input', calcular);
  $('#f-guardado')?.addEventListener('change', (e) => {
    const f = familiares[e.target.value];
    if (!f) return;
    $('#f-nombre').value = f.nombre; $('#f-tel').value = f.telefono ?? ''; $('#f-dir').value = f.direccion;
    $('#f-mun').value = f.municipio ?? ''; $('#f-prov').value = f.provincia ?? '';
  });
  $('#form-nueva').addEventListener('submit', (e) => {
    e.preventDefault();
    intentar($('#form-nueva button[type=submit]'), async () => {
      if (!v('c-nombre')) throw new Error('Falta el nombre de quien manda');
      if (!v('f-nombre') || !v('f-dir')) throw new Error('Falta el nombre o la dirección de quien recibe');
      if (!(Number(v('monto')) > 0)) throw new Error('Escribe el monto');
      const r = await api.crearRemesaManual({
        clienteNombre: v('c-nombre'), clienteWhatsapp: v('c-wa') || null, clienteId: cliente?.id ?? null,
        familiarNombre: v('f-nombre'), familiarTelefono: v('f-tel') || null, familiarDireccion: v('f-dir'),
        familiarMunicipio: v('f-mun') || null, familiarProvincia: v('f-prov') || null,
        monto: Number(v('monto')), codigoGestor: v('gestor') || null,
        cuentaZelleId: v('cuenta') ? Number(v('cuenta')) : null, nota: v('nota') || null,
      });
      plantillaSugerida = 'cliente_datos_zelle';
      aviso(`Remesa ${r.codigo} creada. Mándale los datos del Zelle.`);
      location.hash = `#/remesa/${r.id}`;
    });
  });
}

// ------------------------------------------------------------------ gestores
function formGestor(g, alGuardar) {
  const v = ventana(g ? 'Editar gestor' : 'Nuevo gestor', `
    <div class="rejilla">
      <div class="campo"><label for="g-cod">Código</label><input id="g-cod" type="text" value="${esc(g?.codigo ?? '')}" placeholder="GES-003" style="text-transform:uppercase">
        <span class="ayuda">Letras, números y guiones. El cliente lo escribe al registrarse.</span></div>
      <div class="campo"><label for="g-nom">Nombre</label><input id="g-nom" type="text" value="${esc(g?.nombre ?? '')}"></div>
    </div>
    <div class="campo"><label for="g-wa">WhatsApp</label><input id="g-wa" type="tel" value="${esc(g?.whatsapp ? '+' + normalizarTelefono(g.whatsapp) : '')}" placeholder="+53 5 555 1234"></div>
    <div class="campo"><label for="g-notas">Notas</label><input id="g-notas" type="text" value="${esc(g?.notas ?? '')}"></div>
    <label class="fila"><input id="g-activo" type="checkbox" ${g?.activo === false ? '' : 'checked'} style="width:20px;height:20px"> Activo (si no, sus clientes nuevos no le generan comisión)</label>
    <button class="boton primario" type="button">Guardar</button>`);
  $('button.primario', v.el).onclick = (e) => intentar(e.currentTarget, async () => {
    const codigo = $('#g-cod', v.el).value.trim().toUpperCase();
    if (!/^[A-Z0-9-]{3,20}$/.test(codigo)) throw new Error('El código debe tener de 3 a 20 letras, números o guiones');
    if ($('#g-nom', v.el).value.trim().length < 2) throw new Error('Escribe el nombre');
    const wa = $('#g-wa', v.el).value.trim();
    if (wa && !normalizarTelefono(wa)) throw new Error('WhatsApp inválido');
    await api.guardarGestor({ id: g?.id, codigo, nombre: $('#g-nom', v.el).value.trim(), whatsapp: wa ? normalizarTelefono(wa) : null,
      activo: $('#g-activo', v.el).checked, notas: $('#g-notas', v.el).value.trim() });
    olvidar('gestores'); v.cerrar(); aviso('Gestor guardado'); alGuardar();
  });
}

async function vistaGestores(ctx) {
  const [res, gestores] = await Promise.all([api.resumenGestores(), cat('gestores', true)]);
  ctx.pintar(`
    <div class="cabeza"><div><h1>Gestores</h1><p>Comisión: ${esc((await cat('config')).comision_gestor_pct ?? 50)}% de la tarifa de cada remesa entregada de sus clientes</p></div>
      <button class="boton primario" type="button" id="nuevo">+ Nuevo gestor</button></div>
    <section class="tarjeta sin-relleno"><div class="desplazable"><table class="lista responsiva">
      <thead><tr><th>Gestor</th><th class="der">Clientes</th><th class="der">Entregadas mes</th><th class="der">Comisión mes</th><th class="der">Por pagar</th><th class="der">Acciones</th></tr></thead>
      <tbody>${res.length ? res.map((g) => `<tr>
        <td><strong>${esc(g.nombre)}</strong>${g.activo ? '' : ' <span class="chip e0">inactivo</span>'}<span class="sub">${esc(g.codigo)} · ${esc(telVisible(normalizarTelefono(g.whatsapp)) || 'sin WhatsApp')}</span></td>
        <td data-m="der" class="der">${g.clientes} cliente(s)<span class="sub">${g.remesas_entregadas} este mes · ${usd(g.comision_generada)}</span></td>
        <td data-m="ocultar" class="der">${g.remesas_entregadas}</td>
        <td data-m="ocultar" class="der">${usd(g.comision_generada)}</td>
        <td data-m="todo" class="der">${Number(g.comision_pendiente) > 0 ? `<span class="chip aviso">Por pagar ${usd(g.comision_pendiente)}</span>` : '<span class="sub">Al día</span>'}</td>
        <td data-m="todo" class="der"><div class="fila" style="justify-content:flex-end">
          ${Number(g.comision_pendiente) > 0 ? `<button class="boton chico" type="button" data-pagar="${g.gestor_id}">Pagar ${usd(g.comision_pendiente)}</button>` : ''}
          <button class="boton chico" type="button" data-wa="${g.gestor_id}">WhatsApp</button>
          <button class="boton chico" type="button" data-editar="${g.gestor_id}">Editar</button></div></td>
      </tr>`).join('') : '<tr><td colspan="6"><div class="vacio">Todavía no hay gestores</div></td></tr>'}</tbody>
    </table></div></section>`);

  const buscar = (id) => gestores.find((g) => g.id === Number(id));
  $('#nuevo').onclick = () => formGestor(null, navegar);
  $$('[data-editar]').forEach((b) => b.addEventListener('click', () => formGestor(buscar(b.dataset.editar), navegar)));
  $$('[data-wa]').forEach((b) => b.addEventListener('click', () => ventanaWhatsApp({
    titulo: `WhatsApp a ${buscar(b.dataset.wa)?.nombre}`,
    destinos: [{ dest: 'gestor', contexto: { gestorId: Number(b.dataset.wa) }, plantilla: 'gestor_resumen_mes' }],
  })));
  $$('[data-pagar]').forEach((b) => b.addEventListener('click', async () => {
    const g = res.find((x) => x.gestor_id === Number(b.dataset.pagar));
    if (!(await confirmar('Pagar comisiones', `¿Ya le diste <strong>${usd(g.comision_pendiente)}</strong> en efectivo a ${esc(g.nombre)}? Se marcan pagadas todas sus remesas entregadas pendientes.`, { boton: 'Sí, ya se lo di' }))) return;
    intentar(b, async () => {
      const r = await api.pagarComisiones(g.gestor_id);
      aviso(`Pagadas ${r.remesas} remesa(s) · ${usd(r.total)}`);
      navegar();
    });
  }));
}

// ------------------------------------------------------------------ cuentas Zelle
function formCuenta(c, alGuardar) {
  const v = ventana(c ? 'Editar cuenta Zelle' : 'Nueva cuenta Zelle', `
    <div class="campo"><label for="z-tit">Titular (como aparece en Zelle)</label><input id="z-tit" type="text" value="${esc(c?.titular ?? '')}"></div>
    <div class="campo"><label for="z-con">Correo o teléfono de Zelle</label><input id="z-con" type="text" value="${esc(c?.contacto_zelle ?? '')}">
      <span class="ayuda">Es lo que el cliente escribe en Zelle para mandar el dinero.</span></div>
    <div class="campo"><label for="z-wa">WhatsApp del titular</label><input id="z-wa" type="tel" value="${esc(c?.whatsapp ? '+' + normalizarTelefono(c.whatsapp) : '')}" placeholder="+1 305 555 1234"></div>
    <div class="campo"><label for="z-notas">Notas</label><input id="z-notas" type="text" value="${esc(c?.notas ?? '')}"></div>
    <label class="fila"><input id="z-act" type="checkbox" ${c?.activa === false ? '' : 'checked'} style="width:20px;height:20px"> Activa (recibe remesas nuevas)</label>
    <button class="boton primario" type="button">Guardar</button>`);
  $('button.primario', v.el).onclick = (e) => intentar(e.currentTarget, async () => {
    if ($('#z-tit', v.el).value.trim().length < 2) throw new Error('Escribe el titular');
    if (!$('#z-con', v.el).value.trim()) throw new Error('Escribe el correo o teléfono de Zelle');
    const wa = $('#z-wa', v.el).value.trim();
    if (wa && !normalizarTelefono(wa)) throw new Error('WhatsApp inválido');
    await api.guardarCuentaZelle({ id: c?.id, titular: $('#z-tit', v.el).value.trim(), contactoZelle: $('#z-con', v.el).value.trim(),
      whatsapp: wa ? normalizarTelefono(wa) : null, activa: $('#z-act', v.el).checked, notas: $('#z-notas', v.el).value.trim() });
    olvidar('cuentas'); v.cerrar(); aviso('Cuenta guardada'); alGuardar();
  });
}

async function vistaCuentas(ctx) {
  const [res, cuentas] = await Promise.all([api.resumenCuentasZelle(), cat('cuentas', true)]);
  ctx.pintar(`
    <div class="cabeza"><div><h1>Cuentas Zelle</h1><p>Las remesas nuevas se reparten por turnos entre las cuentas activas</p></div>
      <button class="boton primario" type="button" id="nueva">+ Nueva cuenta</button></div>
    ${res.length ? `<section style="display:grid;grid-template-columns:repeat(auto-fill,minmax(280px,1fr));gap:12px">${res.map((c) => `
      <div class="tarjeta">
        <div class="titulo"><h2>${esc(c.titular)}</h2><span class="chip ${c.activa ? 'e4' : 'e0'}">${c.activa ? 'Activa' : 'Pausada'}</span></div>
        <span class="nota">${esc(c.contacto_zelle)} · WhatsApp ${esc(telVisible(normalizarTelefono(c.whatsapp)) || 'no tiene')}</span>
        <div class="dinero"><div><div class="etq">Recibido este mes</div><div class="cifra">${usd(c.recibido)}</div></div>
          <div><div class="etq">Por confirmar</div><div class="cifra">${c.por_confirmar_n}</div><div class="etq">${usd(c.por_confirmar_total)}</div></div></div>
        <div class="fila">
          <button class="boton chico" type="button" data-wa="${c.cuenta_zelle_id}">WhatsApp pendientes</button>
          <button class="boton chico" type="button" data-pausar="${c.cuenta_zelle_id}">${c.activa ? 'Pausar' : 'Activar'}</button>
          <button class="boton chico" type="button" data-editar="${c.cuenta_zelle_id}">Editar</button>
        </div>
      </div>`).join('')}</section>`
    : '<div class="tarjeta"><div class="vacio">Agrega al menos una cuenta Zelle: sin cuenta, el cliente no sabe a dónde depositar.</div></div>'}`);

  const buscar = (id) => cuentas.find((c) => c.id === Number(id));
  $('#nueva').onclick = () => formCuenta(null, navegar);
  $$('[data-editar]').forEach((b) => b.addEventListener('click', () => formCuenta(buscar(b.dataset.editar), navegar)));
  $$('[data-pausar]').forEach((b) => b.addEventListener('click', () => intentar(b, async () => {
    const c = buscar(b.dataset.pausar);
    await api.guardarCuentaZelle({ id: c.id, titular: c.titular, contactoZelle: c.contacto_zelle, whatsapp: c.whatsapp, notas: c.notas, activa: !c.activa });
    olvidar('cuentas'); aviso(c.activa ? 'Cuenta pausada' : 'Cuenta activada'); navegar();
  })));
  $$('[data-wa]').forEach((b) => b.addEventListener('click', () => ventanaWhatsApp({
    titulo: `WhatsApp a ${buscar(b.dataset.wa)?.titular}`,
    destinos: [{ dest: 'zelle', contexto: { cuentaZelleId: Number(b.dataset.wa) }, plantilla: 'zelle_pendientes' }],
  })));
}

// ------------------------------------------------------------------ clientes
async function vistaClientes(ctx) {
  const [clientes, gestores] = await Promise.all([api.clientes(), cat('gestores')]);
  const nombreGestor = (id) => gestores.find((g) => g.id === id)?.nombre;
  ctx.pintar(`
    <div class="cabeza"><div><h1>Clientes</h1><p>${clientes.length} con cuenta en la app</p></div>
      <input type="search" id="buscar" placeholder="Buscar nombre, correo o WhatsApp" aria-label="Buscar" style="max-width:300px"></div>
    <section class="tarjeta sin-relleno"><div class="desplazable"><table class="lista responsiva">
      <thead><tr><th>Cliente</th><th>WhatsApp</th><th>Gestor</th><th class="der">Alta</th><th class="der">Acciones</th></tr></thead>
      <tbody id="filas"></tbody></table></div></section>`);
  const dibujar = () => {
    const b = $('#buscar').value.trim().toLowerCase();
    const filas = clientes.filter((c) => !b || [c.nombre, c.correo, c.whatsapp].some((x) => (x ?? '').toLowerCase().includes(b)));
    $('#filas').innerHTML = filas.length ? filas.map((c) => `<tr>
      <td><strong>${esc(c.nombre || '(sin nombre)')}</strong><span class="sub">${esc(c.correo ?? '')}${c.pais ? ' · ' + esc(c.pais) : ''}</span></td>
      <td data-m="der">${c.whatsapp ? esc(telVisible(c.whatsapp)) : '<span class="sub">sin WhatsApp</span>'}</td>
      <td data-m="todo">${esc(nombreGestor(c.gestor_id) ?? '—')}</td>
      <td data-m="ocultar" class="der"><span class="sub">${esc(fechaHora(c.creado_at))}</span></td>
      <td data-m="todo" class="der"><div class="fila" style="justify-content:flex-end">
        <a class="boton chico" href="#/nueva?cliente=${esc(c.id)}">Nueva remesa</a>
        ${c.whatsapp ? `<button class="boton chico" type="button" data-wa="${esc(c.id)}">WhatsApp</button>` : ''}
        <button class="boton chico" type="button" data-gestor="${esc(c.id)}">Gestor</button></div></td></tr>`).join('')
      : `<tr><td colspan="5"><div class="vacio">${b ? 'Nada coincide' : 'Todavía no hay clientes registrados'}</div></td></tr>`;
    $$('[data-wa]').forEach((bt) => bt.addEventListener('click', () => {
      const c = clientes.find((x) => x.id === bt.dataset.wa);
      ventanaWhatsApp({ titulo: `WhatsApp a ${c.nombre}`, destinos: [
        { dest: 'otro', etiqueta: 'Mensaje libre', telefono: c.whatsapp, contexto: { clienteId: c.id } },
        ...(c.gestor_id ? [{ dest: 'gestor', etiqueta: 'Avisar al gestor', contexto: { clienteId: c.id, gestorId: c.gestor_id }, plantilla: 'gestor_nuevo_cliente' }] : []),
      ] });
    }));
    $$('[data-gestor]').forEach((bt) => bt.addEventListener('click', () => {
      const c = clientes.find((x) => x.id === bt.dataset.gestor);
      const v = ventana(`Gestor de ${c.nombre}`, `
        <div class="campo"><label for="cg">Gestor</label><select id="cg"><option value="">Sin gestor</option>
          ${gestores.map((g) => `<option value="${g.id}" ${g.id === c.gestor_id ? 'selected' : ''}>${esc(g.nombre)} · ${esc(g.codigo)}${g.activo ? '' : ' (inactivo)'}</option>`).join('')}</select></div>
        <p class="nota">Aplica a sus remesas nuevas. Las que ya existen no cambian (cámbialas una por una si hace falta).</p>
        <button class="boton primario" type="button">Guardar</button>`);
      $('button.primario', v.el).onclick = (e) => intentar(e.currentTarget, async () => {
        const g = $('#cg', v.el).value;
        await api.asignarGestorACliente(c.id, g ? Number(g) : null);
        c.gestor_id = g ? Number(g) : null; v.cerrar(); aviso('Gestor guardado'); dibujar();
      });
    }));
  };
  dibujar();
  $('#buscar').addEventListener('input', dibujar);
}

// ------------------------------------------------------------------ plantillas
async function vistaPlantillas(ctx) {
  const plantillas = await cat('plantillas', true);
  const grupos = ['cliente', 'zelle', 'gestor', 'beneficiario'];
  ctx.pintar(`
    <div class="cabeza"><div><h1>Plantillas de WhatsApp</h1><p>Los textos entre llaves se llenan solos con los datos de la remesa</p></div></div>
    <details class="tarjeta"><summary style="cursor:pointer;font-weight:600">Marcadores disponibles</summary>
      <p class="nota"><code>{codigo} {cliente} {beneficiario} {direccion} {monto} {tarifa} {total} {zelle_recibido} {zelle_titular} {zelle_contacto} {fecha_entrega} {franja} {comision} {gestor} {cuenta} {negocio} {enlace_app} {whatsapp_negocio}</code></p>
      <p class="nota">Solo gestor: <code>{mes_remesas} {mes_comision} {pendiente}</code> · Solo cuenta Zelle: <code>{pendientes_n} {pendientes_total} {lista_pendientes}</code></p>
      <p class="nota">En WhatsApp, <code>*texto*</code> sale en negrita.</p></details>
    ${grupos.map((d) => `<section style="display:flex;flex-direction:column;gap:12px"><h2>Para ${esc(NOMBRE_DEST[d])}</h2>
      <div style="display:grid;grid-template-columns:repeat(auto-fill,minmax(320px,1fr));gap:12px">
      ${plantillas.filter((p) => p.destinatario === d).map((p) => `<div class="tarjeta" data-clave="${esc(p.clave)}">
        <div class="campo"><label>Título <input type="text" data-titulo value="${esc(p.titulo)}"></label></div>
        <div class="campo"><label>Texto <textarea rows="6" data-texto>${esc(p.texto)}</textarea></label></div>
        <div class="fila" style="justify-content:space-between"><label class="fila"><input type="checkbox" data-activa ${p.activa ? 'checked' : ''} style="width:20px;height:20px"> Activa</label>
          <button class="boton chico" type="button" data-guardar>Guardar</button></div>
      </div>`).join('')}</div></section>`).join('')}`);
  $$('[data-guardar]').forEach((b) => b.addEventListener('click', () => intentar(b, async () => {
    const t = b.closest('[data-clave]');
    const p = plantillas.find((x) => x.clave === t.dataset.clave);
    await api.guardarPlantilla({ ...p, titulo: $('[data-titulo]', t).value.trim(), texto: $('[data-texto]', t).value, activa: $('[data-activa]', t).checked });
    olvidar('plantillas'); aviso('Plantilla guardada');
  })));
}

// ------------------------------------------------------------------ ajustes
async function vistaAjustes(ctx) {
  const filas = await api.configuracion();
  ctx.pintar(`
    <div class="cabeza"><div><h1>Ajustes</h1><p>Cambian el comportamiento de la app sin tocar código</p></div></div>
    <section class="tarjeta">
      <h2>Ejemplo con la tarifa actual</h2><p class="nota" id="ejemplo"></p>
    </section>
    <section class="tarjeta sin-relleno"><div class="desplazable"><table class="lista responsiva">
      <thead><tr><th>Ajuste</th><th>Valor</th><th></th></tr></thead>
      <tbody>${filas.map((c) => `<tr data-clave="${esc(c.clave)}">
        <td data-m="todo"><strong>${esc(c.clave.replaceAll('_', ' '))}</strong>${c.publica ? '' : ' <span class="chip e0">privado</span>'}<span class="sub">${esc(c.descripcion ?? '')}</span></td>
        <td data-m="todo"><input type="text" value="${esc(c.valor)}" aria-label="${esc(c.clave)}"></td>
        <td data-m="todo" class="der"><button class="boton chico" type="button" data-guardar>Guardar</button></td></tr>`).join('')}</tbody>
    </table></div></section>
    <section class="tarjeta" style="max-width:480px">
      <h2>Cambiar contraseña del admin</h2>
      <div class="campo"><label for="pw1">Nueva contraseña</label><input id="pw1" type="password" autocomplete="new-password"></div>
      <div class="campo"><label for="pw2">Repítela</label><input id="pw2" type="password" autocomplete="new-password"></div>
      <div><button class="boton" type="button" id="cambiar-pw">Cambiar contraseña</button></div>
    </section>`);
  const ejemplo = () => {
    const c = Object.fromEntries($$('tr[data-clave]').map((tr) => [tr.dataset.clave, $('input', tr).value]));
    const t = calcularTarifa(350, c);
    $('#ejemplo').textContent = `Si la familia debe recibir $350, el cliente deposita ${usd(350 + t)} (tarifa ${usd(t)}). ` +
      `Con gestor: ${usd(t * Number(c.comision_gestor_pct ?? 50) / 100)} para el gestor y ${usd(t - t * Number(c.comision_gestor_pct ?? 50) / 100)} para ti.`;
  };
  ejemplo();
  $$('tr[data-clave] input').forEach((i) => i.addEventListener('input', ejemplo));
  $$('[data-guardar]').forEach((b) => b.addEventListener('click', () => intentar(b, async () => {
    const tr = b.closest('tr');
    await api.guardarConfig(tr.dataset.clave, $('input', tr).value.trim());
    olvidar('config'); aviso('Guardado');
  })));
  $('#cambiar-pw').addEventListener('click', (e) => intentar(e.currentTarget, async () => {
    const a = $('#pw1').value, b = $('#pw2').value;
    if (a.length < 8) throw new Error('Usa al menos 8 caracteres');
    if (a !== b) throw new Error('Las dos contraseñas no son iguales');
    await api.cambiarContrasena(a);
    $('#pw1').value = $('#pw2').value = '';
    aviso('Contraseña cambiada');
  }));
}

iniciar();
