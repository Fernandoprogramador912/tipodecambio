-- Tabla para análisis diario de escenario TC (OpenAI).
-- Ejecutar en Supabase SQL Editor una sola vez.

create table if not exists public.tc_day_outlook (
  session_date date primary key,
  analysis jsonb not null default '{}'::jsonb,
  generated_at timestamptz not null default now()
);

create index if not exists tc_day_outlook_generated_idx
  on public.tc_day_outlook (generated_at desc);

alter table public.tc_day_outlook enable row level security;
