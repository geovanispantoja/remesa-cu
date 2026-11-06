// =====================================================================
// Remesa.cu · cliente JS compartido por la PWA del cliente y la web de admin
//
// Uso en una página estática (GitHub Pages):
//   <script type="module">
//     import { createClient } from 'https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2.45.4/+esm';
//     import { crearApiCliente, crearApiAdmin } from './compartido/remesa-api.js';
//     const sb = createClient(SUPABASE_URL, SUPABASE_PUBLISHABLE_KEY);  // sb_publishable_…
//     const api = crearApiCliente(sb);
//   </script>
//
// La publishable key (antes "anon") es pública: lo que protege los datos son las reglas de
// la base de datos (003_seguridad.sql), no esconder la clave.
// =====================================================================

// ---------------------------------------------------------------- utilidades puras

/** Misma regla que calcular_tarifa() en la base de datos. Solo para mostrar en vivo; la base manda. */
export function calcularTarifa(monto, cfg = {}) {
  const bloque = Number(cfg.tarifa_bloque ?? 100) || 100;
  const porBloque = Number(cfg.tarifa_por_bloque ?? 10);
  const minima = Number(cfg.tarifa_minima ?? 10);
  const m = Number(monto);
  if (!Number.isFinite(m) || m <= 0) return 0;
  return Math.max(minima, Math.ceil(m / bloque) * porBloque);
}

/** Igual que validar_monto(): devuelve el texto del error o null. */
export function validarMonto(monto, cfg = {}) {
  const min = Number(cfg.monto_minimo ?? 50);
  const max = Number(cfg.monto_maximo ?? 3000);
  const mult = Number(cfg.monto_multiplo ?? 10);
  const m = Number(monto);
  if (!Number.isFinite(m) || m <= 0) return 'Escribe cuánto quieres que reciba tu familia';
  if (!Number.isInteger(m)) return 'El monto debe ser en dólares enteros';
  if (m < min) return `El monto mínimo es $${fmtUsd(min)}`;
  if (m > max) return `El monto máximo por remesa es $${fmtUsd(max)}`;
  if (mult > 0 && m % mult !== 0) return `El monto debe ser múltiplo de $${fmtUsd(mult)}`;
  return null;
}

export function cotizarLocal(monto, cfg = {}) {
  const error = validarMonto(monto, cfg);
  if (error) return { ok: false, error, monto: Number(monto) };
  const tarifa = calcularTarifa(monto, cfg);
  return { ok: true, monto: Number(monto), tarifa, total: Number(monto) + tarifa };
}

export function fmtUsd(n) {
  const v = Number(n);
  if (!Number.isFinite(v)) return '';
  return Number.isInteger(v) ? String(v) : v.toFixed(2);
}

/** Igual que normalizar_telefono() en la base. */
export function normalizarTelefono(texto) {
  if (texto == null) return null;
  const t = String(texto).trim();
  const internacional = t.startsWith('+') || t.startsWith('00');
  let d = t.replace(/\D/g, '');
  if (d.startsWith('00')) d = d.slice(2);
  if (!internacional) {
    if (d.length === 8 && d.startsWith('5')) d = '53' + d;
    else if (d.length === 10 && !d.startsWith('535')) d = '1' + d;
  }
  if (d.length < 8 || d.length > 15) return null;
  return d;
}

/** Enlace que abre WhatsApp con el chat y el texto ya escritos. */
export function enlaceWhatsApp(telefono, texto = '') {
  const tel = normalizarTelefono(telefono);
  if (!tel) throw new Error('Número de WhatsApp inválido');
  const q = texto ? `?text=${encodeURIComponent(texto)}` : '';
  return `https://wa.me/${tel}${q}`;
}

export const ESTADOS = {
  esperando_zelle:    { texto: 'Esperando Zelle',     paso: 1 },
  zelle_confirmado:   { texto: 'Zelle confirmado',    paso: 2 },
  entrega_programada: { texto: 'Entrega programada',  paso: 3 },
  entregada:          { texto: 'Entregada',           paso: 4 },
  cancelada:          { texto: 'Cancelada',           paso: 0 },
};

