// =====================================================================
// Remesa.cu · datos de conexión (los usan la web de admin y la PWA)
// Llena los dos primeros con los de tu proyecto de Supabase:
//   supabaseUrl  → https://<id-del-proyecto>.supabase.co
//   supabaseKey  → Project Settings → API Keys → la "publishable" (sb_publishable_…)
// La publishable key es pública: puede estar aquí y en GitHub sin problema.
// NUNCA pongas aquí la secret key (sb_secret_…).
// =====================================================================

const produccion = {
  supabaseUrl: 'https://cxckyqyrpyfegwcfmdaf.supabase.co',
  supabaseKey: 'sb_publishable_jDdUS4XwX9_aPnd8ZjnubQ_SmJIQu2K',
  // Correo del usuario admin creado en Supabase → Authentication → Users.
  // La web de admin solo pide la contraseña de este usuario.
  correoAdmin: 'cuba.ages@gmail.com',
};

// Al abrir la web en tu propia computadora (pruebas/navegador/preparar.sh) usa el Supabase de prueba local.
const local = {
  supabaseUrl: 'http://localhost:8080',
  supabaseKey: 'sb_publishable_demo',
  correoAdmin: 'admin@remesa.cu',
};

const enLocal = ['localhost', '127.0.0.1'].includes(globalThis.location?.hostname);
export const CONFIG = enLocal ? local : produccion;
export const CONFIG_LISTA = Boolean(CONFIG.supabaseUrl && CONFIG.supabaseKey);
export const SUPABASE_JS = 'https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2.118.0/+esm';
