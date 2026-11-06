-- =====================================================================
-- Remesa.cu · 001 · Esquema (tablas, tipos, índices)
-- Correr en Supabase → SQL Editor, en orden: 001, 002, 003, 004, 005.
-- (o pegar de una vez supabase/instalar_todo.sql)
--
-- Actores del negocio:
--   A = cliente que paga por Zelle desde el extranjero
--   B = dueño del negocio (admin), entrega el efectivo en Cuba
--   C = titular de una cuenta Zelle en USA que recibe los depósitos
--   D = gestor / agente de ventas que trae clientes y cobra comisión
-- Todo el dinero está en USD.
-- =====================================================================

create type estado_remesa as enum (
  'esperando_zelle',     -- creada; A debe depositar
  'zelle_confirmado',    -- C confirmó que el dinero llegó
  'entrega_programada',  -- B fijó fecha de entrega
  'entregada',           -- B entregó el efectivo y tiene el recibo
  'cancelada'
);

create type destinatario_wa as enum ('cliente', 'zelle', 'gestor', 'beneficiario', 'otro');

create type franja_entrega as enum ('manana', 'tarde', 'todo_el_dia');

-- ---------------------------------------------------------------------
-- Parámetros del negocio editables sin tocar código
-- ---------------------------------------------------------------------
create table configuracion (
  clave          text primary key,
  valor          text not null,
  descripcion    text,
  publica        boolean not null default false,  -- la PWA del cliente puede leerla
  actualizado_at timestamptz not null default now()
);

-- ---------------------------------------------------------------------
-- D · Gestores (agentes de ventas)
-- ---------------------------------------------------------------------
create table gestores (
  id        bigint generated always as identity primary key,
  codigo    text not null unique check (codigo ~ '^[A-Z0-9-]{3,20}$'),
  nombre    text not null check (length(trim(nombre)) >= 2),
  whatsapp  text,
  activo    boolean not null default true,
  notas     text,
  creado_at timestamptz not null default now()
);

-- ---------------------------------------------------------------------
-- C · Cuentas Zelle que reciben los depósitos
-- ---------------------------------------------------------------------
create table cuentas_zelle (
  id                   bigint generated always as identity primary key,
  titular              text not null check (length(trim(titular)) >= 2),
  contacto_zelle       text not null,          -- correo o teléfono registrado en Zelle
  whatsapp             text,                   -- para avisarle a C
  activa               boolean not null default true,
  ultima_asignacion_at timestamptz,            -- para repartir las remesas por turnos
  notas                text,
  creado_at            timestamptz not null default now()
);

-- ---------------------------------------------------------------------
-- A · Perfil de cada usuario con cuenta (1 a 1 con auth.users)
-- El admin (B) es un usuario más con rol = 'admin'.
-- ---------------------------------------------------------------------
create table perfiles (
  id        uuid primary key references auth.users(id) on delete cascade,
  nombre    text not null default '',
  whatsapp  text,
  pais      text,
  correo    text,
  rol       text not null default 'cliente' check (rol in ('cliente', 'admin')),
  gestor_id bigint references gestores(id) on delete set null,  -- el gestor que lo trajo
  creado_at timestamptz not null default now()
);
create index perfiles_gestor_idx on perfiles(gestor_id);

-- ---------------------------------------------------------------------
-- Familiares en Cuba que reciben (libreta de cada cliente)
-- ---------------------------------------------------------------------
create table beneficiarios (
  id         bigint generated always as identity primary key,
  cliente_id uuid not null references perfiles(id) on delete cascade,
  nombre     text not null check (length(trim(nombre)) between 2 and 120),
  telefono   text,
  direccion  text not null check (length(trim(direccion)) between 5 and 300),
  municipio  text,
  provincia  text,
  referencia text,                               -- "casa azul al lado de la bodega"
  activo     boolean not null default true,
  creado_at  timestamptz not null default now()
);
create index beneficiarios_cliente_idx on beneficiarios(cliente_id);

-- ---------------------------------------------------------------------
-- Remesas. Los datos de cliente, beneficiario y cuenta Zelle se COPIAN
-- al crear, para que el historial no cambie si luego se editan.
-- ---------------------------------------------------------------------
create sequence remesa_numero_seq;