export const FRANJAS = { manana: 'Mañana', tarde: 'Tarde', todo_el_dia: 'Todo el día' };

/** Convierte cualquier error de Supabase en un texto para mostrar. */
export function textoError(e) {
  const msg = e?.message ?? String(e ?? 'Error desconocido');
  if (/JWT expired|invalid JWT|refresh_token/i.test(msg)) return 'Tu sesión venció. Vuelve a entrar.';
  if (/permission denied|42501/i.test(msg)) return 'No tienes permiso para hacer esto.';
  if (/Invalid login credentials/i.test(msg)) return 'Correo o contraseña incorrectos.';
  if (/User already registered/i.test(msg)) return 'Ya existe una cuenta con ese correo.';
  if (/Failed to fetch|NetworkError|network/i.test(msg)) return 'Sin conexión. Revisa tu internet e intenta otra vez.';
  return msg;
}

// Hace una llamada a Supabase y lanza un Error con texto legible si falla.
async function correr(promesa) {
  const { data, error } = await promesa;
  if (error) {
    const err = new Error(textoError(error));
    err.original = error;
    throw err;
  }
  return data;
}

function extension(archivo) {
  const tipo = archivo?.type || '';
  if (tipo.includes('png')) return 'png';
  if (tipo.includes('webp')) return 'webp';
  if (tipo.includes('pdf')) return 'pdf';
  return 'jpg';
}

/**
 * Achica una foto en el navegador antes de subirla (ahorra datos y espacio).
 * Solo funciona en el navegador. Los PDF pasan sin tocar.
 */
export async function comprimirImagen(archivo, ladoMax = 1600, calidad = 0.75) {
  if (!archivo?.type?.startsWith('image/') || typeof document === 'undefined') return archivo;
  const bitmap = await createImageBitmap(archivo);
  const escala = Math.min(1, ladoMax / Math.max(bitmap.width, bitmap.height));
  const canvas = document.createElement('canvas');
  canvas.width = Math.round(bitmap.width * escala);
  canvas.height = Math.round(bitmap.height * escala);
  canvas.getContext('2d').drawImage(bitmap, 0, 0, canvas.width, canvas.height);
  const blob = await new Promise((ok) => canvas.toBlob(ok, 'image/jpeg', calidad));
  return blob ? new File([blob], 'foto.jpg', { type: 'image/jpeg' }) : archivo;
}

// ---------------------------------------------------------------- PWA del cliente (A)

