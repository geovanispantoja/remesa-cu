// Servidor local que imita Supabase para probar las webs sin tocar el proyecto real.
//   /rest/v1/*     → PostgREST real (puerto 3001) contra el Postgres local
//   /auth/v1/*     → inicio de sesión falso con usuarios fijos (firma JWT como Supabase)
//   /storage/v1/*  → archivos en disco, respetando las políticas RLS de storage.objects
//   todo lo demás  → archivos estáticos del repo (como GitHub Pages)
// Uso: node pruebas/navegador/servidor-dev.mjs   (requiere `npm i pg` en NODE_PATH)
import http from 'node:http';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import pg from 'pg';

const PUERTO = Number(process.env.PUERTO ?? 8080);
const RAIZ = path.resolve(new URL('../..', import.meta.url).pathname);
const ARCHIVOS = process.env.DIR_ARCHIVOS ?? '/tmp/remesa-storage';
const SECRETO = process.env.JWT_SECRET ?? 'secreto-de-prueba-de-al-menos-32-caracteres!!';
const POSTGREST = process.env.POSTGREST ?? 'http://127.0.0.1:3001';
const db = new pg.Pool({
  host: process.env.PGHOST ?? '/tmp', port: Number(process.env.PGPORT ?? 5544), user: process.env.PGUSER ?? 'postgres',
  password: process.env.PGPASSWORD, database: process.env.DB ?? 'remesa_dev',
});

// Usuarios de prueba: correo → contraseña (los ids salen de auth.users)
const CLAVES = { 'admin@remesa.cu': 'admin123', 'ana@correo.com': 'ana123', 'beto@correo.com': 'beto123' };

const b64 = (o) => Buffer.from(typeof o === 'string' ? o : JSON.stringify(o)).toString('base64url');
function firmar(claims) {
  const cab = b64({ alg: 'HS256', typ: 'JWT' });
  const cuerpo = b64(claims);
  const firma = crypto.createHmac('sha256', SECRETO).update(`${cab}.${cuerpo}`).digest('base64url');
  return `${cab}.${cuerpo}.${firma}`;
}
function leerJwt(token) {
  try {
    const [c, b, f] = token.split('.');
    const ok = crypto.createHmac('sha256', SECRETO).update(`${c}.${b}`).digest('base64url') === f;
    return ok ? JSON.parse(Buffer.from(b, 'base64url')) : null;
  } catch { return null; }
}
const ANON = firmar({ role: 'anon', iss: 'dev' });

function usuarioDe(req) {
  const t = (req.headers.authorization ?? '').replace(/^Bearer /, '');
  const c = leerJwt(t);
  return c?.role === 'authenticated' ? c : null;
}

async function sesionPara(email) {
  const { rows } = await db.query('select id, email, raw_user_meta_data from auth.users where email = $1', [email]);
  if (!rows[0]) return null;
  const u = rows[0];
  const exp = Math.floor(Date.now() / 1000) + 3600;
  const access_token = firmar({ sub: u.id, email: u.email, role: 'authenticated', aud: 'authenticated', exp });
  const user = { id: u.id, email: u.email, aud: 'authenticated', role: 'authenticated',
                 user_metadata: u.raw_user_meta_data ?? {}, app_metadata: {}, created_at: new Date().toISOString() };
  return { access_token, token_type: 'bearer', expires_in: 3600, expires_at: exp,
           refresh_token: b64({ email, n: crypto.randomUUID() }), user };
}

const cors = {
  'access-control-allow-origin': '*',
  'access-control-allow-headers': '*',
  'access-control-allow-methods': 'GET,POST,PATCH,PUT,DELETE,OPTIONS',
  'access-control-expose-headers': 'content-range, content-profile',
};
function json(res, status, cuerpo) {
  res.writeHead(status, { 'content-type': 'application/json', ...cors });
  res.end(JSON.stringify(cuerpo));
}
const leerCuerpo = (req) => new Promise((ok) => { const p = []; req.on('data', (d) => p.push(d)); req.on('end', () => ok(Buffer.concat(p))); });

