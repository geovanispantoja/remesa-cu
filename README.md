# Remesa.cu

Remesas de dólares a Cuba: el cliente (A) paga por **Zelle** desde fuera, una cuenta en EE.UU. (C) recibe el dinero, y el dueño (B) entrega **USD en efectivo** al familiar en Cuba. Los gestores (D) que traen clientes se llevan la mitad de la tarifa.

```
remesa-cu/
├── supabase/
│   ├── migraciones/          001…005, en orden (esquema, lógica, seguridad, archivos, datos)
│   ├── instalar_todo.sql     las 5 juntas, para pegar de una vez
│   └── limpiar_pruebas.sql   borra remesas de prueba
├── compartido/remesa-api.js  funciones JS que usan la PWA y la web de admin
├── pruebas/                  pruebas del backend en Postgres local
├── cliente/                  (próximo) PWA del cliente
└── admin/                    (próximo) web de admin
```

Todo es gratis: **GitHub Pages** sirve las dos webs (`/cliente/` y `/admin/`) y **Supabase** (plan gratis) pone la base de datos, el inicio de sesión y las fotos. No hay servidor propio que mantener.

---

## Cómo funciona el dinero

| | Fórmula | Ejemplo con 350 |
|---|---|---|
| Tarifa | $10 por cada $100 **o fracción** | $40 |
| A deposita por Zelle | monto + tarifa | **$390** |
| Comisión de D (si el cliente vino por un gestor) | 50% de la tarifa | $20 |
| Ganancia de B | tarifa − comisión | $20 |

Todo se cambia en la tabla `configuracion`, sin tocar código: `tarifa_bloque` (100), `tarifa_por_bloque` (10), `tarifa_minima` (10), `monto_minimo` (50), `monto_maximo` (3000), `monto_multiplo` (10), `comision_gestor_pct` (50).

## Estados de una remesa

```
esperando_zelle ──► zelle_confirmado ──► entrega_programada ──► entregada
       │                   │                     │
       └───────────────────┴─────────────────────┴──► cancelada
```

| Quién | Qué hace | Función |
|---|---|---|
| A | Pide la remesa (elige familiar y monto, código de gestor opcional) | `crear_remesa` |
| A | "Ya deposité" con captura opcional | `reportar_pago` |
| A | Cancela, solo si todavía no avisó que pagó | `cancelar_mi_remesa` |
| B | C avisó que llegó el dinero | `admin_confirmar_zelle` |
| B | Pone el día de entrega (y lo puede cambiar) | `admin_programar_entrega` |
| B | Entregó, con foto del recibo firmado | `admin_marcar_entregada` |
| B | Le dio el efectivo a D | `admin_pagar_comisiones` |

Otras funciones del admin: `admin_cancelar`, `admin_corregir_estado` (para errores), `admin_ajustar_monto`, `admin_asignar_gestor`, `admin_asignar_cuenta_zelle`, `admin_crear_remesa_manual` (para clientes que solo escriben por WhatsApp), `admin_resumen`, `admin_resumen_gestores`, `admin_resumen_cuentas_zelle`.

**Detalles que ya resuelve la base de datos:**
- Las cuentas Zelle se reparten **por turnos** entre las activas. A ve en su app a cuál depositar.
- El código de la remesa (`REM-0001`) va en el memo del Zelle para que C lo identifique.
- El primer código de gestor que pone un cliente queda fijo en su perfil: sus remesas siguientes también le dan comisión a ese gestor.
- Si llega menos dinero del esperado no se confirma, salvo que B lo fuerce. Si llega de más, se anota la diferencia.
- Un cliente no puede tener más de 3 remesas esperando Zelle a la vez (`max_remesas_esperando`).
- Cada paso queda en el historial (`remesa_eventos`). El cliente ve el suyo, pero no las comisiones ni las notas internas.

## WhatsApp

La web de admin abre `https://wa.me/<número>?text=<mensaje>`: se abre el chat con el texto ya escrito, B lo revisa y pulsa enviar. Es gratis y no necesita la API de WhatsApp Business.

1. `admin_preparar_whatsapp('cliente_datos_zelle', remesa_id)` arma el texto con los datos reales y busca el número correcto (A, C, D o el familiar).
2. B puede editar el texto.
3. `enviarWhatsApp(...)` en `remesa-api.js` abre WhatsApp y lo deja anotado en `mensajes_whatsapp`.

Plantillas que vienen de fábrica (todas editables en `plantillas_whatsapp`):

| Para | Plantillas |
|---|---|
| A · cliente | datos del Zelle · recordatorio de pago · Zelle recibido · fecha de entrega · entregada |
| C · cuenta Zelle | aviso de depósito · pedir confirmación · lista de pendientes |
| D · gestor | comisión lista · resumen del mes · cliente nuevo |
| Familiar en Cuba | aviso de entrega |