create table remesas (
  id                      bigint generated always as identity primary key,
  codigo                  text not null unique,           -- REM-0001 (va en el memo del Zelle)

  -- A · cliente (con cuenta o creado a mano por el admin)
  cliente_id              uuid references perfiles(id) on delete set null,
  cliente_nombre          text not null,
  cliente_whatsapp        text,

  -- quién recibe en Cuba
  beneficiario_id         bigint references beneficiarios(id) on delete set null,
  beneficiario_nombre     text not null,
  beneficiario_telefono   text,
  beneficiario_direccion  text not null,
  beneficiario_municipio  text,
  beneficiario_provincia  text,

  -- dinero (USD)
  monto_entrega           numeric(10,2) not null check (monto_entrega > 0),
  tarifa                  numeric(10,2) not null check (tarifa >= 0),
  total_zelle             numeric(10,2) generated always as (monto_entrega + tarifa) stored,
  gestor_id               bigint references gestores(id) on delete set null,
  comision_pct            numeric(5,2)  not null default 0,
  comision_gestor         numeric(10,2) not null default 0 check (comision_gestor >= 0),
  ganancia_neta           numeric(10,2) generated always as (tarifa - comision_gestor) stored,

  -- C · cuenta Zelle asignada
  cuenta_zelle_id         bigint references cuentas_zelle(id) on delete set null,
  zelle_titular           text,
  zelle_contacto          text,

  -- ciclo de vida
  estado                  estado_remesa not null default 'esperando_zelle',
  cliente_reporto_pago_at timestamptz,
  comprobante_pago_path   text,          -- captura del Zelle que sube el cliente (bucket comprobantes)
  zelle_monto_recibido    numeric(10,2),
  zelle_confirmado_at     timestamptz,
  fecha_entrega           date,
  franja                  franja_entrega,
  entregada_at            timestamptz,
  recibo_path             text,          -- foto del recibo firmado (bucket recibos)
  nota_entrega            text,
  comision_pagada_at      timestamptz,   -- B le dio el efectivo a D
  cancelada_at            timestamptz,
  motivo_cancelacion      text,

  nota_cliente            text,
  notas_admin             text,
  creado_at               timestamptz not null default now(),
  actualizado_at          timestamptz not null default now()
);
create index remesas_cliente_idx on remesas(cliente_id, creado_at desc);
create index remesas_estado_idx  on remesas(estado);
create index remesas_gestor_idx  on remesas(gestor_id) where gestor_id is not null;
create index remesas_creado_idx  on remesas(creado_at desc);
create index remesas_entrega_idx on remesas(fecha_entrega) where estado = 'entrega_programada';

-- ---------------------------------------------------------------------
-- Historial de cada remesa
-- ---------------------------------------------------------------------
create table remesa_eventos (
  id              bigint generated always as identity primary key,
  remesa_id       bigint not null references remesas(id) on delete cascade,
  tipo            text not null,                 -- creada, pago_reportado, zelle_confirmado, ...
  detalle         jsonb not null default '{}'::jsonb,
  actor           uuid,                          -- auth.uid() de quien lo hizo
  visible_cliente boolean not null default true,
  creado_at       timestamptz not null default now()
);
create index remesa_eventos_remesa_idx on remesa_eventos(remesa_id, creado_at);

-- ---------------------------------------------------------------------
-- WhatsApp: plantillas editables y registro de lo enviado
-- ---------------------------------------------------------------------
create table plantillas_whatsapp (
  clave        text primary key,
  destinatario destinatario_wa not null,
  titulo       text not null,
  texto        text not null,      -- con marcadores {cliente}, {total}, {codigo}, ...
  orden        int not null default 0,
  activa       boolean not null default true
);

create table mensajes_whatsapp (
  id              bigint generated always as identity primary key,
  remesa_id       bigint references remesas(id) on delete set null,
  destinatario    destinatario_wa not null,
  cliente_id      uuid references perfiles(id) on delete set null,
  gestor_id       bigint references gestores(id) on delete set null,
  cuenta_zelle_id bigint references cuentas_zelle(id) on delete set null,
  telefono        text not null,
  plantilla_clave text,
  texto           text not null,
  enviado_por     uuid,
  creado_at       timestamptz not null default now()
);
create index mensajes_whatsapp_remesa_idx on mensajes_whatsapp(remesa_id);
create index mensajes_whatsapp_creado_idx on mensajes_whatsapp(creado_at desc);