// Ejecuta SQL como el usuario de la petición, para que apliquen las políticas RLS
async function comoUsuario(claims, sql, params) {
  const c = await db.connect();
  try {
    await c.query('begin');
    await c.query(`set local role ${claims ? 'authenticated' : 'anon'}`);
    await c.query(`select set_config('request.jwt.claims', $1, true)`, [JSON.stringify(claims ?? {})]);
    const r = await c.query(sql, params);
    await c.query('commit');
    return r;
  } catch (e) { await c.query('rollback'); throw e; } finally { c.release(); }
}

const TIPOS = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.mjs': 'text/javascript', '.css': 'text/css',
                '.json': 'application/json', '.svg': 'image/svg+xml', '.png': 'image/png', '.webmanifest': 'application/manifest+json',
                '.jpg': 'image/jpeg', '.ico': 'image/x-icon' };

http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://x');
  try {
    if (req.method === 'OPTIONS') { res.writeHead(204, cors); return res.end(); }

    // ---------------- auth
    if (url.pathname === '/auth/v1/token') {
      const cuerpo = JSON.parse((await leerCuerpo(req)).toString() || '{}');
      let email;
      if (url.searchParams.get('grant_type') === 'password') {
        if (CLAVES[cuerpo.email] !== cuerpo.password) {
          return json(res, 400, { error: 'invalid_grant', error_description: 'Invalid login credentials', code: 'invalid_credentials', msg: 'Invalid login credentials' });
        }
        email = cuerpo.email;
      } else {
        email = JSON.parse(Buffer.from(cuerpo.refresh_token ?? '', 'base64url').toString() || '{}').email;
      }
      const s = email && await sesionPara(email);
      return s ? json(res, 200, s) : json(res, 400, { error: 'invalid_grant', msg: 'Invalid Refresh Token' });
    }
    if (url.pathname === '/auth/v1/signup') {
      const cuerpo = JSON.parse((await leerCuerpo(req)).toString() || '{}');
      const email = String(cuerpo.email ?? '').toLowerCase();
      if (CLAVES[email]) return json(res, 422, { code: 'user_already_exists', msg: 'User already registered' });
      if (String(cuerpo.password ?? '').length < 6) return json(res, 422, { code: 'weak_password', msg: 'Password should be at least 6 characters.' });
      await db.query('insert into auth.users (email, raw_user_meta_data) values ($1, $2)', [email, cuerpo.data ?? {}]);
      CLAVES[email] = cuerpo.password;
      return json(res, 200, await sesionPara(email)); // como si "Confirm email" estuviera apagado
    }
    if (url.pathname === '/auth/v1/recover') return json(res, 200, {});
    if (url.pathname === '/auth/v1/user') {
      const u = usuarioDe(req);
      if (!u) return json(res, 401, { msg: 'invalid JWT' });
      if (req.method === 'PUT') {
        const cuerpo = JSON.parse((await leerCuerpo(req)).toString() || '{}');
        if (cuerpo.password) CLAVES[u.email] = cuerpo.password;
      }
      return json(res, 200, (await sesionPara(u.email)).user);
    }
    if (url.pathname === '/auth/v1/logout') { res.writeHead(204, cors); return res.end(); }

    // ---------------- storage
    const firmada = url.pathname.match(/^\/storage\/v1\/object\/sign\/([^/]+)\/(.+)$/);
    if (firmada) {
      const [, bucket, nombre] = firmada.map(decodeURIComponent);
      if (req.method === 'GET') {
        if (leerJwt(url.searchParams.get('token') ?? '')?.archivo !== `${bucket}/${nombre}`) return json(res, 400, { error: 'token' });
        const f = path.join(ARCHIVOS, bucket, nombre);
        res.writeHead(200, { 'content-type': fs.existsSync(f + '.tipo') ? fs.readFileSync(f + '.tipo', 'utf8') : 'image/jpeg', ...cors });
        return fs.createReadStream(f).pipe(res);
      }
      const r = await comoUsuario(usuarioDe(req), 'select 1 from storage.objects where bucket_id = $1 and name = $2', [bucket, nombre]);
      if (!r.rowCount) return json(res, 400, { statusCode: '404', error: 'not_found', message: 'Object not found' });
      const token = firmar({ archivo: `${bucket}/${nombre}`, exp: Math.floor(Date.now() / 1000) + 3600 });
      return json(res, 200, { signedURL: `/object/sign/${bucket}/${nombre}?token=${token}` });
    }
    const subir = url.pathname.match(/^\/storage\/v1\/object\/([^/]+)\/(.+)$/);
    if (subir && (req.method === 'POST' || req.method === 'PUT')) {
      const [, bucket, nombre] = subir.map(decodeURIComponent);
      const cuerpo = await leerCuerpo(req);
      try {
        await comoUsuario(usuarioDe(req), 'insert into storage.objects (bucket_id, name, owner) values ($1, $2, auth.uid())', [bucket, nombre]);
      } catch (e) {
        return json(res, 400, { statusCode: '403', error: 'Unauthorized', message: 'new row violates row-level security policy' });
      }
      const f = path.join(ARCHIVOS, bucket, nombre);
      fs.mkdirSync(path.dirname(f), { recursive: true });
      // supabase-js manda multipart cuando el cuerpo es un File/Blob del navegador
      let datos = cuerpo, tipo = req.headers['content-type'] ?? 'application/octet-stream';
      const borde = tipo.match(/boundary=(.+)$/)?.[1];
      if (borde) {
        for (const parte of cuerpo.toString('latin1').split(`--${borde}`)) {
          const corte = parte.indexOf('\r\n\r\n');
          const cab = parte.slice(0, corte);
          if (/filename=|name=""/.test(cab)) {
            tipo = cab.match(/Content-Type:\s*(\S+)/i)?.[1] ?? 'application/octet-stream';
            datos = Buffer.from(parte.slice(corte + 4, parte.length - 2), 'latin1');
          }
        }
      }
      fs.writeFileSync(f, datos);
      fs.writeFileSync(f + '.tipo', tipo);
      return json(res, 200, { Key: `${bucket}/${nombre}`, Id: crypto.randomUUID() });
    }

    // ---------------- PostgREST
    if (url.pathname.startsWith('/rest/v1/')) {
      const cabeceras = { ...req.headers };
      delete cabeceras.host;
      if (!leerJwt((cabeceras.authorization ?? '').replace(/^Bearer /, ''))) cabeceras.authorization = `Bearer ${ANON}`;
      const cuerpo = ['GET', 'HEAD'].includes(req.method) ? undefined : await leerCuerpo(req);
      const r = await fetch(POSTGREST + url.pathname.slice(8) + url.search, { method: req.method, headers: cabeceras, body: cuerpo });
      const h = Object.fromEntries([...r.headers].filter(([k]) => !['content-encoding', 'transfer-encoding', 'content-length'].includes(k)));
      res.writeHead(r.status, { ...h, ...cors });
      return res.end(Buffer.from(await r.arrayBuffer()));
    }

    // ---------------- estáticos
    let f = path.join(RAIZ, decodeURIComponent(url.pathname));
    if (!f.startsWith(RAIZ)) return json(res, 403, {});
    if (fs.existsSync(f) && fs.statSync(f).isDirectory()) f = path.join(f, 'index.html');
    if (!fs.existsSync(f)) { res.writeHead(404); return res.end('no existe'); }
    res.writeHead(200, { 'content-type': TIPOS[path.extname(f)] ?? 'application/octet-stream', 'cache-control': 'no-store' });
    fs.createReadStream(f).pipe(res);
  } catch (e) {
    console.error(e);
    json(res, 500, { message: String(e.message ?? e) });
  }
}).listen(PUERTO, () => console.log(`dev en http://localhost:${PUERTO}`));
