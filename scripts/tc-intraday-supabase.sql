-- Tabla para historial intradiario USD/ARS (rueda 10:00–15:00 ART).
-- Ejecutar en Supabase SQL Editor una sola vez.

create table if not exists public.tc_intraday_days (
  session_date date primary key,
  points jsonb not null default '[]'::jsonb,
  point_count integer not null default 0,
  updated_at timestamptz not null default now()
);

create index if not exists tc_intraday_days_updated_idx
  on public.tc_intraday_days (updated_at desc);

alter table public.tc_intraday_days enable row level security;