Marcadores que se pueden usar: `{codigo} {cliente} {beneficiario} {direccion} {monto} {tarifa} {total} {zelle_recibido} {zelle_titular} {zelle_contacto} {fecha_entrega} {franja} {comision} {gestor} {cuenta} {negocio} {enlace_app} {whatsapp_negocio}`. Solo para gestor: `{mes_remesas} {mes_comision} {pendiente}`. Solo para cuenta Zelle: `{pendientes_n} {pendientes_total} {lista_pendientes}`.

**Números:** se guardan solo con dígitos y código de país (`13055551234`, `5355551234`). Si se escriben sin `+`, 8 dígitos que empiezan en 5 se toman como móvil cubano y 10 dígitos como EE.UU. Para otros países (México, España…) hay que escribir el `+` y el código.

## Seguridad

- **Sin sesión** solo se puede cotizar, leer la configuración pública y validar un código de gestor.
- **El cliente** ve solo su perfil, sus familiares y sus remesas, y nunca ve comisiones ni notas del admin. No puede cambiarse el rol ni el gestor.
- **El admin** ve todo, pero los estados y el dinero solo se cambian con las funciones `admin_*`. Editando la tabla directo solo se pueden cambiar las notas.
- Fotos: `comprobantes/<uid del cliente>/…` (capturas del Zelle) y `recibos/<id remesa>/…` (recibos firmados). Las dos carpetas son privadas y cada cliente ve solo lo suyo.
- La clave `anon` de Supabase va dentro de las webs. Es pública por diseño: lo que protege los datos son estas reglas.

---

## Instalación (una sola vez)

### 1. Crear el proyecto en Supabase
1. En [supabase.com](https://supabase.com) → **New project** (plan Free). Para la región, la más cercana a la mayoría de clientes (East US).
2. **SQL Editor** → **New query** → pega todo `supabase/instalar_todo.sql` → **Run**. Debe terminar en "Success".

### 2. Crear el usuario admin (B)
1. **Authentication → Users → Add user → Create new user**. Pon un correo (ej. `admin@remesa.cu`, no tiene que existir), una contraseña fuerte y marca **Auto Confirm User**.
2. En el **SQL Editor**:
   ```sql
   update perfiles set rol = 'admin', nombre = 'Geo' where correo = 'admin@remesa.cu';
   ```
   La web de admin solo pedirá la contraseña: el correo va fijo en su código.

### 3. Ajustes de inicio de sesión
- **Authentication → URL Configuration**:
  - *Site URL*: `https://geovanispantoja.github.io/remesa-cu/cliente/`
  - *Redirect URLs*: esa misma URL con `**` al final.
- **Correo de confirmación:** el correo gratis de Supabase deja mandar muy pocos por hora. Para unos 100 clientes al mes hay dos caminos:
  - **Authentication → Providers → Email → desactivar "Confirm email"**. Los clientes entran al instante, pero no se verifica que el correo sea suyo.
  - O poner un SMTP gratis (Brevo, o Gmail con contraseña de aplicación) en **Authentication → Emails → SMTP Settings**.

### 4. Datos del negocio
Carga tus cuentas Zelle y gestores, y pon tu WhatsApp (en el SQL Editor, o luego desde la web de admin):
```sql
insert into cuentas_zelle (titular, contacto_zelle, whatsapp) values
  ('[Nombre titular]', '[correo o teléfono de Zelle]', '+1 [whatsapp de C]');
insert into gestores (codigo, nombre, whatsapp) values
  ('GES-001', '[Nombre del gestor]', '+53 [whatsapp de D]');
update configuracion set valor = '53[tu número]' where clave = 'whatsapp_negocio';
update configuracion set valor = 'https://geovanispantoja.github.io/remesa-cu/cliente/' where clave = 'url_app';
```

### 5. Que Supabase no se duerma
El plan gratis pausa el proyecto si pasa una semana sin uso. En GitHub → **Settings → Secrets and variables → Actions** agrega `SUPABASE_URL` y `SUPABASE_ANON_KEY` (están en Supabase → **Project Settings → API**). Con eso, el workflow `mantener-activo.yml` le hace una consulta cada 3 días.

### Para probar desde cero
`supabase/limpiar_pruebas.sql` borra remesas, historial, mensajes y fotos, y reinicia los códigos en REM-0001. Conserva configuración, plantillas, gestores, cuentas y clientes.

---

## Cambios futuros en la base de datos
- Cada cambio nuevo va en un archivo `supabase/migraciones/006_….sql`, se pega en el SQL Editor y luego se corre `./supabase/armar_instalar_todo.sh`.
- Las funciones nuevas **no** quedan abiertas a nadie por defecto. Hay que darles `grant execute … to authenticated` (o `anon`) a propósito, como en `003_seguridad.sql`.

## Pruebas
```bash
# Base de datos (Postgres local; imita lo mínimo de Supabase)
PGHOST=/tmp PGPORT=5544 PGUSER=postgres ./pruebas/correr.sh
# Cliente JS
npm test
```
GitHub Actions corre las dos en cada push (`.github/workflows/pruebas.yml`). Las pruebas recorren el ciclo completo de una remesa y comprueban que un cliente no pueda ver ni tocar lo de otro, ni actuar como admin.
