// =====================================================================
// Remesa.cu · PWA del cliente (A)
// Página estática en GitHub Pages; habla con Supabase por compartido/remesa-api.js
// =====================================================================
import { CONFIG, CONFIG_LISTA, SUPABASE_JS } from '../compartido/config.js';
import {
  crearApiCliente, cotizarLocal, fmtUsd, normalizarTelefono, enlaceWhatsApp, ESTADOS, FRANJAS,
} from '../compartido/remesa-api.js';

const app = document.getElementById('app');
let sb, api;
let sesion = null;
let perfil = null;
let cfg = {};
let turno = 0;
let instalar = null; // evento beforeinstallprompt

const CLAVE_GESTOR = 'remesa-codigo-gestor';
const PROVINCIAS = ['Pinar del Río', 'Artemisa', 'La Habana', 'Mayabeque', 'Matanzas', 'Cienfuegos', 'Villa Clara',
  'Sancti Spíritus', 'Ciego de Ávila', 'Camagüey', 'Las Tunas', 'Holguín', 'Granma', 'Santiago de Cuba', 'Guantánamo',
  'Isla de la Juventud'];
const PAISES = ['Estados Unidos', 'México', 'España', 'Canadá', 'Otro'];

// ------------------------------------------------------------------ utilidades
const esc = (v) => String(v ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const usd = (n) => (n == null ? '—' : '$' + fmtUsd(n));
const $ = (s, r = document) => r.querySelector(s);
const $$ = (s, r = document) => [...r.querySelectorAll(s)];
const fechaHora = (ts) => (ts ? new Date(ts).toLocaleString('es', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' }) : '');
const fechaCorta = (ts) => (ts ? new Date(ts).toLocaleDateString('es', { day: 'numeric', month: 'short', year: 'numeric' }) : '');
const fechaLarga = (d) => (d ? new Date(d + 'T12:00:00').toLocaleDateString('es', { weekday: 'long', day: 'numeric', month: 'long' }) : '');
const CLASE = { esperando_zelle: 'e1', zelle_confirmado: 'e2', entrega_programada: 'e3', entregada: 'e4', cancelada: 'e0' };
const TEXTO_CLIENTE = {
  esperando_zelle: 'Esperando tu Zelle', zelle_confirmado: 'Zelle recibido', entrega_programada: 'Entrega programada',
  entregada: 'Entregada', cancelada: 'Cancelada',
};
const chip = (r) => {
  const texto = r.estado === 'esperando_zelle' && r.cliente_reporto_pago_at ? 'Confirmando tu Zelle'
    : r.estado === 'entrega_programada' ? `Entrega ${new Date(r.fecha_entrega + 'T12:00:00').toLocaleDateString('es', { day: 'numeric', month: 'short' })}`
      : TEXTO_CLIENTE[r.estado];
  return `<span class="chip ${CLASE[r.estado]}">${esc(texto)}</span>`;
};
const leerLocal = (k) => { try { return localStorage.getItem(k); } catch { return null; } };
const guardarLocal = (k, v) => { try { v == null ? localStorage.removeItem(k) : localStorage.setItem(k, v); } catch { /* sin almacenamiento */ } };

const ICONOS = {
  enviar: '<path d="M12 5v14M5 12h14"/>',
  remesas: '<path d="M4 6h16M4 12h16M4 18h10"/>',
  familiares: '<circle cx="9" cy="8" r="3.5"/><path d="M2.5 20c1-3.5 3.5-5 6.5-5s5.5 1.5 6.5 5"/><path d="M16 4.5a3.5 3.5 0 010 7M18 15c2 .6 3.2 2.2 3.8 5"/>',
  perfil: '<circle cx="12" cy="8" r="4"/><path d="M4 21c1.5-4 4.5-6 8-6s6.5 2 8 6"/>',
  atras: '<path d="M15 6l-6 6 6 6"/>',
  wa: '<path d="M21 12a8.5 8.5 0 01-12.6 7.4L3 21l1.7-5.2A8.5 8.5 0 1121 12z"/>',
  copiar: '<rect x="9" y="9" width="11" height="11" rx="2"/><path d="M5 15V5a2 2 0 012-2h10"/>',
  reloj: '<circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 2"/>',
};
const icono = (n, t = 20) => `<svg width="${t}" height="${t}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${ICONOS[n]}</svg>`;

function aviso(texto, error = false) {
  const el = document.createElement('div');
  el.className = 'aviso-flot' + (error ? ' error' : '');
  el.textContent = texto;
  $('#avisos').append(el);
  setTimeout(() => el.remove(), error ? 6000 : 3000);
}

async function ocupado(boton, fn) {
  if (boton?.disabled) return;
  const antes = boton?.innerHTML;
  if (boton) { boton.disabled = true; boton.textContent = 'Un momento…'; }
  try { return await fn(); } catch (e) { aviso(e.message ?? String(e), true); } finally {
    if (boton?.isConnected) { boton.disabled = false; boton.innerHTML = antes; }
  }
}

function hoja(titulo, html) {
  const velo = document.createElement('div');
  velo.className = 'velo';
  velo.innerHTML = `<div class="hoja" role="dialog" aria-modal="true" aria-label="${esc(titulo)}">
    <div class="encabezado"><h2>${esc(titulo)}</h2><button type="button" class="cerrar" aria-label="Cerrar">×</button></div>${html}</div>`;
  const cerrar = () => velo.remove();
  velo.addEventListener('click', (e) => { if (e.target === velo) cerrar(); });
  $('.cerrar', velo).onclick = cerrar;
  document.body.append(velo);
  return { el: $('.hoja', velo), cerrar };
}

async function copiar(texto) {
  try { await navigator.clipboard.writeText(texto); aviso('Copiado'); } catch {
    const t = document.createElement('textarea'); t.value = texto; document.body.append(t); t.select();
    try { document.execCommand('copy'); aviso('Copiado'); } catch { aviso('No se pudo copiar', true); }
    t.remove();
  }
}

const enlaceNegocio = (texto) => {
  const n = normalizarTelefono(cfg.whatsapp_negocio);
  return n ? enlaceWhatsApp(n, texto) : null;
};

// ------------------------------------------------------------------ rutas
const PUBLICAS = { entrar: vistaEntrar, registro: vistaRegistro, olvide: vistaOlvide, 'nueva-clave': vistaNuevaClave };
const PRIVADAS = {
  enviar: vistaEnviar, remesas: vistaRemesas, remesa: vistaRemesa, familiares: vistaFamiliares,
  familiar: vistaFamiliar, perfil: vistaPerfil,
};
const NAV = [['enviar', 'Enviar'], ['remesas', 'Remesas'], ['familiares', 'Familiares']];

function leerRuta() {
  const [camino, consulta] = location.hash.replace(/^#\/?/, '').split('?');
  const [nombre, id] = (camino || '').split('/');
  return { nombre, id, q: new URLSearchParams(consulta ?? '') };
}
const ir = (hash) => { if (location.hash === hash) navegar(); else location.hash = hash; };

async function navegar() {
  const mio = ++turno;
  const r = leerRuta();
  if (r.nombre === 'nueva-clave') return vistaNuevaClave(r);
  if (!sesion) {
    const v = PUBLICAS[r.nombre] ?? vistaEntrar;
    return v(r);
  }
  if (PUBLICAS[r.nombre] || !PRIVADAS[r.nombre]) { history.replaceState(null, '', '#/enviar'); r.nombre = 'enviar'; }
  const activa = { remesa: 'remesas', familiar: 'familiares' }[r.nombre] ?? r.nombre;
  app.innerHTML = `
    <div class="sin-red" id="sin-red" ${navigator.onLine ? 'hidden' : ''}>Sin conexión. Lo que ves puede no estar al día.</div>
    <header class="cabecera">
      <div class="marca">Remesa<span>.cu</span></div>
      <a class="redondo" href="#/perfil" aria-label="Mi cuenta">${icono('perfil')}</a>
    </header>
    <main class="contenido" id="contenido"><div class="cargando">Cargando…</div></main>
    <nav class="barra-nav" aria-label="Principal">
      ${NAV.map(([k, t]) => `<a href="#/${k}" ${k === activa ? 'aria-current="page"' : ''}>${icono(k)}${t}</a>`).join('')}
    </nav>`;
  const main = $('#contenido');
  const ctx = { r, main, pintar: (html) => { if (mio !== turno) throw new Error('__viejo'); main.innerHTML = html; } };
  try {
    await PRIVADAS[r.nombre](ctx);
    window.scrollTo({ top: 0 });
  } catch (e) {
    if (e.message === '__viejo' || mio !== turno) return;
    if (/sesión venció/i.test(e.message)) { sesion = null; return ir('#/entrar'); }
    main.innerHTML = `<div class="tarjeta aviso"><h2>No se pudo cargar</h2><p class="nota">${esc(e.message)}</p>
      <button class="boton" type="button" id="reintentar">Reintentar</button></div>`;
    $('#reintentar').onclick = navegar;
  }
}

async function cargarPerfil() {
  perfil = await api.miPerfil().catch(() => null);
  return perfil;
}

async function iniciar() {
  if (!CONFIG_LISTA) { app.innerHTML = '<div class="cargando">La app todavía no está configurada.</div>'; return; }

  // Enlace de gestor: .../cliente/?g=GES-001
  const params = new URLSearchParams(location.search);
  const codigo = params.get('g') ?? params.get('gestor');
  if (codigo) guardarLocal(CLAVE_GESTOR, codigo.trim().toUpperCase());

  const { createClient } = await import(SUPABASE_JS);
  sb = createClient(CONFIG.supabaseUrl, CONFIG.supabaseKey, {
    auth: { storageKey: 'remesa-cliente', flowType: 'pkce', detectSessionInUrl: true, persistSession: true },
  });
  api = crearApiCliente(sb);

  let recuperando = false;
  sb.auth.onAuthStateChange((evento, s) => {
    if (evento === 'PASSWORD_RECOVERY') { recuperando = true; sesion = s; location.hash = '#/nueva-clave'; }
    if (evento === 'SIGNED_OUT' && sesion) { sesion = null; perfil = null; ir('#/entrar'); } // salida inesperada (sesión vencida)
    if (evento === 'TOKEN_REFRESHED' || evento === 'SIGNED_IN') sesion = s;
  });

  const errorEnlace = params.get('error_description');
  try { sesion = await api.sesion(); } catch { sesion = null; }
  // Quitar ?code=…, ?g=… de la barra (ya se usaron)
  if (params.has('code') || codigo || errorEnlace) history.replaceState(null, '', location.pathname + location.hash);
  if (errorEnlace) setTimeout(() => aviso('El enlace del correo ya no sirve. Pide uno nuevo.', true), 300);

  cfg = await api.configPublica().catch(() => ({}));
  if (sesion) await cargarPerfil();

  window.addEventListener('hashchange', navegar);
  window.addEventListener('online', () => $('#sin-red')?.setAttribute('hidden', ''));
  window.addEventListener('offline', () => $('#sin-red')?.removeAttribute('hidden'));
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible' && sesion && ['remesa', 'remesas'].includes(leerRuta().nombre)) navegar();
  });
  window.addEventListener('beforeinstallprompt', (e) => { e.preventDefault(); instalar = e; });

  if (!recuperando) navegar();
  if ('serviceWorker' in navigator && !['localhost', '127.0.0.1'].includes(location.hostname)) {
    navigator.serviceWorker.register('sw.js').catch(() => {});
  }
}

// ------------------------------------------------------------------ sin sesión
function marcoEntrar(html) {
  app.innerHTML = `<main class="contenido entrar">
    <div style="display:flex;flex-direction:column;gap:10px">
      <img class="logo" src="icono.svg" alt="">
      <div class="marca">Remesa<span>.cu</span></div>
    </div>${html}</main>`;
}

function calculadoraPublica() {
  return `<section class="tarjeta" aria-label="Calculadora">
    <div class="campo"><label for="calc">Si tu familia recibe</label>
      <div class="monto"><span>$</span><input id="calc" inputmode="numeric" value="350" aria-describedby="calc-res"></div></div>
    <p id="calc-res" class="nota"></p>
  </section>`;
}
function activarCalculadora() {
  const inp = $('#calc');
  if (!inp) return;
  const pinta = () => {
    const c = cotizarLocal(Number(inp.value.replace(/\D/g, '')), cfg);
    $('#calc-res').innerHTML = c.ok ? `Depositas <strong>${usd(c.total)}</strong> por Zelle (tarifa ${usd(c.tarifa)}). Ellos reciben ${usd(c.monto)} en efectivo en casa.`
      : esc(c.error);
  };
  inp.addEventListener('input', pinta); pinta();
}

function vistaEntrar() {
  marcoEntrar(`
    <p class="lema">Envía dólares a tu familia en Cuba. Pagas por Zelle, ellos reciben efectivo en casa.</p>
    <form id="f" novalidate style="display:flex;flex-direction:column;gap:14px">
      <div class="campo"><label for="correo">Correo electrónico</label><input id="correo" type="email" autocomplete="email" inputmode="email" placeholder="tu@correo.com"></div>
      <div class="campo"><label for="clave">Contraseña</label><input id="clave" type="password" autocomplete="current-password"></div>
      <a href="#/olvide" style="align-self:flex-end;font-size:14px;font-weight:600">¿Olvidaste la contraseña?</a>
      <p class="error" hidden></p>
      <button class="boton primario" type="submit">Entrar</button>
    </form>
    <div class="separa">¿Primera vez?</div>
    <a class="boton" href="#/registro">Crear cuenta</a>
    ${calculadoraPublica()}`);
  activarCalculadora();
  $('#f').addEventListener('submit', async (e) => {
    e.preventDefault();
    const err = $('.error'); err.hidden = true;
    const correo = $('#correo').value.trim(), clave = $('#clave').value;
    if (!correo || !clave) { err.textContent = 'Escribe tu correo y tu contraseña'; err.hidden = false; return; }
    const b = $('#f button[type=submit]'); b.disabled = true; b.textContent = 'Entrando…';
    try {
      const d = await api.entrar(correo, clave);
      sesion = d.session; await cargarPerfil(); ir('#/enviar');
    } catch (ex) { err.textContent = ex.message; err.hidden = false; b.disabled = false; b.textContent = 'Entrar'; }
  });
}

function vistaRegistro() {
  const codigo = leerLocal(CLAVE_GESTOR) ?? '';
  marcoEntrar(`
    <div><h1>Crear cuenta</h1><p class="lema" style="margin-top:4px">Solo una vez. Luego enviar te toma un minuto.</p></div>
    <form id="f" novalidate style="display:flex;flex-direction:column;gap:14px">
      <div class="campo"><label for="nombre">Tu nombre y apellido</label><input id="nombre" type="text" autocomplete="name"></div>
      <div class="campo"><label for="wa">Tu WhatsApp</label><input id="wa" type="tel" autocomplete="tel" placeholder="+1 305 555 1234">
        <span class="ayuda">Con el código de tu país. Por aquí te avisamos de cada paso.</span></div>
      <div class="campo"><label for="pais">Dónde vives</label><select id="pais">${PAISES.map((p) => `<option>${p}</option>`).join('')}</select></div>
      <div class="campo"><label for="correo">Correo electrónico</label><input id="correo" type="email" autocomplete="email" inputmode="email"></div>
      <div class="campo"><label for="clave">Contraseña</label><input id="clave" type="password" autocomplete="new-password"><span class="ayuda">Al menos 6 caracteres.</span></div>
      <div class="campo"><label for="gestor">Código de quien te invitó (opcional)</label><input id="gestor" type="text" value="${esc(codigo)}" placeholder="Ej. GES-012" autocapitalize="characters">
        <span class="ayuda" id="gestor-res"></span></div>
      <p class="error" hidden></p>
      <button class="boton primario" type="submit">Crear cuenta</button>
    </form>
    <p style="text-align:center;font-size:14px">¿Ya tienes cuenta? <a href="#/entrar" style="font-weight:600">Entrar</a></p>`);

  let gestorOk = true;
  const revisarGestor = async () => {
    const c = $('#gestor').value.trim();
    const res = $('#gestor-res');
    if (!c) { gestorOk = true; res.textContent = ''; return; }
    const v = await api.validarCodigoGestor(c).catch(() => ({ valido: false }));
    gestorOk = v.valido;
    res.textContent = v.valido ? `Te invitó ${v.nombre}` : 'Ese código no existe. Revísalo o déjalo vacío.';
    res.style.color = v.valido ? 'var(--acento)' : 'var(--peligro)';
  };
  $('#gestor').addEventListener('change', revisarGestor);
  if (codigo) revisarGestor();

  $('#f').addEventListener('submit', async (e) => {
    e.preventDefault();
    const err = $('.error'); err.hidden = true;
    const falla = (t) => { err.textContent = t; err.hidden = false; };
    const v = (id) => $('#' + id).value.trim();
    if (v('nombre').length < 3) return falla('Escribe tu nombre y apellido');
    if (!normalizarTelefono(v('wa'))) return falla('Escribe tu WhatsApp con el código del país, ej. +1 305 555 1234');
    if (!/^\S+@\S+\.\S+$/.test(v('correo'))) return falla('Escribe un correo válido');
    if ($('#clave').value.length < 6) return falla('La contraseña debe tener al menos 6 caracteres');
    await revisarGestor();
    if (!gestorOk) return falla('El código de quien te invitó no existe');
    const b = $('#f button[type=submit]'); b.disabled = true; b.textContent = 'Creando…';
    try {
      const d = await api.registrarse({
        correo: v('correo'), contrasena: $('#clave').value, nombre: v('nombre'), whatsapp: normalizarTelefono(v('wa')),
        pais: v('pais'), codigoGestor: v('gestor') || null, redirigirA: location.origin + location.pathname,
      });
      guardarLocal(CLAVE_GESTOR, null);
      if (d.session) {
        sesion = d.session; await cargarPerfil(); aviso('¡Bienvenido a Remesa.cu!'); ir('#/familiar/nuevo?volver=enviar');
      } else {
        marcoEntrar(`<div class="tarjeta exito"><h2>Revisa tu correo</h2>
          <p>Te mandamos un enlace a <strong>${esc(v('correo'))}</strong> para confirmar tu cuenta. Ábrelo desde este mismo teléfono.</p></div>
          <a class="boton" href="#/entrar">Ya lo confirmé, entrar</a>`);
      }
    } catch (ex) { falla(ex.message); b.disabled = false; b.textContent = 'Crear cuenta'; }
  });
}

function vistaOlvide() {
  marcoEntrar(`
    <div><h1>Recuperar contraseña</h1><p class="lema" style="margin-top:4px">Te mandamos un enlace para poner una nueva.</p></div>
    <form id="f" novalidate style="display:flex;flex-direction:column;gap:14px">
      <div class="campo"><label for="correo">Tu correo</label><input id="correo" type="email" autocomplete="email" inputmode="email"></div>
      <p class="error" hidden></p>
      <button class="boton primario" type="submit">Enviar enlace</button>
    </form>
    <a href="#/entrar" style="text-align:center;font-weight:600">Volver</a>`);
  $('#f').addEventListener('submit', async (e) => {
    e.preventDefault();
    const correo = $('#correo').value.trim();
    if (!correo) return;
    await ocupado($('#f button'), async () => {
      await api.olvideContrasena(correo, location.origin + location.pathname);
      marcoEntrar(`<div class="tarjeta exito"><h2>Revisa tu correo</h2><p>Si <strong>${esc(correo)}</strong> tiene cuenta, te llegará un enlace. Ábrelo desde este mismo teléfono.</p></div>
        <a class="boton" href="#/entrar">Volver</a>`);
    });
  });
}

function vistaNuevaClave() {
  marcoEntrar(`
    <div><h1>Nueva contraseña</h1></div>
    <form id="f" novalidate style="display:flex;flex-direction:column;gap:14px">
      <div class="campo"><label for="c1">Contraseña nueva</label><input id="c1" type="password" autocomplete="new-password"></div>
      <div class="campo"><label for="c2">Repítela</label><input id="c2" type="password" autocomplete="new-password"></div>
      <p class="error" hidden></p>
      <button class="boton primario" type="submit">Guardar</button>
    </form>`);
  $('#f').addEventListener('submit', async (e) => {
    e.preventDefault();
    const err = $('.error'); err.hidden = true;
    const a = $('#c1').value, b = $('#c2').value;
    if (a.length < 6) { err.textContent = 'Usa al menos 6 caracteres'; err.hidden = false; return; }
    if (a !== b) { err.textContent = 'Las dos no son iguales'; err.hidden = false; return; }
    await ocupado($('#f button'), async () => {
      if (!sesion) throw new Error('El enlace venció. Pide otro desde "¿Olvidaste la contraseña?"');
      await api.cambiarContrasena(a);
      await cargarPerfil();
      aviso('Contraseña guardada');
      ir('#/enviar');
    });
  });
}

// ------------------------------------------------------------------ enviar (nueva remesa)
async function vistaEnviar(ctx) {
  const familiares = await api.misFamiliares();
  if (!perfil) await cargarPerfil();
  const elegido = Number(ctx.r.q.get('familiar')) || familiares[0]?.id;
  const montoInicial = Number(sessionStorage.getItem('remesa-monto')) || 0;
  const min = Number(cfg.monto_minimo ?? 50), max = Number(cfg.monto_maximo ?? 3000);
  const rapidos = [100, 200, 300, 500].filter((v) => v >= min && v <= max);
  const faltaPerfil = !perfil?.whatsapp || !perfil?.nombre;
  const codigo = leerLocal(CLAVE_GESTOR) ?? '';

  ctx.pintar(`
    <div class="titulo-vista"><h1>Nueva remesa</h1><p>¿Cuánto quieres que reciba tu familia?</p></div>
    ${faltaPerfil ? `<a class="tarjeta aviso" href="#/perfil" style="text-decoration:none;color:inherit"><strong>Completa tu perfil</strong><span class="nota">Necesitamos tu nombre y WhatsApp para avisarte de cada paso.</span></a>` : ''}
    <section class="tarjeta">
      <label for="monto" class="etq" style="font-size:13px;font-weight:600;color:#3E4944">Monto a entregar en Cuba (USD en efectivo)</label>
      <div class="monto"><span>$</span><input id="monto" inputmode="numeric" autocomplete="off" value="${montoInicial || ''}" placeholder="0"></div>
      <div class="pastillas">${rapidos.map((v) => `<button type="button" class="pastilla" data-monto="${v}">$${v}</button>`).join('')}</div>
      <p class="error" id="error-monto" hidden></p>
    </section>
    <section class="tarjeta oscura" aria-live="polite">
      <div class="fila-dinero"><span>Recibe tu familia</span><span id="r-monto">—</span></div>
      <div class="fila-dinero"><span>Tarifa ($${esc(cfg.tarifa_por_bloque ?? 10)} por cada $${esc(cfg.tarifa_bloque ?? 100)} o fracción)</span><span id="r-tarifa">—</span></div>
      <div class="raya"></div>
      <div class="fila-dinero total"><span>Depositas por Zelle</span><span class="cifra" id="r-total">—</span></div>
    </section>
    <section class="tarjeta">
      <div class="encabezado"><h2>¿Quién recibe?</h2><a href="#/familiar/nuevo?volver=enviar" style="font-size:14px;font-weight:600">+ Nuevo</a></div>
      ${familiares.length ? `<div class="lista" role="radiogroup" aria-label="Quién recibe">${familiares.map((f) => `
        <label class="opcion"><input type="radio" name="familiar" value="${f.id}" ${f.id === elegido ? 'checked' : ''}>
          <span><span class="nombre">${esc(f.nombre)}</span><span class="sub">${esc([f.direccion, f.municipio, f.provincia].filter(Boolean).join(', '))}</span></span></label>`).join('')}</div>`
      : `<div class="vacio"><span>Agrega a la persona que recibe el dinero en Cuba.</span><a class="boton" href="#/familiar/nuevo?volver=enviar">Agregar familiar</a></div>`}
    </section>
    ${!perfil?.gestor_id ? `<div class="campo"><label for="codigo">Código de quien te invitó (opcional)</label>
      <input id="codigo" type="text" value="${esc(codigo)}" placeholder="Ej. GES-012" autocapitalize="characters"></div>` : ''}
    <div class="campo"><label for="nota">Nota para la entrega (opcional)</label><input id="nota" type="text" maxlength="200" placeholder="Ej. llamar antes de ir"></div>
    <button class="boton primario" type="button" id="solicitar">Solicitar remesa</button>
    <p class="nota" style="text-align:center">Después te mostramos a qué Zelle depositar.</p>`);

  const inp = $('#monto');
  const pintar = () => {
    const m = Number(inp.value.replace(/\D/g, ''));
    if (String(m || '') !== inp.value) inp.value = m || '';
    sessionStorage.setItem('remesa-monto', m || '');
    $$('[data-monto]').forEach((b) => b.setAttribute('aria-pressed', String(Number(b.dataset.monto) === m)));
    const c = cotizarLocal(m, cfg);
    const err = $('#error-monto');
    err.hidden = !m || c.ok; err.textContent = c.ok ? '' : c.error;
    $('#r-monto').textContent = c.ok ? usd(c.monto) : '—';
    $('#r-tarifa').textContent = c.ok ? usd(c.tarifa) : '—';
    $('#r-total').textContent = c.ok ? usd(c.total) : '—';
    $('#solicitar').textContent = c.ok ? `Solicitar remesa de ${usd(c.total)}` : 'Solicitar remesa';
    return c;
  };
  inp.addEventListener('input', pintar);
  $$('[data-monto]').forEach((b) => b.addEventListener('click', () => { inp.value = b.dataset.monto; pintar(); }));
  pintar();

  $('#solicitar').addEventListener('click', (e) => ocupado(e.currentTarget, async () => {
    const c = pintar();
    if (!c.ok) { inp.focus(); throw new Error(c.error); }
    const fam = $('input[name=familiar]:checked')?.value;
    if (!fam) throw new Error('Elige o agrega a quién le llega el dinero');
    if (faltaPerfil) { ir('#/perfil'); throw new Error('Completa tu perfil primero'); }
    const r = await api.crearRemesa({ familiarId: Number(fam), monto: c.monto, codigoGestor: $('#codigo')?.value.trim() || null, nota: $('#nota').value.trim() || null });
    sessionStorage.removeItem('remesa-monto');
    guardarLocal(CLAVE_GESTOR, null);
    if (!perfil.gestor_id && $('#codigo')?.value.trim()) await cargarPerfil();
    ir(`#/remesa/${r.id}?nueva=1`);
  }));
}

// ------------------------------------------------------------------ seguimiento de una remesa
function pasos(r) {
  const lista = [
    { t: 'Solicitud enviada', s: fechaHora(r.creado_at), hecho: true },
    { t: 'Zelle recibido', hecho: !!r.zelle_confirmado_at,
      s: r.zelle_confirmado_at ? fechaHora(r.zelle_confirmado_at) : r.cliente_reporto_pago_at ? 'Avisaste que depositaste. Lo estamos confirmando.' : 'Esperando tu depósito' },
    { t: 'Fecha de entrega', hecho: !!r.fecha_entrega && !!r.zelle_confirmado_at,
      s: r.fecha_entrega ? `${fechaLarga(r.fecha_entrega)} · ${(FRANJAS[r.franja] ?? '').toLowerCase()}` : 'Te avisamos qué día se entrega' },
    { t: 'Entregado', hecho: !!r.entregada_at, s: r.entregada_at ? `${fechaHora(r.entregada_at)} · con recibo firmado` : `${usd(r.monto_entrega)} en efectivo en la casa` },
  ];
  const actual = lista.findIndex((p) => !p.hecho);
  return `<ol class="pasos">${lista.map((p, i) => `
    <li class="${p.hecho ? 'hecho' : i === actual ? 'actual' : ''}">
      <div class="marca-paso"><div class="punto"></div>${i < lista.length - 1 ? '<div class="linea"></div>' : ''}</div>
      <div class="texto"><strong>${p.t}</strong><span>${esc(p.s)}</span></div></li>`).join('')}</ol>`;
}

function bloquePago(r) {
  if (r.estado !== 'esperando_zelle') return '';
  if (!r.zelle_titular) {
    return `<section class="tarjeta aviso"><h2>Te enviamos los datos del Zelle por WhatsApp</h2>
      <p class="nota">En unos minutos te escribimos a qué cuenta depositar <strong>${usd(r.total_zelle)}</strong>.</p></section>`;
  }
  if (r.cliente_reporto_pago_at) {
    return `<section class="tarjeta aviso">
      <div style="display:flex;gap:8px;align-items:center;color:var(--e1-t)">${icono('reloj')}<strong>Estamos confirmando tu Zelle</strong></div>
      <p class="nota">Nos avisaste el ${esc(fechaHora(r.cliente_reporto_pago_at))}. Te escribimos por WhatsApp en cuanto llegue.</p>
      ${r.comprobante_pago_path ? '<p class="nota">Recibimos tu captura.</p>' : '<button class="boton chico" type="button" data-accion="pagado">Enviar la captura del Zelle</button>'}
    </section>`;
  }
  return `<section class="tarjeta aviso">
    <div style="display:flex;gap:8px;align-items:center;color:var(--e1-t)">${icono('reloj')}<strong>Falta tu depósito</strong></div>
    <p>Envía exactamente <strong>${usd(r.total_zelle)}</strong> por Zelle a:</p>
    <div class="copiable"><span><span class="etq">Nombre</span><span class="val">${esc(r.zelle_titular)}</span></span></div>
    <div class="copiable"><span><span class="etq">Correo o teléfono de Zelle</span><span class="val">${esc(r.zelle_contacto)}</span></span>
      <button class="boton chico" type="button" data-copiar="${esc(r.zelle_contacto)}">${icono('copiar')} Copiar</button></div>
    <div class="copiable"><span><span class="etq">En el memo escribe</span><span class="val">${esc(r.codigo)}</span></span>
      <button class="boton chico" type="button" data-copiar="${esc(r.codigo)}">${icono('copiar')} Copiar</button></div>
    <div class="copiable"><span><span class="etq">Monto exacto</span><span class="val">${usd(r.total_zelle)}</span></span>
      <button class="boton chico" type="button" data-copiar="${esc(fmtUsd(r.total_zelle))}">${icono('copiar')} Copiar</button></div>
    <button class="boton oscuro" type="button" data-accion="pagado">Ya deposité</button>
  </section>`;
}

async function vistaRemesa(ctx) {
  const r = await api.miRemesa(Number(ctx.r.id));
  if (!r) { ctx.pintar('<div class="vacio">No encontramos esa remesa. <a href="#/remesas">Ver mis remesas</a></div>'); return; }
  const nueva = ctx.r.q.get('nueva') === '1';
  const wa = enlaceNegocio(`Hola, les escribo por mi remesa ${r.codigo}.`);

  ctx.pintar(`
    <a class="volver" href="#/remesas">${icono('atras', 18)} Mis remesas</a>
    <div class="titulo-vista"><div style="display:flex;gap:10px;align-items:center;flex-wrap:wrap"><h1>Remesa ${esc(r.codigo)}</h1>${chip(r)}</div>
      <p>Para ${esc(r.beneficiario_nombre)}</p></div>
    ${nueva && r.estado === 'esperando_zelle' ? '<section class="tarjeta exito"><h2>¡Listo! Ahora deposita por Zelle</h2><p class="nota">Cuando lo envíes, toca "Ya deposité" para avisarnos.</p></section>' : ''}
    ${bloquePago(r)}
    ${r.estado === 'cancelada' ? `<section class="tarjeta"><h2>Remesa cancelada</h2><p class="nota">${esc(r.motivo_cancelacion ?? '')}</p></section>` : `<section class="tarjeta"><h2>Estado</h2>${pasos(r)}</section>`}
    ${r.estado === 'entregada' && r.recibo_path ? `<section class="tarjeta exito"><h2>Recibo firmado</h2><img class="foto" id="recibo" alt="Recibo firmado por ${esc(r.beneficiario_nombre)}"></section>` : ''}
    <section class="tarjeta">
      <div class="datos">
        <div><span class="etq">Recibe</span><span class="val">${usd(r.monto_entrega)}</span></div>
        <div><span class="etq">Tarifa</span><span class="val">${usd(r.tarifa)}</span></div>
        <div><span class="etq">Total Zelle</span><span class="val">${usd(r.total_zelle)}</span></div>
        <div><span class="etq">Solicitada</span><span class="val">${esc(fechaCorta(r.creado_at))}</span></div>
        <div class="ancho"><span class="etq">Dirección de entrega</span><span class="val">${esc([r.beneficiario_direccion, r.beneficiario_municipio, r.beneficiario_provincia].filter(Boolean).join(', '))}</span></div>
        ${r.nota_cliente ? `<div class="ancho"><span class="etq">Tu nota</span><span class="val">${esc(r.nota_cliente)}</span></div>` : ''}
      </div>
    </section>
    ${wa ? `<a class="boton wa" href="${esc(wa)}" target="_blank" rel="noopener">${icono('wa')} Escribirnos por WhatsApp</a>` : ''}
    ${r.estado === 'esperando_zelle' && !r.cliente_reporto_pago_at ? '<button class="boton texto peligro" type="button" data-accion="cancelar">Cancelar esta remesa</button>' : ''}`);

  if (r.recibo_path) api.urlRecibo(r.recibo_path).then((u) => { const i = $('#recibo'); if (i) i.src = u; }).catch(() => {});
  $$('[data-copiar]').forEach((b) => b.addEventListener('click', () => copiar(b.dataset.copiar)));

  $$('[data-accion=pagado]').forEach((b) => b.addEventListener('click', () => {
    const h = hoja('Ya deposité', `
      <p>Avísanos que enviaste <strong>${usd(r.total_zelle)}</strong> a ${esc(r.zelle_titular)}. Si tienes la captura de pantalla del Zelle, súbela: así confirmamos más rápido.</p>
      <div class="campo"><label for="captura">Captura del Zelle (opcional)</label><input id="captura" type="file" accept="image/*,application/pdf"></div>
      <button class="boton primario" type="button" id="enviar-aviso">Enviar aviso</button>`);
    $('#enviar-aviso', h.el).addEventListener('click', (e) => ocupado(e.currentTarget, async () => {
      await api.reportarPago(r.id, $('#captura', h.el).files[0] ?? null);
      h.cerrar(); aviso('¡Gracias! Te avisamos cuando confirmemos.'); ir(`#/remesa/${r.id}`);
    }));
  }));

  $('[data-accion=cancelar]')?.addEventListener('click', () => {
    const h = hoja('Cancelar remesa', `
      <p>¿Seguro? Si ya enviaste el Zelle, no la canceles: escríbenos.</p>
      <div class="campo"><label for="motivo">¿Por qué? (opcional)</label><input id="motivo" type="text"></div>
      <button class="boton peligro" type="button" id="si-cancelar">Sí, cancelar</button>`);
    $('#si-cancelar', h.el).addEventListener('click', (e) => ocupado(e.currentTarget, async () => {
      await api.cancelar(r.id, $('#motivo', h.el).value.trim());
      h.cerrar(); aviso('Remesa cancelada'); ir(`#/remesa/${r.id}`);
    }));
  });
}

// ------------------------------------------------------------------ mis remesas
async function vistaRemesas(ctx) {
  const lista = await api.misRemesas();
  const anio = new Date().getFullYear();
  const total = lista.filter((r) => r.estado === 'entregada' && new Date(r.entregada_at).getFullYear() === anio)
    .reduce((s, r) => s + Number(r.monto_entrega), 0);
  ctx.pintar(`
    <div class="titulo-vista"><h1>Mis remesas</h1><p>Toca una para ver su estado</p></div>
    ${lista.length ? `<div class="lista">${lista.map((r) => `
      <a class="remesa-item" href="#/remesa/${r.id}">
        <span class="izq"><span class="nombre">${esc(r.beneficiario_nombre)}</span><span class="sub">${esc(r.codigo)} · ${esc(fechaCorta(r.creado_at))}</span></span>
        <span class="der"><span class="cifra">${usd(r.monto_entrega)}</span>${chip(r)}</span>
      </a>`).join('')}</div>
      <section class="tarjeta" style="background:#E9EFEC;border-color:#D5E2DC;gap:4px"><span class="nota" style="font-weight:600;color:var(--tinta)">Entregado este año</span>
        <span class="cifra" style="font-size:22px;font-weight:700">${usd(total)}</span></section>`
    : '<div class="vacio"><span>Todavía no has enviado remesas.</span><a class="boton primario" href="#/enviar">Enviar la primera</a></div>'}`);
}

// ------------------------------------------------------------------ familiares
async function vistaFamiliares(ctx) {
  const lista = await api.misFamiliares();
  ctx.pintar(`
    <div class="titulo-vista"><h1>Familiares</h1><p>Las personas que reciben el dinero en Cuba</p></div>
    ${lista.length ? `<div class="lista">${lista.map((f) => `
      <a class="remesa-item" href="#/familiar/${f.id}">
        <span class="izq"><span class="nombre">${esc(f.nombre)}</span><span class="sub">${esc([f.direccion, f.municipio, f.provincia].filter(Boolean).join(', '))}</span>
        ${f.telefono ? `<span class="sub">${esc(f.telefono)}</span>` : ''}</span>
        <span class="der" style="color:var(--acento);font-size:14px;font-weight:600">Editar</span>
      </a>`).join('')}</div>` : '<div class="vacio">Todavía no tienes familiares guardados.</div>'}
    <a class="boton primario" href="#/familiar/nuevo">Agregar familiar</a>`);
}

async function vistaFamiliar(ctx) {
  const nuevo = ctx.r.id === 'nuevo';
  const volver = ctx.r.q.get('volver');
  const f = nuevo ? {} : (await api.misFamiliares()).find((x) => x.id === Number(ctx.r.id));
  if (!f) { ctx.pintar('<div class="vacio">No encontramos ese familiar. <a href="#/familiares">Volver</a></div>'); return; }
  const atras = volver === 'enviar' ? '#/enviar' : '#/familiares';
  ctx.pintar(`
    <a class="volver" href="${atras}">${icono('atras', 18)} Volver</a>
    <div class="titulo-vista"><h1>${nuevo ? 'Nuevo familiar' : 'Editar familiar'}</h1><p>Quién recibe el efectivo y dónde se lo llevamos</p></div>
    <form id="f" class="tarjeta" novalidate>
      <div class="campo"><label for="nombre">Nombre y apellidos</label><input id="nombre" type="text" value="${esc(f.nombre ?? '')}" autocomplete="off"></div>
      <div class="campo"><label for="tel">Teléfono en Cuba</label><input id="tel" type="tel" value="${esc(f.telefono ?? '')}" placeholder="5 555 1234">
        <span class="ayuda">Para avisarle el día de la entrega.</span></div>
      <div class="campo"><label for="dir">Dirección</label><input id="dir" type="text" value="${esc(f.direccion ?? '')}" placeholder="Calle, número, entre calles, reparto"></div>
      <div class="campo"><label for="prov">Provincia</label><select id="prov"><option value="">Elige…</option>
        ${PROVINCIAS.map((p) => `<option ${p === f.provincia ? 'selected' : ''}>${p}</option>`).join('')}</select></div>
      <div class="campo"><label for="mun">Municipio</label><input id="mun" type="text" value="${esc(f.municipio ?? '')}"></div>
      <div class="campo"><label for="ref">Cómo llegar (opcional)</label><input id="ref" type="text" value="${esc(f.referencia ?? '')}" placeholder="Ej. casa azul al lado de la bodega"></div>
      <p class="error" hidden></p>
      <button class="boton primario" type="submit">Guardar</button>
      ${nuevo ? '' : '<button class="boton texto peligro" type="button" id="quitar">Quitar de mi lista</button>'}
    </form>`);
  $('#f').addEventListener('submit', (e) => {
    e.preventDefault();
    const err = $('.error'); err.hidden = true;
    const v = (id) => $('#' + id).value.trim();
    if (v('nombre').length < 2) { err.textContent = 'Escribe el nombre'; err.hidden = false; return; }
    if (v('dir').length < 5) { err.textContent = 'Escribe la dirección completa'; err.hidden = false; return; }
    if (!v('prov')) { err.textContent = 'Elige la provincia'; err.hidden = false; return; }
    ocupado($('#f button[type=submit]'), async () => {
      const g = await api.guardarFamiliar({ id: f.id, nombre: v('nombre'), telefono: v('tel'), direccion: v('dir'),
        municipio: v('mun'), provincia: v('prov'), referencia: v('ref') });
      aviso('Guardado');
      ir(volver === 'enviar' ? `#/enviar?familiar=${g.id}` : '#/familiares');
    });
  });
  $('#quitar')?.addEventListener('click', (e) => ocupado(e.currentTarget, async () => {
    await api.quitarFamiliar(f.id); aviso('Quitado'); ir('#/familiares');
  }));
}

// ------------------------------------------------------------------ perfil
async function vistaPerfil(ctx) {
  await cargarPerfil();
  const p = perfil ?? {};
  const esIOS = /iphone|ipad|ipod/i.test(navigator.userAgent) && !window.navigator.standalone;
  const instalada = window.matchMedia('(display-mode: standalone)').matches || window.navigator.standalone;
  const wa = enlaceNegocio('Hola, tengo una pregunta sobre Remesa.cu.');
  ctx.pintar(`
    <div class="titulo-vista"><h1>Mi cuenta</h1><p>${esc(p.correo ?? sesion?.user?.email ?? '')}</p></div>
    <form id="f" class="tarjeta" novalidate>
      <div class="campo"><label for="nombre">Nombre y apellido</label><input id="nombre" type="text" value="${esc(p.nombre ?? '')}" autocomplete="name"></div>
      <div class="campo"><label for="wa">WhatsApp</label><input id="wa" type="tel" value="${esc(p.whatsapp ? '+' + p.whatsapp : '')}" placeholder="+1 305 555 1234" autocomplete="tel">
        <span class="ayuda">Con el código de tu país.</span></div>
      <div class="campo"><label for="pais">Dónde vives</label><select id="pais">
        ${[...new Set([...PAISES, p.pais].filter(Boolean))].map((x) => `<option ${x === p.pais ? 'selected' : ''}>${esc(x)}</option>`).join('')}</select></div>
      <p class="error" hidden></p>
      <button class="boton primario" type="submit">Guardar</button>
    </form>
    ${!instalada && (instalar || esIOS) ? `<section class="tarjeta"><h2>Tener la app en tu teléfono</h2>
      ${instalar ? '<button class="boton" type="button" id="instalar">Instalar Remesa.cu</button>'
        : '<p class="nota">En el iPhone: toca el botón <strong>Compartir</strong> de Safari y luego <strong>Agregar a pantalla de inicio</strong>.</p>'}</section>` : ''}
    <section class="tarjeta">
      <h2>Cambiar contraseña</h2>
      <div class="campo"><label for="c1">Contraseña nueva</label><input id="c1" type="password" autocomplete="new-password"></div>
      <button class="boton" type="button" id="cambiar">Cambiar</button>
    </section>
    ${wa ? `<a class="boton wa" href="${esc(wa)}" target="_blank" rel="noopener">${icono('wa')} Escribirnos por WhatsApp</a>` : ''}
    <button class="boton" type="button" id="salir">Cerrar sesión</button>`);

  $('#f').addEventListener('submit', (e) => {
    e.preventDefault();
    const err = $('.error'); err.hidden = true;
    const nombre = $('#nombre').value.trim(), wa = normalizarTelefono($('#wa').value);
    if (nombre.length < 3) { err.textContent = 'Escribe tu nombre y apellido'; err.hidden = false; return; }
    if (!wa) { err.textContent = 'Escribe tu WhatsApp con el código del país'; err.hidden = false; return; }
    ocupado($('#f button'), async () => {
      perfil = await api.actualizarPerfil({ nombre, whatsapp: wa, pais: $('#pais').value });
      aviso('Guardado');
    });
  });
  $('#instalar')?.addEventListener('click', async () => { instalar.prompt(); await instalar.userChoice; instalar = null; navegar(); });
  $('#cambiar').addEventListener('click', (e) => ocupado(e.currentTarget, async () => {
    const a = $('#c1').value;
    if (a.length < 6) throw new Error('Usa al menos 6 caracteres');
    await api.cambiarContrasena(a); $('#c1').value = ''; aviso('Contraseña cambiada');
  }));
  $('#salir').addEventListener('click', async () => { sesion = null; perfil = null; await api.salir().catch(() => {}); ir('#/entrar'); });
}

iniciar();
