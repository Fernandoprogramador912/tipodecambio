-- Memoria diaria del TC (noticias de la mañana, resultado del día, recomendaciones ESPERAR/CERRAR).
-- Ejecutar en Supabase SQL Editor una sola vez. Sin esta tabla, el servidor usa data/tc-day-memory.json.

create table if not exists public.tc_day_memory (
  session_date date primary key,
  data jsonb not null default '{}'::jsonb,
  updated_at timestamptz not null default now()
);

create index if not exists tc_day_memory_updated_idx
  on public.tc_day_memory (updated_at desc);

alter table public.tc_day_memory enable row level security;