export function crearApiCliente(sb) {
  return {
    // Sesión
    registrarse: ({ correo, contrasena, nombre, whatsapp, pais, codigoGestor, redirigirA }) =>
      correr(sb.auth.signUp({
        email: correo, password: contrasena,
        options: {
          data: { nombre, whatsapp, pais, codigo_gestor: codigoGestor || null },
          emailRedirectTo: redirigirA,
        },
      })),
    entrar: (correo, contrasena) => correr(sb.auth.signInWithPassword({ email: correo, password: contrasena })),
    entrarConEnlace: (correo, redirigirA) =>
      correr(sb.auth.signInWithOtp({ email: correo, options: { emailRedirectTo: redirigirA, shouldCreateUser: false } })),
    olvideContrasena: (correo, redirigirA) => correr(sb.auth.resetPasswordForEmail(correo, { redirectTo: redirigirA })),
    cambiarContrasena: (nueva) => correr(sb.auth.updateUser({ password: nueva })),
    salir: () => correr(sb.auth.signOut()),
    sesion: async () => (await correr(sb.auth.getSession())).session,
    alCambiarSesion: (fn) => sb.auth.onAuthStateChange((_evento, sesion) => fn(sesion)),

    // Datos públicos
    configPublica: () => correr(sb.rpc('config_publica')),
    cotizar: (monto) => correr(sb.rpc('cotizar', { p_monto: monto })),
    validarCodigoGestor: (codigo) => correr(sb.rpc('validar_codigo_gestor', { p_codigo: codigo })),

    // Perfil
    miPerfil: () => correr(sb.from('perfiles').select('id, nombre, whatsapp, pais, correo, gestor_id').single()),
    actualizarPerfil: async ({ nombre, whatsapp, pais }) => {
      const { session } = await correr(sb.auth.getSession());
      if (!session) throw new Error('Inicia sesión primero');
      return correr(sb.from('perfiles').update({ nombre, whatsapp, pais }).eq('id', session.user.id).select().single());
    },

    // Familiares en Cuba
    misFamiliares: () => correr(sb.from('beneficiarios').select('*').eq('activo', true).order('nombre')),
    guardarFamiliar: async (f) => {
      const { session } = await correr(sb.auth.getSession());
      if (!session) throw new Error('Inicia sesión primero');
      const fila = {
        cliente_id: session.user.id, nombre: f.nombre, telefono: f.telefono || null, direccion: f.direccion,
        municipio: f.municipio || null, provincia: f.provincia || null, referencia: f.referencia || null,
      };
      return f.id
        ? correr(sb.from('beneficiarios').update(fila).eq('id', f.id).select().single())
        : correr(sb.from('beneficiarios').insert(fila).select().single());
    },
    // No se borra para no perder la referencia en remesas viejas; solo se oculta.
    quitarFamiliar: (id) => correr(sb.from('beneficiarios').update({ activo: false }).eq('id', id)),

    // Remesas
    crearRemesa: ({ familiarId, monto, codigoGestor, nota }) =>
      correr(sb.rpc('crear_remesa', {
        p_beneficiario_id: familiarId, p_monto: monto, p_codigo_gestor: codigoGestor || null, p_nota: nota || null,
      })),
    misRemesas: () => correr(sb.rpc('mis_remesas')),
    miRemesa: async (id) => (await correr(sb.rpc('mis_remesas', { p_id: id })))[0] ?? null,
    historial: (remesaId) => correr(sb.rpc('mis_eventos', { p_remesa_id: remesaId })),
    cancelar: (remesaId, motivo) => correr(sb.rpc('cancelar_mi_remesa', { p_remesa_id: remesaId, p_motivo: motivo || null })),

    /** "Ya deposité". La captura es opcional. */
    reportarPago: async (remesaId, archivo = null) => {
      let path = null;
      if (archivo) {
        const { session } = await correr(sb.auth.getSession());
        const listo = await comprimirImagen(archivo);
        path = `${session.user.id}/${remesaId}-${Date.now()}.${extension(listo)}`;
        await correr(sb.storage.from('comprobantes').upload(path, listo, { contentType: listo.type }));
      }
      return correr(sb.rpc('reportar_pago', { p_remesa_id: remesaId, p_comprobante_path: path }));
    },

    /** URL temporal (1 hora) para ver el recibo firmado de una remesa entregada. */
    urlRecibo: async (recibo_path) =>
      (await correr(sb.storage.from('recibos').createSignedUrl(recibo_path, 3600))).signedUrl,
  };
}

// ---------------------------------------------------------------- Web de admin (B)

/**
 * La web de admin pide SOLO la contraseña: el correo del admin va fijo aquí.
 * Ese usuario se crea una vez en Supabase (ver README).
 */
