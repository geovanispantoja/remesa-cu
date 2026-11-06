// Service worker de la PWA del cliente: guarda la app para que abra rápido y sin señal.
// Los datos (Supabase) siempre van por la red. Sube VERSION cuando cambies la lista de archivos.
const VERSION = 'remesa-cliente-v1';
const BASE = [
  './', 'index.html', 'app.js', 'estilos.css', 'manifest.webmanifest', 'icono.svg', 'icono-192.png', 'icono-512.png',
  '../compartido/config.js', '../compartido/remesa-api.js',
];
const CDN = 'https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2.118.0/+esm';

self.addEventListener('install', (e) => {
  e.waitUntil((async () => {
    const c = await caches.open(VERSION);
    await c.addAll(BASE);
    try { await c.add(CDN); } catch { /* sin red al instalar: se guarda en el primer uso */ }
    self.skipWaiting();
  })());
});

self.addEventListener('activate', (e) => {
  e.waitUntil((async () => {
    for (const k of await caches.keys()) if (k !== VERSION) await caches.delete(k);
    await self.clients.claim();
  })());
});

self.addEventListener('fetch', (e) => {
  const req = e.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);
  if (/\/(rest|auth|storage|realtime|functions)\/v1\//.test(url.pathname)) return; // datos: siempre red

  const fijo = url.origin !== self.location.origin; // CDN y fuentes: el nombre ya lleva versión
  e.respondWith((async () => {
    const c = await caches.open(VERSION);
    if (fijo) {
      const guardado = await c.match(req);
      if (guardado) return guardado;
      const r = await fetch(req);
      if (r.ok || r.type === 'opaque') c.put(req, r.clone());
      return r;
    }
    // Archivos propios: primero la red (para recibir actualizaciones), si no hay red, lo guardado
    try {
      const r = await fetch(req);
      if (r.ok) c.put(req, r.clone());
      return r;
    } catch {
      return (await c.match(req, { ignoreSearch: true })) ?? (await c.match('index.html'));
    }
  })());
});