export function crearApiAdmin(sb, { correoAdmin }) {
  const rpc = (fn, args) => correr(sb.rpc(fn, args));

  const api = {
    entrar: async (contrasena) => {
      const data = await correr(sb.auth.signInWithPassword({ email: correoAdmin, password: contrasena }));
      const esAdmin = await correr(sb.rpc('es_admin'));
      if (!esAdmin) {
        await sb.auth.signOut();
        throw new Error('Esta cuenta no es de administrador');
      }
      return data;
    },
    salir: () => correr(sb.auth.signOut()),
    sesion: async () => (await correr(sb.auth.getSession())).session,

    // Tablero
    resumen: (desde, hasta) => rpc('admin_resumen', { p_desde: desde ?? null, p_hasta: hasta ?? null }),
    resumenGestores: (desde, hasta) => rpc('admin_resumen_gestores', { p_desde: desde ?? null, p_hasta: hasta ?? null }),
    resumenCuentasZelle: (desde, hasta) =>
      rpc('admin_resumen_cuentas_zelle', { p_desde: desde ?? null, p_hasta: hasta ?? null }),

    /** Lista de remesas. estado = 'esperando_zelle' | ... | null (todas). */
    remesas: ({ estado = null, desde = null, hasta = null, buscar = null, limite = 200 } = {}) => {
      let q = sb.from('remesas').select('*').order('creado_at', { ascending: false }).limit(limite);
      if (estado) q = q.eq('estado', estado);
      if (desde) q = q.gte('creado_at', desde);
      if (hasta) q = q.lte('creado_at', hasta);
      if (buscar) {
        const b = buscar.replace(/[%,()]/g, ' ').trim();
        q = q.or(`codigo.ilike.%${b}%,cliente_nombre.ilike.%${b}%,beneficiario_nombre.ilike.%${b}%`);
      }
      return correr(q);
    },
    remesa: (id) => correr(sb.from('remesas').select('*').eq('id', id).single()),
    historial: (id) => correr(sb.from('remesa_eventos').select('*').eq('remesa_id', id).order('creado_at')),
    entregasDelDia: (fecha) =>
      correr(sb.from('remesas').select('*').eq('estado', 'entrega_programada').eq('fecha_entrega', fecha)
        .order('beneficiario_municipio').order('beneficiario_direccion')),
    guardarNota: (id, notas_admin) => correr(sb.from('remesas').update({ notas_admin }).eq('id', id)),

    // Ciclo de la remesa
    confirmarZelle: (id, montoRecibido = null, forzar = false) =>
      rpc('admin_confirmar_zelle', { p_remesa_id: id, p_monto_recibido: montoRecibido, p_forzar: forzar }),
    programarEntrega: (id, fecha, franja = 'todo_el_dia') =>
      rpc('admin_programar_entrega', { p_remesa_id: id, p_fecha: fecha, p_franja: franja }),
    marcarEntregada: async (id, archivoRecibo = null, nota = null) => {
      let path = null;
      if (archivoRecibo) {
        const listo = await comprimirImagen(archivoRecibo);
        path = `${id}/recibo-${Date.now()}.${extension(listo)}`;
        await correr(sb.storage.from('recibos').upload(path, listo, { contentType: listo.type }));
      }
      return rpc('admin_marcar_entregada', { p_remesa_id: id, p_recibo_path: path, p_nota: nota });
    },
    cancelar: (id, motivo) => rpc('admin_cancelar', { p_remesa_id: id, p_motivo: motivo }),
    corregirEstado: (id, estado, motivo) =>
      rpc('admin_corregir_estado', { p_remesa_id: id, p_estado: estado, p_motivo: motivo }),
    ajustarMonto: (id, monto) => rpc('admin_ajustar_monto', { p_remesa_id: id, p_monto: monto }),
    asignarGestor: (id, gestorId) => rpc('admin_asignar_gestor', { p_remesa_id: id, p_gestor_id: gestorId }),
    asignarCuentaZelle: (id, cuentaId) =>
      rpc('admin_asignar_cuenta_zelle', { p_remesa_id: id, p_cuenta_zelle_id: cuentaId }),
    crearRemesaManual: (d) => rpc('admin_crear_remesa_manual', {
      p_cliente_nombre: d.clienteNombre, p_cliente_whatsapp: d.clienteWhatsapp,
      p_benef_nombre: d.familiarNombre, p_benef_direccion: d.familiarDireccion, p_monto: d.monto,
      p_benef_telefono: d.familiarTelefono ?? null, p_benef_municipio: d.familiarMunicipio ?? null,
      p_benef_provincia: d.familiarProvincia ?? null, p_codigo_gestor: d.codigoGestor ?? null,
      p_cuenta_zelle_id: d.cuentaZelleId ?? null, p_cliente_id: d.clienteId ?? null, p_nota: d.nota ?? null,
    }),
    pagarComisiones: (gestorId, remesaIds = null) =>
      rpc('admin_pagar_comisiones', { p_gestor_id: gestorId, p_remesa_ids: remesaIds }),

    // Archivos
    urlArchivo: async (bucket, path) => (await correr(sb.storage.from(bucket).createSignedUrl(path, 3600))).signedUrl,

    // Catálogos
    clientes: () => correr(sb.from('perfiles').select('*').eq('rol', 'cliente').order('creado_at', { ascending: false })),
    asignarGestorACliente: (clienteId, gestorId) =>
      correr(sb.from('perfiles').update({ gestor_id: gestorId }).eq('id', clienteId)),
    gestores: () => correr(sb.from('gestores').select('*').order('nombre')),
    guardarGestor: (g) => {
      const fila = { codigo: g.codigo?.trim().toUpperCase(), nombre: g.nombre, whatsapp: g.whatsapp || null,
                     activo: g.activo ?? true, notas: g.notas || null };
      return g.id ? correr(sb.from('gestores').update(fila).eq('id', g.id).select().single())
                  : correr(sb.from('gestores').insert(fila).select().single());
    },
    cuentasZelle: () => correr(sb.from('cuentas_zelle').select('*').order('titular')),
    guardarCuentaZelle: (c) => {
      const fila = { titular: c.titular, contacto_zelle: c.contactoZelle, whatsapp: c.whatsapp || null,
                     activa: c.activa ?? true, notas: c.notas || null };
      return c.id ? correr(sb.from('cuentas_zelle').update(fila).eq('id', c.id).select().single())
                  : correr(sb.from('cuentas_zelle').insert(fila).select().single());
    },
    configuracion: () => correr(sb.from('configuracion').select('*').order('clave')),
    guardarConfig: (clave, valor) =>
      correr(sb.from('configuracion').update({ valor: String(valor), actualizado_at: new Date().toISOString() }).eq('clave', clave)),
    plantillas: () => correr(sb.from('plantillas_whatsapp').select('*').order('destinatario').order('orden')),
    guardarPlantilla: (p) => correr(sb.from('plantillas_whatsapp').upsert(p).select().single()),
    mensajesEnviados: (remesaId = null) => {
      let q = sb.from('mensajes_whatsapp').select('*').order('creado_at', { ascending: false }).limit(200);
      if (remesaId) q = q.eq('remesa_id', remesaId);
      return correr(q);
    },

    // WhatsApp ---------------------------------------------------------
    /**
     * Arma el mensaje desde una plantilla. contexto = { remesaId, gestorId, cuentaZelleId, clienteId }
     * Devuelve { telefono, texto, destinatario, enlace, aviso, ... }
     */
    prepararWhatsApp: async (plantilla, contexto = {}) => {
      const m = await rpc('admin_preparar_whatsapp', {
        p_plantilla: plantilla, p_remesa_id: contexto.remesaId ?? null, p_gestor_id: contexto.gestorId ?? null,
        p_cuenta_zelle_id: contexto.cuentaZelleId ?? null, p_cliente_id: contexto.clienteId ?? null,
      });
      return { ...m, enlace: m.telefono ? enlaceWhatsApp(m.telefono, m.texto) : null };
    },

    /**
     * Abre WhatsApp y deja el envío anotado. El texto puede venir editado a mano.
     * Abrir la pestaña ANTES del await, si no el navegador del celular la bloquea.
     */
    enviarWhatsApp: async (m, abrir = (url) => window.open(url, '_blank')) => {
      const url = enlaceWhatsApp(m.telefono, m.texto);
      abrir(url);
      await rpc('admin_registrar_whatsapp', {
        p_destinatario: m.destinatario ?? 'otro', p_telefono: m.telefono, p_texto: m.texto,
        p_remesa_id: m.remesa_id ?? null, p_plantilla: m.plantilla ?? null, p_cliente_id: m.cliente_id ?? null,
        p_gestor_id: m.gestor_id ?? null, p_cuenta_zelle_id: m.cuenta_zelle_id ?? null,
      });
      return url;
    },
  };
  return api;
}
